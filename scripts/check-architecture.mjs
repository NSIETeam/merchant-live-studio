import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModules } from "node:module";
import { execFileSync } from "node:child_process";
import ts from "typescript";

const slash = (value) => value.replaceAll("\\", "/");
const sourceExtension = /\.(?:[cm]?[jt]sx?)$/i;
const databaseDrivers =
  /^(?:node:sqlite|sqlite|sqlite3|better-sqlite3|pg|postgres|mysql2?|mssql)(?:\/|$)/;
const builtins = new Set(
  builtinModules.flatMap((name) => [name, `node:${name}`]),
);
const readJson = (root, path) =>
  JSON.parse(readFileSync(resolve(root, path), "utf8"));

/** Existing migration exceptions may shrink, but a normal change may not widen them. */
export function checkLegacyRatchet(previous, current) {
  const errors = [];
  for (const [file, entry] of Object.entries(current.legacy.files)) {
    if (!previous.legacy.files[file])
      errors.push(`New legacy file allowance: ${file}`);
    else if (entry.owner !== previous.legacy.files[file].owner)
      errors.push(`Changed legacy owner: ${file}`);
  }
  const allowed = new Set(
    previous.baseline.exceptions.map((exception) => exception.key),
  );
  for (const exception of current.baseline.exceptions) {
    if (!allowed.has(exception.key))
      errors.push(`New legacy import allowance: ${exception.key}`);
  }
  return errors;
}

function checkBaseRevision(root) {
  const revision = process.env.ARCHITECTURE_BASE_REF;
  if (!revision || /^0+$/.test(revision)) return;
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(revision))
    throw new Error("ARCHITECTURE_BASE_REF must be a full commit SHA");
  const paths = [
    "architecture/legacy-files.json",
    "architecture/legacy-imports.json",
  ];
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const present = git(["ls-tree", "--name-only", revision, "--", ...paths])
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  if (!present.length) {
    console.log(
      "Architecture legacy baseline introduced for the first time in this change.",
    );
    return;
  }
  if (present.length !== paths.length)
    throw new Error(
      "The base revision has an incomplete architecture baseline",
    );
  const previous = {
    legacy: JSON.parse(git(["show", `${revision}:${paths[0]}`])),
    baseline: JSON.parse(git(["show", `${revision}:${paths[1]}`])),
  };
  const current = {
    legacy: readJson(root, paths[0]),
    baseline: readJson(root, paths[1]),
  };
  const errors = checkLegacyRatchet(previous, current);
  if (errors.length)
    throw new Error(
      `Legacy baseline cannot expand relative to ${revision}:\n${errors.join("\n")}`,
    );
  console.log(
    `Architecture legacy baseline did not expand relative to ${revision}.`,
  );
}

function walk(root, directory, errors) {
  const result = [];
  if (!existsSync(directory)) return result;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) {
      errors.push({
        code: "SYMLINK",
        file: slash(relative(root, path)),
        detail: "Managed source must not contain symlinks.",
      });
    } else if (entry.isDirectory()) result.push(...walk(root, path, errors));
    else if (sourceExtension.test(path)) result.push(path);
  }
  return result.sort();
}

