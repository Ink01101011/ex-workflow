// Layer dependency check (design spec section 26). Uses the `typescript` devDependency's parser;
// runs with plain node, Node >= 18, Windows-safe.
//
//   node scripts/check-layers.mjs [--root <dir>]
//
// Layers, lowest first: core (0) -> common (1) -> interface (2) -> methodologies (3).
// adapters, cli, schema and the root files src/index.ts and src/types.ts are outer and may
// import any layer. An import (runtime or type-only) may only go to the same or a lower layer, and
// an inner-layer file may import no bare specifier other than the runtime dependencies.
// Exit 1 on a violation; warn (exit 0) above MAX_RUNTIME_EXPORTS runtime exports in a file
// that is not an index.ts, a test, test support, generated or type-only.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import ts from "typescript";

const MAX_RUNTIME_EXPORTS = 5;
const LAYERS = ["core", "common", "interface", "methodologies"];
const OUTER = LAYERS.length;
// The only bare specifiers an inner layer may import (package.json dependencies); node: and any
// other package are outer-layer only (spec 26, "Bare specifiers").
const RUNTIME_DEPS = ["ex-flow", "exsorted"];

// Generated files, exempt from the export-count warning (not from the layer rule): their shape
// follows the generator (spec 26, "Generated schema file (U13)").
const GENERATED = new Set(["src/schema/generated.ts"]);

// Known existing violations, matched on "<importing file> -> <imported file>" (src-relative, "/" separators).
// Empty since 1.2 U3: the record types moved to src/core/records/ (spec 26, "Record types").
const ALLOWLIST = [];

const rootArg = process.argv.indexOf("--root");
const root = resolve(rootArg > 0 ? process.argv[rootArg + 1] : ".");

// Every TypeScript and JavaScript source extension is checked, declaration files excepted
// (spec 26, "Layer check extensions (U13)").
const SOURCE_EXTS = [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs"];
const EXT = "(?:ts|mts|cts|tsx|js|mjs|cjs)";
const isSource = (f) => new RegExp(`\\.${EXT}$`).test(f) && !/\.d\.[^./]+$/.test(f);
const norm = (p) => p.split(sep).join("/");
const isTest = (f) => new RegExp(`\\.test\\.${EXT}$`).test(f);
const isSupport = (f) => new RegExp(`(^|/)(fixtures|[^/]+\\.fixtures)\\.${EXT}$`).test(f);
const isIndex = (f) => new RegExp(`^index\\.${EXT}$`).test(posix.basename(f));

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (isSource(e.name)) out.push(full);
  }
  return out;
}

function layerOf(rel) {
  const m = /^src\/([^/]+)\//.exec(rel);
  const i = m ? LAYERS.indexOf(m[1]) : -1;
  return i >= 0 ? i : OUTER;
}
const layerName = (n) => (n === OUTER ? "outer" : LAYERS[n]);

/** Every module specifier in a file: import / export-from (type-only included), import x = require(),
 * dynamic import(), require() and import("…") types. Parsed by TypeScript, so comments and strings
 * never produce or hide an import. */
function importsOf(sf) {
  const out = [];
  const lit = (n) => (n && ts.isStringLiteralLike(n) ? n.text : undefined);
  const visit = (node) => {
    let spec;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) spec = lit(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
      spec = lit(node.moduleReference.expression);
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    )
      spec = lit(node.arguments[0]);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      spec = lit(node.argument.literal);
    if (spec !== undefined) out.push(spec);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const hasModifier = (node, kind) =>
  (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some((m) => m.kind === kind) ??
  false;

/** Count of runtime (value) exports declared in a file. */
function runtimeExports(sf) {
  let n = 0;
  const functions = new Set(); // an overloaded function declares its name once per signature
  for (const st of sf.statements) {
    if (ts.isExportAssignment(st)) n++;
    else if (ts.isExportDeclaration(st)) {
      if (st.isTypeOnly || !st.exportClause || !ts.isNamedExports(st.exportClause)) continue;
      n += st.exportClause.elements.filter((e) => !e.isTypeOnly).length;
    } else if (hasModifier(st, ts.SyntaxKind.ExportKeyword)) {
      if (hasModifier(st, ts.SyntaxKind.DefaultKeyword)) n++;
      else if (ts.isFunctionDeclaration(st)) functions.add(st.name?.text);
      else if (ts.isVariableStatement(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st))
        n++;
    }
  }
  return n + functions.size;
}

/** The file a relative specifier names: `.js` / `.mjs` / `.cjs` mapped to its TypeScript source,
 * as written, `+ <ext>`, or `/index.<ext>`, trying the source extensions in order. */
function resolveSpec(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base.replace(/\.(m|c)?js$/, ".$1ts"),
    base,
    ...SOURCE_EXTS.map((x) => `${base}${x}`),
    ...SOURCE_EXTS.map((x) => join(base, `index${x}`)),
  ];
  return candidates.find((c) => isSource(c) && existsSync(c) && statSync(c).isFile()) ?? base;
}

// The exact package name, or a real subpath of it: no empty, "." or ".." segment, so
// "ex-flow/../evil" does not pass as ex-flow (spec 26, "Bare specifier subpaths (U13)").
const isAllowedBare = (spec) =>
  RUNTIME_DEPS.some(
    (d) =>
      spec === d ||
      (spec.startsWith(`${d}/`) &&
        spec
          .slice(d.length + 1)
          .split(/[\\/]/)
          .every((seg) => seg !== "" && seg !== "." && seg !== "..")),
  );

const errors = [];
const warnings = [];
const allowed = new Set(ALLOWLIST.map((a) => `${a.from} -> ${a.to}`));

const srcDir = join(root, "src");
for (const full of walk(srcDir).sort()) {
  const rel = norm(relative(root, full));
  if (isTest(rel)) continue;
  const sf = ts.createSourceFile(full, readFileSync(full, "utf8"), ts.ScriptTarget.Latest, false);
  const fromLayer = layerOf(rel);

  for (const spec of importsOf(sf)) {
    if (!spec.startsWith(".")) {
      if (fromLayer !== OUTER && !isAllowedBare(spec))
        errors.push(
          `${rel} imports bare specifier "${spec}" (${layerName(fromLayer)} may import only relative paths, ${RUNTIME_DEPS.join(" and ")})`,
        );
      continue;
    }
    const to = norm(relative(root, resolveSpec(full, spec)));
    const toLayer = layerOf(to);
    if (toLayer <= fromLayer) continue;
    if (allowed.has(`${rel} -> ${to}`)) continue;
    errors.push(`${rel} imports ${to} (${layerName(fromLayer)} -> ${layerName(toLayer)})`);
  }

  if (!isIndex(rel) && !isSupport(rel) && !GENERATED.has(rel)) {
    const n = runtimeExports(sf);
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
