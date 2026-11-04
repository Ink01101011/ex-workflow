import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "check-layers.mjs");

function run(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "check-layers-"));
  try {
    for (const [rel, text] of Object.entries(files)) {
      const full = join(root, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    }
    const r = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the repository itself passes", () => {
  const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("a runtime import to a higher layer fails and names both layers", () => {
  const r = run({
    "src/core/a.ts": 'import { m } from "../methodologies/x/m.ts";\nexport const a = m;\n',
    "src/methodologies/x/m.ts": "export const m = 1;\n",
  });
  assert.equal(r.code, 1);
  assert.match(
    r.err,
    /src\/core\/a\.ts imports src\/methodologies\/x\/m\.ts \(core -> methodologies\)/,
  );
});

test("a type-only import to a higher layer also fails", () => {
  const r = run({
    "src/common/a.ts": 'import type { I } from "../interface/i.ts";\nexport type J = I;\n',
    "src/interface/i.ts": "export type I = number;\n",
  });
  assert.equal(r.code, 1);
  assert.match(r.err, /src\/common\/a\.ts imports src\/interface\/i\.ts \(common -> interface\)/);
});

test("same-layer, downward and outer-layer imports pass; test files are ignored", () => {
  const r = run({
    "src/core/types.ts": "export type T = number;\n",
    "src/core/a.ts": 'import type { T } from "./types.ts";\nexport const a: T = 1;\n',
    "src/common/b.ts": 'import { a } from "../core/a.ts";\nexport const b = a;\n',
    "src/methodologies/x/c.ts": 'import { b } from "../../common/b.ts";\nexport const c = b;\n',
    "src/adapters/d.ts": 'import { c } from "../methodologies/x/c.ts";\nexport const d = c;\n',
    "src/index.ts": 'export { d } from "./adapters/d.ts";\n',
    "src/core/a.test.ts": 'import { c } from "../methodologies/x/c.ts";\nexport const t = c;\n',
  });
  assert.equal(r.code, 0, r.err);
});

test("a re-export from a higher layer fails", () => {
  const r = run({
    "src/core/a.ts": 'export { m } from "../methodologies/m.ts";\n',
    "src/methodologies/m.ts": "export const m = 1;\n",
  });
  assert.equal(r.code, 1);
  assert.match(r.err, /src\/core\/a\.ts imports src\/methodologies\/m\.ts/);
});

test("more than 5 runtime exports warns without failing; index and type-only files are exempt", () => {
  const many = ["a", "b", "c", "d", "e", "f"].map((n) => `export const ${n} = 1;`).join("\n");
  const types = ["A", "B", "C", "D", "E", "F"].map((n) => `export type ${n} = 1;`).join("\n");
  const r = run({
    "src/core/many.ts": `${many}\n`,
    "src/core/index.ts": `${many}\n`,
    "src/core/types.ts": `${types}\n`,
  });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /src\/core\/many\.ts has 6 runtime exports/);
  assert.doesNotMatch(r.err, /index\.ts|types\.ts/);
});

test("an overloaded function counts as one runtime export", () => {
  const overloaded = [
    "export function f(a: string): string;",
    "export function f(a: number): number;",
    "export function f(a: unknown): unknown { return a; }",
  ].join("\n");
  const five = ["a", "b", "c", "d"].map((n) => `export const ${n} = 1;`).join("\n");
  const r = run({ "src/core/over.ts": `${overloaded}\n${five}\n` });
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.err, /over\.ts/);
});

test("a dynamic import() to a higher layer fails", () => {
  const r = run({
    "src/core/a.ts": 'export const a = () => import("../methodologies/m.ts");\n',
    "src/methodologies/m.ts": "export const m = 1;\n",
  });
  assert.equal(r.code, 1);
  assert.match(
    r.err,
    /src\/core\/a\.ts imports src\/methodologies\/m\.ts \(core -> methodologies\)/,
  );
});

test("require(), import x = require() and import() types to a higher layer fail", () => {
  const r = run({
    "src/core/a.ts":
      'declare const require: (s: string) => unknown;\nexport const a = require("../methodologies/r.ts");\n',
    "src/core/b.ts": 'import m = require("../methodologies/q.ts");\nexport const b = m;\n',
    "src/core/c.ts": 'export type C = typeof import("../methodologies/t.ts");\n',
    "src/methodologies/r.ts": "export const r = 1;\n",
    "src/methodologies/q.ts": "export const q = 1;\n",
    "src/methodologies/t.ts": "export const t = 1;\n",
  });
  assert.equal(r.code, 1);
  assert.match(r.err, /src\/core\/a\.ts imports src\/methodologies\/r\.ts/);
  assert.match(r.err, /src\/core\/b\.ts imports src\/methodologies\/q\.ts/);
  assert.match(r.err, /src\/core\/c\.ts imports src\/methodologies\/t\.ts/);
});

