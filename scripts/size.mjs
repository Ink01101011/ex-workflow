import { statSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { build } from "tsup";

const TARGET = 40_960; // core + scrum, minified, single bundle, before gzip
const file = "size-budget.json";

await build({
  entry: { measure: "scripts/measure-entry.ts" },
  format: ["esm"],
  minify: true,
  treeshake: true,
  splitting: false,
  dts: false,
  sourcemap: false,
  clean: true,
  silent: true,
  outDir: ".size-measure",
  platform: "node",
  target: "node18",
  external: ["ex-flow", "exsorted"],
  metafile: true,
});

const measured = {
  "dist/index.mjs": statSync("dist/index.mjs").size,
  "dist/scrum/index.mjs": statSync("dist/scrum/index.mjs").size,
  "core+scrum": statSync(".size-measure/measure.mjs").size,
};
const current = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
const NOTE =
  "budget set at measured size on 2026-10-19 (owner decision); spec target was 40960; ratchets down only";
const budgets = {};
for (const k of Object.keys(measured)) {
  budgets[k] = current[k] ?? (k === "core+scrum" ? TARGET : measured[k]);
}

let failed = false;
for (const [k, size] of Object.entries(measured)) {
  const ok = size <= budgets[k];
  if (!ok) failed = true;
  console.log(`${ok ? "ok  " : "FAIL"} ${k} ${size} B (budget ${budgets[k]} B)`);
}
if (process.argv.includes("--write") && !failed) {
  // ratchet: a stored budget may only be lowered, never raised
  const out = {};
  for (const k of Object.keys(measured)) out[k] = Math.min(budgets[k], measured[k]);
  out.measured = { ...measured };
  out.note = NOTE;
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
}
if (failed) {
  console.error("size budget exceeded; reduce the bundle or justify a measured change in size-budget.json");
  process.exit(1);
}