function imports(source) {
  const edges = [];
  const add = (node, expression, typeOnly, form, bindings = []) => {
    edges.push({
      node,
      specifier:
        expression && ts.isStringLiteralLike(expression)
          ? expression.text
          : null,
      typeOnly,
      form,
      bindings: bindings.sort(),
    });
  };
  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const elements = named && ts.isNamedImports(named) ? named.elements : [];
      const onlyTypes =
        !!clause?.isTypeOnly ||
        (!!elements.length &&
          !clause?.name &&
          elements.every((element) => element.isTypeOnly));
      const bindings = [
        ...(clause?.name ? [`default:${clause.name.text}`] : []),
        ...(named && ts.isNamespaceImport(named)
          ? [`*:${named.name.text}`]
          : []),
        ...elements.map(
          (element) =>
            `${element.isTypeOnly ? "type:" : ""}${element.propertyName?.text ?? element.name.text}:${element.name.text}`,
        ),
      ];
      add(node, node.moduleSpecifier, onlyTypes, "import", bindings);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const elements =
        node.exportClause && ts.isNamedExports(node.exportClause)
          ? node.exportClause.elements
          : [];
      add(
        node,
        node.moduleSpecifier,
        !!node.isTypeOnly ||
          (!!elements.length &&
            elements.every((element) => element.isTypeOnly)),
        "export",
        elements.map(
          (element) =>
            `${element.isTypeOnly ? "type:" : ""}${element.propertyName?.text ?? element.name.text}:${element.name.text}`,
        ),
      );
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(
        node,
        node.moduleReference.expression,
        !!node.isTypeOnly,
        "import-equals",
        [node.name.text],
      );
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument)
    ) {
      add(node, node.argument.literal, true, "import-type");
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
        add(node, node.arguments[0], false, "dynamic-import");
      else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require"
      )
        add(node, node.arguments[0], false, "require");
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return edges;
}

function classify(path, registry, legacy) {
  if (path.startsWith("src/shared/"))
    return { layer: "contracts", owner: "contracts" };
  const parts = path.split("/");
  if (parts[0] !== "src") return null;
  if (parts[1] === "modules" && registry.modules[parts[2]])
    return {
      layer: "module",
      owner: parts[2],
      public: path === `src/modules/${parts[2]}/public.ts`,
    };
  if (parts[1] === "platform" && registry.platform.includes(parts[2]))
    return {
      layer: "platform",
      owner: parts[2],
      public: path === `src/platform/${parts[2]}/public.ts`,
    };
  if (parts[1] === "composition")
    return { layer: "composition", owner: "composition" };
  if (
    parts[1] === "web" &&
    (legacy.files[path] ||
      registry.modules[parts[2]] ||
      ["shell", "shared"].includes(parts[2]))
  )
    return { layer: "web", owner: "web" };
  const entry = legacy.files[path];
  if (entry) return { layer: "legacy", owner: entry.owner, legacy: true };
  return null;
}

function violation(from, to, file, target, typeOnly) {
  if (!to) return "UNMANAGED_IMPORT";
  if (from.layer === "web")
    return ["web", "contracts"].includes(to.layer) ? null : "BROWSER_BACKEND";
  if (from.layer === "contracts")
    return to.layer === "contracts" ? null : "CONTRACT_BACK_EDGE";
  if (to.layer === "web") return "SERVER_BROWSER";
  if (to.layer === "contracts") return null;
  if (from.layer === "legacy" && to.layer === "legacy") {
    if (file.startsWith("src/agent/") !== target.startsWith("src/agent/"))
      return "AGENT_LIVE_IMPORT";
    return from.owner === to.owner ? null : "LEGACY_CROSS_MODULE";
  }
  if (to.layer === "legacy") return "NEW_LEGACY_IMPORT";
  if (
    from.layer === "composition" ||
    (from.layer === "legacy" && from.owner === "composition")
  ) {
    return to.layer === "composition" || to.public ? null : "PRIVATE_IMPORT";
  }
  if (to.layer === "composition") return "COMPOSITION_BACK_EDGE";
  if (from.layer === to.layer && from.owner === to.owner) return null;
  if (
    from.layer === "legacy" &&
    to.layer === "module" &&
    from.owner === to.owner
  )
    return to.public ? null : "PRIVATE_IMPORT";
  if (!to.public) return "PRIVATE_IMPORT";
  if (to.layer === "platform") return null;
  if (from.layer === "platform") return "PLATFORM_BUSINESS";
  return typeOnly ? null : "CROSS_MODULE_RUNTIME";
}

