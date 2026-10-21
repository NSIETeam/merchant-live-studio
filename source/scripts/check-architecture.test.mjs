import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import ts from "typescript";
import {
  analyzeArchitecture,
  checkLegacyRatchet,
} from "./check-architecture.mjs";

const registry = {
  version: 1,
  modules: Object.fromEntries(
    ["agent", "content", "review", "live", "payments"].map((id) => [
      id,
      { name: id, owns: `${id} business records` },
    ]),
  ),
  platform: ["identity", "infrastructure"],
};
const emptyLegacy = () => ({ version: 1, files: {} });
const emptyBaseline = () => ({ version: 1, exceptions: [] });

function fixture(t, files, options = {}) {
  const parent = realpathSync(tmpdir());
  const root = mkdtempSync(join(parent, "kaopu-architecture-"));
  const write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  for (const [path, content] of Object.entries(files)) write(path, content);
  t.after(() => {
    // Validate the resolved target before recursively deleting this test's own temporary directory.
    const target = realpathSync(root);
    assert.equal(dirname(target), parent);
    assert.ok(basename(target).startsWith("kaopu-architecture-"));
    rmSync(target, { recursive: true, force: true });
  });
  return {
    root,
    write,
    run: (overrides = {}) =>
      analyzeArchitecture(root, {
        registry,
        legacy: emptyLegacy(),
        baseline: emptyBaseline(),
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          ...options.compilerOptions,
        },
        ...options,
        ...overrides,
      }),
  };
}
const contracts = {
  "src/modules/content/public.ts":
    "export interface ContentPort { read(): string }; export const createContent = () => ({});",
  "src/modules/live/public.ts":
    "export interface LivePort {}; export const createLive = () => ({});",
};
const codes = (result) => result.errors.map((error) => error.code);

test("legacy baseline comparison rejects added files, owners and import allowances", () => {
  const previous = {
    legacy: { files: { "src/server/old.ts": { owner: "content" } } },
    baseline: { exceptions: [{ key: "existing" }] },
  };
  const current = {
    legacy: {
      files: {
        "src/server/old.ts": { owner: "live" },
        "src/server/new.ts": { owner: "live" },
      },
    },
    baseline: { exceptions: [{ key: "existing" }, { key: "new" }] },
  };
  assert.equal(checkLegacyRatchet(previous, current).length, 3);
  assert.deepEqual(checkLegacyRatchet(previous, previous), []);
  assert.deepEqual(
    checkLegacyRatchet(previous, {
      legacy: { files: {} },
      baseline: { exceptions: [] },
    }),
    [],
  );
});

test("public types, own internals and composition wiring remain usable", (t) => {
  const f = fixture(t, {
    ...contracts,
    "src/modules/live/internal.ts":
      "import type { ContentPort } from '../content/public.js'; export const attach = (port: ContentPort) => port.read();",
    "src/modules/live/public.ts": "export { attach } from './internal.js';",
    "src/composition/app.ts":
      "import { createContent } from '../modules/content/public.js'; import { attach } from '../modules/live/public.js';",
    "src/shared/events.ts": "export interface Event { id: string };",
  });
  assert.deepEqual(f.run().errors, []);
});

for (const [name, statement, expected] of [
  [
    "runtime import from a public business entry",
    "import { createContent } from '../content/public.js';",
    "CROSS_MODULE_RUNTIME",
  ],
  [
    "private type import",
    "import type { Secret } from '../content/internal.js';",
    "PRIVATE_IMPORT",
  ],
  [
    "private re-export",
    "export { hidden } from '../content/internal.js';",
    "PRIVATE_IMPORT",
  ],
  [
    "dynamic import",
    "void import('../content/public.js');",
    "CROSS_MODULE_RUNTIME",
  ],
  [
    "require",
    "const dependency = require('../content/public.js');",
    "CROSS_MODULE_RUNTIME",
  ],
  [
    "import equals",
    "import dependency = require('../content/internal.js');",
    "PRIVATE_IMPORT",
  ],
  [
    "type query through a private file",
    "type Value = import('../content/internal.js').Secret;",
    "PRIVATE_IMPORT",
  ],
  [
    "computed import",
    "const target = '../content/public.js'; void import(target);",
    "DYNAMIC_SPECIFIER",
  ],
  [
    "computed require",
    "const target = '../content/public.js'; require(target);",
    "DYNAMIC_SPECIFIER",
  ],
  [
    "custom loader",
    "import { createRequire } from 'node:module';",
    "CUSTOM_LOADER",
  ],
  [
    "module require",
    "module.require('../content/public.js');",
    "CUSTOM_LOADER",
  ],
  ["code evaluation", "new Function('return 1');", "CODE_EVALUATION"],
]) {
  test(`rejects ${name}`, (t) => {
    const f = fixture(t, {
      ...contracts,
      "src/modules/content/internal.ts":
        "export interface Secret {}; export const hidden = 1;",
      "src/modules/live/action.ts": statement,
    });
    assert.ok(codes(f.run()).includes(expected));
  });
}

test("resolves path aliases rather than trusting the import spelling", (t) => {
  const f = fixture(t, {
    ...contracts,
    "src/modules/live/action.ts": "import { createContent } from '@content';",
  });
  const result = f.run({
    compilerOptions: {
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      module: ts.ModuleKind.ESNext,
      baseUrl: f.root,
      paths: { "@content": ["src/modules/content/public.ts"] },
    },
  });
  assert.ok(codes(result).includes("CROSS_MODULE_RUNTIME"));
});

