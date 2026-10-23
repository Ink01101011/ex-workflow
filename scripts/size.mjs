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
const NOTE =
  "budgets set at measured size (owner decision, 2026-10-19 for core+scrum, Phase 2 for core+kanban); spec target was 40960 per methodology; ratchets down only; core+scrum raised 45244 -> 45668, dist/index.mjs 1031 -> 1092, dist/scrum/index.mjs 369 -> 404 on 2026-10-22 for the Phase 2 planner hooks and the blocker.raised/blocker.cleared transition payloads (+424 B core+scrum, measured: +330 B hooks at ac350c4, +94 B payloads at e04cb76); core+scrum 45668 -> 46190 and core+kanban 55726 -> 56956 on 2026-10-22 for plan() skipped-reason reporting (+522 B core) and class-band ordering with aging promotion (+706 B kanban), measured; core+scrum 46190 -> 46213 and core+kanban 56956 -> 57199 for the question entry-policy exemption and index-based deferral counting, measured; core+scrum 46213 -> 46552 and core+kanban 57199 -> 57538 on 2026-10-23 for the Phase 3 core additions (phase fields, planner roleFor, afterDecide hook, item.added phase/parent payload; +339 B core, measured); core+waterfall 57943 and dist/waterfall/index.mjs 934 seeded at measured size (Phase 3); core+waterfall 57943 -> 58264 on 2026-10-23 for the human-only decider check in waterfallAfterDecide (+321 B, measured); dist/schema/index.mjs and schema seeded at measured size on 2026-10-23 (Phase 4); schema 21253 -> 22491 on 2026-10-23 for the ItemPatch definition and anyOf discriminator reporting (Phase 4 final review); dist/schema/index.mjs 332 -> 353 for the same change; core+scrum 46552 -> 57126, core+kanban 57538 -> 63883, core+waterfall 58264 -> 64863, dist/index.mjs 1092 -> 1195, dist/scrum/index.mjs 404 -> 423, schema 22491 -> 22718 on 2026-10-23 for Phase 5 (engine gaps #8-#21: planner budget gates, changeConfig, accounting corrections, agreements, question brief parent; measured); core+scrum per task: T1 +1596, T2 +3142, T3 +1334, T4 +958, T5 +1750 and +252 (review fix), T6 +1542 (sum 10574); core+scrum 57126 -> 57417, core+kanban 63883 -> 64121, core+waterfall 64863 -> 65101 on 2026-10-23 for the Phase 5 fix wave (planner committed-list in-flight count, changeConfig unknown keys, applyAgreement self-replace, dod-not-weakened canonical key; measured)";
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
