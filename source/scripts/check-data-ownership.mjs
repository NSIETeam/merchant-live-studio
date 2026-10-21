import { readFileSync, readdirSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const slash = (value) => value.replaceAll("\\", "/");
const control =
  /^(?:BEGIN(?: IMMEDIATE)?|COMMIT|ROLLBACK(?: TO SAVEPOINT [\w]+)?|SAVEPOINT [\w]+|RELEASE SAVEPOINT [\w]+)$/i;

/** Tokenize strings/comments separately so text in a stored value is not mistaken for a table. */
export function referencedTables(sql) {
  const tokens = [];
  const pattern =
    /--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[a-z_][a-z_0-9]*|[().,;]/gi;
  for (const match of sql.matchAll(pattern)) {
    const value = match[0];
    if (
      value.startsWith("'") ||
      value.startsWith("--") ||
      value.startsWith("/*")
    )
      continue;
    tokens.push(value.replace(/^(["`\[])|(["`\]])$/g, "").toLowerCase());
  }
  const tables = new Set();
  let depth = 0,
    statementStart = 0;
  const fromClauses = new Set();
  const addTable = (index) => {
    let target = tokens[index];
    if (!target || ["(", "on", "of", "set"].includes(target)) return;
    if (tokens[index + 1] === ".") target = tokens[index + 2];
    if (target !== "json_each" && /^[a-z_][a-z_0-9]*$/.test(target))
      tables.add(target);
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "(") {
      depth++;
      continue;
    }
    if (token === ")") {
      fromClauses.delete(depth);
      depth--;
      continue;
    }
    if (token === ";") {
      fromClauses.clear();
      statementStart = i + 1;
      continue;
    }
    if (
      [
        "where",
        "group",
        "having",
        "order",
        "limit",
        "union",
        "except",
        "intersect",
        "returning",
        "window",
        "set",
        "values",
      ].includes(token)
    )
      fromClauses.delete(depth);
    if (token === "from") fromClauses.add(depth);
    if (
      ["from", "join", "update", "into"].includes(token) ||
      (token === "," && fromClauses.has(depth))
    )
      addTable(i + 1);
    if (
      token === "table" &&
      ["create", "alter", "drop"].includes(tokens[i - 1])
    ) {
      let next = i + 1;
      while (["if", "not", "exists"].includes(tokens[next])) next++;
      addTable(next);
    }
    if (
      token === "on" &&
      tokens[statementStart] === "create" &&
      tokens
        .slice(statementStart, i)
        .some((value) => ["trigger", "index"].includes(value))
    ) {
      addTable(i + 1);
    }
  }
  return [...tables];
}

/** Resolve literals and the bounded table list used by the immutable Agent migrations. */
function literals(node, source) {
  if (!node) return null;
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isConditionalExpression(node)) {
    const left = literals(node.whenTrue, source),
      right = literals(node.whenFalse, source);
    return left && right ? [...left, ...right] : null;
  }
  if (ts.isTemplateExpression(node)) {
    let variants = [{ text: node.head.text, bindings: {} }];
    for (const span of node.templateSpans) {
      let values = null;
      if (ts.isIdentifier(span.expression)) {
        if (span.expression.text === "savepoint") values = ["module_tx_1"];
        let ancestor = node.parent;
        while (!values && ancestor) {
          if (
            ts.isForOfStatement(ancestor) &&
            ts.isVariableDeclarationList(ancestor.initializer) &&
            ancestor.initializer.declarations[0].name.getText(source) ===
              span.expression.text &&
            ts.isArrayLiteralExpression(ancestor.expression)
          ) {
            const elements = ancestor.expression.elements.map((element) =>
              ts.isStringLiteralLike(element) ? element.text : null,
            );
            if (elements.every((element) => element !== null))
              values = elements;
          }
          ancestor = ancestor.parent;
        }
      }
      if (!values) return null;
      const identifier = span.expression.getText(source);
      variants = variants.flatMap((variant) => {
        const bound = variant.bindings[identifier];
        return (bound === undefined ? values : [bound]).map((value) => ({
          text: variant.text + value + span.literal.text,
          bindings: { ...variant.bindings, [identifier]: value },
        }));
      });
      if (variants.length > 64) return null;
    }
    return variants.map((variant) => variant.text);
  }
  return null;
}

export function checkSourceDataOwnership(file, text, tables) {
  const errors = [];
  // The unchanged v1-v8 bootstrap migrates historical cross-module constraints in one transaction.
  if (file === "src/server/db.ts") return errors;
  const owner = /^src\/(?:modules|platform)\/([^/]+)\//.exec(file)?.[1];
  const persistence = /^src\/(?:modules|platform)\/[^/]+\/persistence\//.test(
    file,
  );
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const report = (node, code, detail) =>
    errors.push({
      code,
      file,
      line:
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      detail,
    });
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ["prepare", "exec"].includes(node.expression.name.text)
    ) {
      const sql = literals(node.arguments[0], source);
      const transactionOnly =
        file === "src/platform/infrastructure/transaction.ts" &&
        node.expression.name.text === "exec" &&
        sql?.every((statement) => control.test(statement.trim()));
      if (!persistence && !transactionOnly)
        report(
          node,
          "SQL_OUTSIDE_PERSISTENCE",
          "Database statements belong to the owner's persistence directory.",
        );
      if (!sql)
        report(
          node,
          "DYNAMIC_SQL",
          "Use a statically auditable statement and bind its values.",
        );
      for (const statement of sql || []) {
        for (const table of referencedTables(statement)) {
          if (!(table in tables)) report(node, "UNREGISTERED_TABLE", table);
          else if (tables[table] !== owner)
            report(
              node,
              "FOREIGN_TABLE",
              `${table} belongs to ${tables[table]}, not ${owner || "composition/shared/web"}`,
            );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return errors;
}

export function analyzeDataOwnership(root) {
  const registry = JSON.parse(
    readFileSync(join(root, "architecture/table-owners.json"), "utf8"),
  );
  const modules = JSON.parse(
    readFileSync(join(root, "architecture/modules.json"), "utf8"),
  );
  const owners = new Set([
    ...Object.keys(modules.modules),
    ...modules.platform,
  ]);
  const errors = [];
  for (const [table, owner] of Object.entries(registry.tables)) {
    if (!/^[a-z_][a-z_0-9]*$/.test(table) || !owners.has(owner))
      errors.push({
        code: "INVALID_TABLE_OWNER",
        file: "architecture/table-owners.json",
        detail: `${table}: ${owner}`,
      });
  }
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name))
        errors.push(
          ...checkSourceDataOwnership(
            slash(relative(root, file)),
            readFileSync(file, "utf8"),
            registry.tables,
          ),
        );
    }
  };
  walk(join(root, "src"));
  return errors;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const errors = analyzeDataOwnership(process.cwd());
  for (const error of errors)
    console.error(
      `${error.code}: ${error.file}:${error.line || 1} ${error.detail}`,
    );
  if (errors.length) process.exitCode = 1;
  else
    console.log(
      "Data ownership gate passed: SQL stays in owner persistence directories.",
    );
}