test("unregistered source locations and missing public entries fail", (t) => {
  const f = fixture(t, {
    "src/server/new-business.ts": "export const business = 1;",
    "src/modules/mystery/public.ts": "export const mystery = 1;",
    "src/modules/live/action.ts": "export const action = 1;",
  });
  assert.equal(
    codes(f.run()).filter((code) => code === "UNCLASSIFIED_FILE").length,
    2,
  );
  assert.ok(codes(f.run()).includes("MISSING_PUBLIC_ENTRY"));
});

test("browser and shared contracts cannot import backend implementations", (t) => {
  const f = fixture(t, {
    ...contracts,
    "src/web/live/page.ts":
      "import type { LivePort } from '../../modules/live/public.js';",
    "src/shared/types.ts":
      "export type { LivePort } from '../modules/live/public.js';",
  });
  assert.ok(codes(f.run()).includes("BROWSER_BACKEND"));
  assert.ok(codes(f.run()).includes("CONTRACT_BACK_EDGE"));
});

test("database drivers are restricted to a module persistence directory", (t) => {
  const f = fixture(t, {
    ...contracts,
    "src/modules/live/action.ts": "import { DatabaseSync } from 'node:sqlite';",
    "src/modules/content/persistence/database.ts":
      "import { DatabaseSync } from 'node:sqlite';",
  });
  const violations = f
    .run()
    .errors.filter((error) => error.code === "DATABASE_ACCESS");
  assert.equal(violations.length, 1);
  assert.equal(violations[0].file, "src/modules/live/action.ts");
});

test("platform public APIs are usable, but platform cannot depend on a business module", (t) => {
  const f = fixture(t, {
    ...contracts,
    "src/platform/identity/public.ts": "export const authorize = () => true;",
    "src/modules/live/action.ts":
      "import { authorize } from '../../platform/identity/public.js';",
    "src/platform/identity/internal.ts":
      "import type { LivePort } from '../../modules/live/public.js';",
  });
  assert.deepEqual(codes(f.run()), ["PLATFORM_BUSINESS"]);
});

test("new modules cannot depend on legacy storage or implementations", (t) => {
  const legacy = {
    version: 1,
    files: {
      "src/server/db.ts": {
        owner: "legacy-storage",
        reason: "Existing storage",
      },
    },
  };
  const f = fixture(
    t,
    {
      ...contracts,
      "src/server/db.ts": "export const db = {};",
      "src/modules/live/action.ts": "import { db } from '../../server/db.js';",
    },
    { legacy },
  );
  assert.ok(codes(f.run()).includes("NEW_LEGACY_IMPORT"));
});

test("legacy allowances are exact, detect new imported symbols and must shrink after migration", (t) => {
  const legacy = {
    version: 1,
    files: {
      "src/server/content.ts": {
        owner: "content",
        reason: "Existing mixed content routes",
      },
      "src/server/db.ts": {
        owner: "legacy-storage",
        reason: "Existing storage",
      },
    },
  };
  const f = fixture(
    t,
    {
      "src/server/content.ts": "import { db } from './db.js';",
      "src/server/db.ts": "export const db = {}; export const extra = {};",
    },
    { legacy },
  );
  const original = f.run();
  assert.deepEqual(codes(original), ["LEGACY_CROSS_MODULE"]);
  const baseline = {
    version: 1,
    exceptions: [
      { key: original.rawViolations[0].key, reason: "An existing edge" },
    ],
  };
  assert.deepEqual(f.run({ baseline }).errors, []);
  f.write("src/server/content.ts", "import { db, extra } from './db.js';");
  assert.ok(codes(f.run({ baseline })).includes("LEGACY_CROSS_MODULE"));
  f.write("src/server/content.ts", "export const retired = true;");
  assert.deepEqual(codes(f.run({ baseline })), ["STALE_EXCEPTION"]);
  assert.deepEqual(f.run().errors, []);
});

test("an exception cannot authorize Agent to import the legacy business runtime", (t) => {
  const legacy = {
    version: 1,
    files: {
      "src/agent/app.ts": { owner: "agent", reason: "Existing Agent" },
      "src/server/db.ts": {
        owner: "legacy-storage",
        reason: "Existing storage",
      },
    },
  };
  const f = fixture(
    t,
    {
      "src/server/db.ts": "export const db = {};",
      "src/agent/app.ts": "import { db } from '../server/db.js';",
    },
    { legacy },
  );
  const initial = f.run();
  const baseline = {
    version: 1,
    exceptions: [
      { key: initial.rawViolations[0].key, reason: "Attempted bypass" },
    ],
  };
  assert.ok(codes(f.run({ baseline })).includes("AGENT_LIVE_IMPORT"));
});

test("dependencies cannot escape into unscanned repository code", (t) => {
  const f = fixture(t, {
    ...contracts,
    "outside.ts": "export const hidden = 1;",
    "src/modules/live/action.ts":
      "import { hidden } from '../../../outside.js';",
  });
  assert.ok(codes(f.run()).includes("OUTSIDE_SOURCE"));
});
