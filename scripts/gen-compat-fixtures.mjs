// Regenerates test/fixtures/compat/<version>/<methodology>/ with the published CLI of every stage release.
// Needs the npm registry (network); the fixtures themselves are committed. Run: node scripts/gen-compat-fixtures.mjs
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "test", "fixtures", "compat");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

// 0.5.0-stage was never published to npm (versions: 0.1.0 .. 0.4.0, 0.6.0), so it has no fixture.
// version -> methodologies it ships (scrum 0.1.0, kanban 0.2.0, waterfall 0.3.0)
const VERSIONS = {
  "0.1.0-stage": ["scrum"],
  "0.2.0-stage": ["scrum", "kanban"],
  "0.3.0-stage": ["scrum", "kanban", "waterfall"],
  "0.4.0-stage": ["scrum", "kanban", "waterfall"],
  "0.6.0-stage": ["scrum", "kanban", "waterfall"],
};
const MIN = 60_000;
const CONFIGS = {
  scrum: {
    sprintBudget: { tokens: 100000 },
    productGoal: "ship the checkout",
    definitionOfDone: [{ kind: "evidence", evidenceKind: "test-output" }],
  },
  kanban: {
    classesOfService: { standard: { sle: { percentile: 85, targetMs: 60 * MIN } } },
    cadences: { replenishment: { everyTurns: 4 } },
    throughputWindowMs: 60 * MIN,
  },
  waterfall: {
    phases: [
      { id: "requirements" },
      { id: "design" },
      { id: "implementation", budget: { tokens: 5000 } },
      { id: "verification" },
      { id: "deployment" },
      { id: "maintenance" },
    ],
  },
};
const ITEMS = [
  { id: "A1", title: "first item", weight: 3, priority: 5, acceptance: ["it works"] },
  { id: "A2", title: "second item", priority: 1, acceptance: ["it is documented"] },
];

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, {
    cwd,
    // npm.cmd needs a shell on Windows since the CVE-2024-27980 fix; node itself never does
    shell: cmd === npm && process.platform === "win32",
    encoding: "utf8",
  });
  if (r.status !== 0)
    throw new Error(`${cmd} ${args.join(" ")} failed in ${cwd}: ${r.stderr || r.stdout || r.error}`);
  return r.stdout;
}
const writeJson = (file, v) => writeFileSync(file, JSON.stringify(v, null, 2));

for (const [version, methodologies] of Object.entries(VERSIONS)) {
  const tool = mkdtempSync(join(tmpdir(), `exwf-gen-${version}-`));
  writeJson(join(tool, "package.json"), { name: "gen", version: "0.0.0", private: true });
  run(npm, ["install", "--no-save", "--no-audit", "--no-fund", `ex-workflow@${version}`], tool);
  const bin = join(tool, "node_modules", "ex-workflow", "dist", "cli", "bin.cjs");
  for (const m of methodologies) {
    const dir = mkdtempSync(join(tmpdir(), `exwf-gen-${version}-${m}-`));
    const exwf = (...args) => run(process.execPath, [bin, ...args], dir);
    writeJson(join(dir, "config.json"), CONFIGS[m]);
    exwf("init", m, "--config", "config.json");
    ITEMS.forEach((item, i) => {
      writeJson(join(dir, `item${i}.json`), m === "waterfall" ? { ...item, phase: "requirements" } : item);
      exwf("add", `item${i}.json`);
    });
    if (m === "scrum") {
      writeJson(join(dir, "plan.json"), { goal: "customers can pay", items: ["A1"] });
      exwf("ceremony", "plan", "plan.json", "--by", "scrum-master");
    }
    const dest = join(out, version, m);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    cpSync(join(dir, ".workflow", "state.json"), join(dest, "state.json"));
    const roles = join(dir, ".workflow", "roles");
    if (existsSync(roles)) cpSync(roles, join(dest, "roles"), { recursive: true });
    console.log(`${version}/${m}${existsSync(roles) ? ` (+${readdirSync(roles).length} roles)` : ""}`);
    rmSync(dir, { recursive: true, force: true });
  }
  rmSync(tool, { recursive: true, force: true });
}