test("comment markers inside strings do not hide a real import", () => {
  const r = run({
    "src/core/a.ts":
      'export const s = "a/*";\nimport { m } from "../methodologies/m.ts";\nexport const t = "*/b";\nexport const a = m;\n',
    "src/core/b.ts":
      "export const u = 'a//b'; import { m } from \"../methodologies/m.ts\";\nexport const b = m;\n",
    "src/methodologies/m.ts": "export const m = 1;\n",
  });
  assert.equal(r.code, 1);
  assert.match(r.err, /src\/core\/a\.ts imports src\/methodologies\/m\.ts/);
  assert.match(r.err, /src\/core\/b\.ts imports src\/methodologies\/m\.ts/);
});

test("imports inside comments and strings are not imports", () => {
  const r = run({
    "src/core/a.ts":
      '// import { m } from "../methodologies/m.ts";\n/* import("../methodologies/m.ts") */\nexport const s = \'import { m } from "../methodologies/m.ts"\';\n',
    "src/methodologies/m.ts": "export const m = 1;\n",
  });
  assert.equal(r.code, 0, r.err);
});

test("an extensionless specifier is reported as the file it resolves to", () => {
  const r = run({
    "src/core/a.ts": 'import { m } from "../methodologies/m";\nexport const a = m;\n',
    "src/core/b.ts": 'import { x } from "../methodologies/x";\nexport const b = x;\n',
    "src/core/c.ts": 'import { m } from "../methodologies/m.js";\nexport const c = m;\n',
    "src/methodologies/m.ts": "export const m = 1;\n",
    "src/methodologies/x/index.ts": "export const x = 1;\n",
  });
  assert.equal(r.code, 1);
  assert.match(r.err, /src\/core\/a\.ts imports src\/methodologies\/m\.ts \(/);
  assert.match(r.err, /src\/core\/b\.ts imports src\/methodologies\/x\/index\.ts \(/);
  assert.match(r.err, /src\/core\/c\.ts imports src\/methodologies\/m\.ts \(/);
  assert.doesNotMatch(r.err, /m\/index\.ts/);
});

test("inner layers may import only relative paths, ex-flow and exsorted", () => {
  const bad = run({
    "src/core/a.ts": 'import { readFileSync } from "node:fs";\nexport const a = readFileSync;\n',
    "src/common/b.ts": 'import type { X } from "lodash";\nexport type B = X;\n',
    "src/interface/c.ts": 'export const c = () => import("node:crypto");\n',
    "src/methodologies/x/d.ts": 'import path from "path";\nexport const d = path;\n',
  });
  assert.equal(bad.code, 1);
  assert.match(
    bad.err,
    /src\/core\/a\.ts imports bare specifier "node:fs" \(core may import only relative paths, ex-flow and exsorted\)/,
  );
  assert.match(bad.err, /src\/common\/b\.ts imports bare specifier "lodash"/);
  assert.match(bad.err, /src\/interface\/c\.ts imports bare specifier "node:crypto"/);
  assert.match(bad.err, /src\/methodologies\/x\/d\.ts imports bare specifier "path"/);

  const ok = run({
    "src/core/a.ts":
      'import { flow } from "ex-flow";\nimport { sort } from "exsorted";\nexport const a = [flow, sort];\n',
    "src/adapters/f.ts":
      'import { readFileSync } from "node:fs";\nexport const f = readFileSync;\n',
    "src/cli/g.ts": 'import { argv } from "node:process";\nexport const g = argv;\n',
    "src/core/a.test.ts": 'import { test } from "node:test";\nexport const t = test;\n',
  });
  assert.equal(ok.code, 0, ok.err);
});

test("a runtime-dependency specifier with . or .. segments is not a dependency subpath", () => {
  const bad = run({
    "src/core/a.ts": 'import { x } from "ex-flow/../evil";\nexport const a = x;\n',
    "src/common/b.ts": 'import { y } from "exsorted/./y";\nexport const b = y;\n',
    "src/interface/c.ts": 'import { z } from "ex-flow/lib/../../z";\nexport const c = z;\n',
    "src/methodologies/x/d.ts": 'import { w } from "ex-flow//w";\nexport const d = w;\n',
    "src/core/e.ts": 'import { v } from "ex-flow-evil";\nexport const e = v;\n',
  });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /src\/core\/a\.ts imports bare specifier "ex-flow\/\.\.\/evil"/);
  assert.match(bad.err, /src\/common\/b\.ts imports bare specifier "exsorted\/\.\/y"/);
  assert.match(
    bad.err,
    /src\/interface\/c\.ts imports bare specifier "ex-flow\/lib\/\.\.\/\.\.\/z"/,
  );
  assert.match(bad.err, /src\/methodologies\/x\/d\.ts imports bare specifier "ex-flow\/\/w"/);
  assert.match(bad.err, /src\/core\/e\.ts imports bare specifier "ex-flow-evil"/);

  const ok = run({
    "src/core/a.ts":
      'import { x } from "ex-flow/dist/index.js";\nimport { y } from "exsorted/sub";\nexport const a = [x, y];\n',
  });
  assert.equal(ok.code, 0, ok.err);
});
