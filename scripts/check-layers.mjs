// Layer dependency check (design spec section 26). No dependencies, Node >= 18, Windows-safe.
//
//   node scripts/check-layers.mjs [--root <dir>]
//
// Layers, lowest first: core (0) -> common (1) -> interface (2) -> methodologies (3).
// adapters, cli, schema and the root files src/index.ts and src/types.ts are outer and may
// import any layer. An import (runtime or type-only) may only go to the same or a lower layer.
// Exit 1 on a violation; warn (exit 0) above MAX_RUNTIME_EXPORTS runtime exports in a file
// that is not an index.ts, a test, test support or type-only.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";

const MAX_RUNTIME_EXPORTS = 5;
const LAYERS = ["core", "common", "interface", "methodologies"];
const OUTER = LAYERS.length;

// Known existing violations, matched on "<importing file> -> <imported file>" (src-relative, "/" separators).
// Empty since 1.2 U3: the record types moved to src/core/records/ (spec 26, "Record types").
const ALLOWLIST = [];

const rootArg = process.argv.indexOf("--root");
const root = resolve(rootArg > 0 ? process.argv[rootArg + 1] : ".");

const norm = (p) => p.split(sep).join("/");
const isTest = (f) => f.endsWith(".test.ts");
const isSupport = (f) => /(^|\/)(fixtures|[^/]+\.fixtures)\.ts$/.test(f);

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function layerOf(rel) {
  const m = /^src\/([^/]+)\//.exec(rel);
  const i = m ? LAYERS.indexOf(m[1]) : -1;
  return i >= 0 ? i : OUTER;
}
const layerName = (n) => (n === OUTER ? "outer" : LAYERS[n]);

const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** Static import / export-from specifiers: { spec, typeOnly }. */
function importsOf(src) {
  const out = [];
  const re = /\b(import|export)\s+(type\s+)?([^;'"`]*?\s+from\s+)?["']([^"']+)["']/g;
  for (const m of src.matchAll(re)) {
    if (m[1] === "export" && !m[3]) continue;
    let typeOnly = Boolean(m[2]);
    const names = /\{([^}]*)\}/.exec(m[3] ?? "");
    if (!typeOnly && names && !/^\s*[\w$]+\s*,/.test(m[3])) {
      const parts = names[1]
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      typeOnly = parts.length > 0 && parts.every((p) => p.startsWith("type "));
    }
    out.push({ spec: m[4], typeOnly });
  }
  return out;
}

/** Count of runtime (value) exports declared in a file. */
function runtimeExports(src) {
  let n = 0;
  n += [...src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|class|const|let|var|enum)\s/gm)]
    .length;
  n += [...src.matchAll(/^export\s+default\s/gm)].length;
  for (const m of src.matchAll(/^export\s+(type\s+)?\{([^}]*)\}/gm)) {
    if (m[1]) continue;
    n += m[2]
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x && !x.startsWith("type ")).length;
  }
  return n;
}

const errors = [];
const warnings = [];
const allowed = new Set(ALLOWLIST.map((a) => `${a.from} -> ${a.to}`));

const srcDir = join(root, "src");
for (const full of walk(srcDir).sort()) {
  const rel = norm(relative(root, full));
  if (isTest(rel)) continue;
  const text = stripComments(readFileSync(full, "utf8"));
  const fromLayer = layerOf(rel);

  for (const { spec } of importsOf(text)) {
    if (!spec.startsWith(".")) continue;
    const target = norm(relative(root, resolve(dirname(full), spec)));
    const toLayer = layerOf(target);
    if (toLayer <= fromLayer) continue;
    const to = target.endsWith(".ts") ? target : `${target}/index.ts`;
    if (allowed.has(`${rel} -> ${to}`)) continue;
    errors.push(`${rel} imports ${to} (${layerName(fromLayer)} -> ${layerName(toLayer)})`);
  }

  if (posix.basename(rel) !== "index.ts" && !isSupport(rel)) {
    const n = runtimeExports(text);
    if (n > MAX_RUNTIME_EXPORTS)
      warnings.push(
        `${rel} has ${n} runtime exports (more than ${MAX_RUNTIME_EXPORTS}; split by responsibility)`,
      );
  }
}

for (const w of warnings) console.warn(`warning: ${w}`);
for (const e of errors) console.error(e);
if (errors.length) {
  console.error(`check-layers: ${errors.length} layer violation(s)`);
  process.exit(1);
}
console.log(`check-layers: ok (${warnings.length} warning(s), ${ALLOWLIST.length} allowlisted)`);
