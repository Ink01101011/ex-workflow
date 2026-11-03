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
