// Rule 1 of docs/principles.md ("Core is pure"): the oxlint overrides in .oxlintrc.json refuse
// clock, randomness and I/O globals in the inner layers (spec 26, "Purity lint (U13)").
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const oxlint = join(
  dirname(createRequire(import.meta.url).resolve("oxlint/package.json")),
  "bin",
  "oxlint",
);

function lint(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "purity-lint-"));
  try {
    copyFileSync(join(repo, ".oxlintrc.json"), join(root, ".oxlintrc.json"));
    for (const [rel, text] of Object.entries(files)) {
      const full = join(root, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    }
    const r = spawnSync(process.execPath, [oxlint, "src"], { cwd: root, encoding: "utf8" });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const impure = [
  "export const a = () => Date.now();",
  "export const b = () => Math.random();",
  'export const c = () => fetch("https://example.com");',
  "export const d = () => process.env;",
  "export const e = () => crypto.randomUUID();",
  "export const f = () => performance.now();",
  "export const g = () => setTimeout(() => {}, 1);",
].join("\n");

test("inner layers may not read the clock, draw random numbers or reach I/O globals", () => {
  for (const layer of ["core", "common", "interface", "methodologies/x"]) {
    const r = lint({ [`src/${layer}/a.ts`]: `${impure}\n` });
    assert.equal(r.code, 1, r.out);
    for (const name of [
      "Date.now",
      "Math.random",
      "fetch",
      "process",
      "crypto",
      "performance",
      "setTimeout",
    ])
      assert.ok(r.out.includes(`'${name}'`), `${layer}: ${name} not reported\n${r.out}`);
  }
});

test("outer layers, tests, Date.parse and a passed-in now stay allowed", () => {
  const r = lint({
    "src/adapters/a.ts": `${impure}\n`,
    "src/cli/b.ts": `${impure}\n`,
    "src/core/c.test.ts": `${impure}\n`,
    "src/core/d.ts":
      'export const nowOf = (now?: string) => now ?? new Date().toISOString();\nexport const t = Date.parse("2026-01-01T00:00:00Z");\n',
  });
  assert.equal(r.code, 0, r.out);
});
