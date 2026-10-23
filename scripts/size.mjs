import { statSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { build } from "tsup";

const TARGET = 40_960; // core + scrum, minified, single bundle, before gzip
const file = "size-budget.json";

for (const [name, entry] of [
  ["measure", "scripts/measure-entry.ts"],
  ["measure-kanban", "scripts/measure-kanban-entry.ts"],
  ["measure-waterfall", "scripts/measure-waterfall-entry.ts"],
  ["measure-schema", "scripts/measure-schema-entry.ts"],
]) {
  await build({
    entry: { [name]: entry },
    format: ["esm"],
    minify: true,
    treeshake: true,
    splitting: false,
    dts: false,
    sourcemap: false,
    clean: name === "measure",
    silent: true,
    outDir: ".size-measure",
    platform: "node",
    target: "node18",
    external: ["ex-flow", "exsorted"],
    metafile: true,
  });
}

const measured = {
  "dist/index.mjs": statSync("dist/index.mjs").size,
  "dist/scrum/index.mjs": statSync("dist/scrum/index.mjs").size,
  "dist/kanban/index.mjs": statSync("dist/kanban/index.mjs").size,
  "core+scrum": statSync(".size-measure/measure.mjs").size,
  "core+kanban": statSync(".size-measure/measure-kanban.mjs").size,
  "dist/waterfall/index.mjs": statSync("dist/waterfall/index.mjs").size,
  "core+waterfall": statSync(".size-measure/measure-waterfall.mjs").size,
  "dist/schema/index.mjs": statSync("dist/schema/index.mjs").size,
  schema: statSync(".size-measure/measure-schema.mjs").size,
};
const current = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
// the note lives in size-budget.json (hand-edited per phase); --write keeps it instead of overwriting it
const NOTE = current.note ?? "budgets set at measured size (owner decision); ratchets down only";
const budgets = {};
for (const k of Object.keys(measured)) {
  budgets[k] = current[k] ?? (k.startsWith("core+") ? TARGET : measured[k]);
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