/** Analyze a source tree without mutating its baselines. Exported for isolated regression fixtures. */
export function analyzeArchitecture(
  root,
  { registry, legacy, baseline, compilerOptions } = {},
) {
  root = resolve(root);
  registry ??= readJson(root, "architecture/modules.json");
  legacy ??= readJson(root, "architecture/legacy-files.json");
  baseline ??= readJson(root, "architecture/legacy-imports.json");
  const errors = [],
    rawViolations = [];
  if (registry.version !== 1 || legacy.version !== 1 || baseline.version !== 1)
    throw new Error("Unsupported architecture manifest version");
  for (const [id, info] of Object.entries(registry.modules)) {
    if (!/^[a-z]+$/.test(id) || !info.name || !info.owns)
      throw new Error(`Invalid module registration: ${id}`);
  }
  if (!compilerOptions) {
    const configPath = resolve(root, "tsconfig.json");
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error)
      throw new Error(
        ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
      );
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    const configErrors = parsed.errors.filter((error) => error.code !== 18003);
    if (configErrors.length)
      throw new Error(
        configErrors
          .map((error) =>
            ts.flattenDiagnosticMessageText(error.messageText, "\n"),
          )
          .join("\n"),
      );
    compilerOptions = parsed.options;
  }
  const files = walk(root, resolve(root, "src"), errors);
  const paths = new Set(files.map((file) => slash(relative(root, file))));
  for (const [area, names] of [
    ["modules", Object.keys(registry.modules)],
    ["platform", registry.platform],
  ]) {
    for (const name of names) {
      const prefix = `src/${area}/${name}/`;
      if (
        [...paths].some((path) => path.startsWith(prefix)) &&
        !paths.has(prefix + "public.ts")
      ) {
        errors.push({
          code: "MISSING_PUBLIC_ENTRY",
          file: prefix,
          detail:
            "Every implemented module or platform capability requires a root public.ts entry.",
        });
      }
    }
  }
  const cache = ts.createModuleResolutionCache(
    root,
    (path) => path,
    compilerOptions,
  );
  const used = new Set();
  const exceptions = new Map();
  for (const exception of baseline.exceptions) {
    if (!exception.reason || !exception.key || exceptions.has(exception.key))
      throw new Error("Missing reason or duplicate legacy exception");
    exceptions.set(exception.key, exception);
  }
  for (const [path, entry] of Object.entries(legacy.files)) {
    if (!paths.has(path))
      errors.push({
        code: "STALE_LEGACY_FILE",
        file: path,
        detail: "Remove the retired file from the legacy inventory.",
      });
    if (!entry.owner || !entry.reason)
      throw new Error(`Legacy file needs owner and migration reason: ${path}`);
  }
  for (const absolute of files) {
    const file = slash(relative(root, absolute));
    const from = classify(file, registry, legacy);
    if (!from) {
      errors.push({
        code: "UNCLASSIFIED_FILE",
        file,
        detail:
          "Place new code in a registered module, platform capability, composition or web feature.",
      });
      continue;
    }
    const source = ts.createSourceFile(
      absolute,
      readFileSync(absolute, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const report = (code, target, edge, detail = "") => {
      const key = JSON.stringify([
        code,
        file,
        target,
        edge.form,
        edge.typeOnly,
        edge.bindings,
      ]);
      const record = {
        code,
        file,
        target,
        line:
          source.getLineAndCharacterOfPosition(edge.node.getStart(source))
            .line + 1,
        key,
        detail,
      };
      rawViolations.push(record);
      if (
        exceptions.has(key) &&
        from.layer === "legacy" &&
        classify(target, registry, legacy)?.layer === "legacy" &&
        code === "LEGACY_CROSS_MODULE"
      )
        used.add(key);
      else errors.push(record);
    };
    for (const edge of imports(source)) {
      if (edge.specifier === null) {
        report(
          "DYNAMIC_SPECIFIER",
          "<computed>",
          edge,
          "Use an explicit static adapter registry.",
        );
        continue;
      }
      const resolved = ts.resolveModuleName(
        edge.specifier,
        absolute,
        compilerOptions,
        ts.sys,
        cache,
      ).resolvedModule;
      let target = resolved
        ? slash(relative(root, realpathSync(resolved.resolvedFileName)))
        : null;
      const external =
        !resolved ||
        resolved.isExternalLibraryImport ||
        target.split("/").includes("node_modules");
      if (external) {
        if (
          databaseDrivers.test(edge.specifier) &&
          !(
            from.layer === "module" &&
            file.startsWith(`src/modules/${from.owner}/persistence/`)
          ) &&
          !["src/server/db.ts", "src/agent/db.ts"].includes(file)
        ) {
          report(
            "DATABASE_ACCESS",
            edge.specifier,
            edge,
            "Database drivers belong to the owning module persistence directory.",
          );
        }
        if (["node:module", "module"].includes(edge.specifier))
          report(
            "CUSTOM_LOADER",
            edge.specifier,
            edge,
            "Custom module loaders bypass the static dependency contract.",
          );
        if (from.layer === "web" && builtins.has(edge.specifier))
          report("BROWSER_NODE", edge.specifier, edge);
        if (
          from.layer === "contracts" &&
          (builtins.has(edge.specifier) ||
            (!edge.typeOnly && edge.specifier !== "zod"))
        )
          report("CONTRACT_EXTERNAL_RUNTIME", edge.specifier, edge);
        if (!resolved && !builtins.has(edge.specifier)) {
          const asset =
            from.layer === "web" &&
            /\.(?:css|svg|png|jpe?g|webp)$/.test(edge.specifier) &&
            edge.specifier.startsWith(".") &&
            existsSync(resolve(dirname(absolute), edge.specifier));
          if (!asset) report("UNRESOLVED_IMPORT", edge.specifier, edge);
        }
        continue;
      }
      if (
        isAbsolute(target) ||
        target.startsWith("../") ||
        !target.startsWith("src/")
      ) {
        report("OUTSIDE_SOURCE", target, edge);
        continue;
      }
      const code = violation(
        from,
        classify(target, registry, legacy),
        file,
        target,
        edge.typeOnly,
      );
      if (code) report(code, target, edge);
    }
    function checkEscape(node) {
      const call = ts.isCallExpression(node) || ts.isNewExpression(node);
      if (
        call &&
        ts.isIdentifier(node.expression) &&
        ["eval", "Function"].includes(node.expression.text)
      ) {
        report("CODE_EVALUATION", node.expression.text, {
          node,
          form: "eval",
          typeOnly: false,
          bindings: [],
        });
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        node.expression.getText(source) === "module" &&
        node.name.text === "require"
      ) {
        report("CUSTOM_LOADER", "module.require", {
          node,
          form: "loader",
          typeOnly: false,
          bindings: [],
        });
      }
      ts.forEachChild(node, checkEscape);
    }
    checkEscape(source);
  }
  for (const [key] of exceptions)
    if (!used.has(key))
      errors.push({
        code: "STALE_EXCEPTION",
        file: "architecture/legacy-imports.json",
        detail: key,
      });
  return {
    errors,
    rawViolations,
    fileCount: files.length,
    grandfathered: used.size,
  };
}

const invoked =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    checkBaseRevision(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
    const result = analyzeArchitecture(
      resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    );
    if (result.errors.length) {
      for (const error of result.errors)
        console.error(
          `[${error.code}] ${error.file}${error.line ? `:${error.line}` : ""}${error.target ? ` -> ${error.target}` : ""}${error.detail ? ` ${error.detail}` : ""}`,
        );
      console.error(
        `Architecture gate failed: ${result.errors.length} issue(s). See docs/module-development.md.`,
      );
      process.exitCode = 1;
    } else
      console.log(
        `Architecture gate passed: ${result.fileCount} source files; ${result.grandfathered} explicit legacy import exceptions.`,
      );
  } catch (error) {
    console.error(`Architecture gate failed: ${error.message}`);
    process.exitCode = 1;
  }
}
