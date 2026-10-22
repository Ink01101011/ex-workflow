import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCommand } from "./commands.ts";

async function project() {
  const root = await mkdtemp(path.join(tmpdir(), "exwf-cli-"));
  const w = async (name: string, data: unknown) => {
    const p = path.join(root, name);
    await writeFile(p, JSON.stringify(data));
    return p;
  };
  const cfg = await w("config.json", {
    sprintBudget: { tokens: 100000 },
    productGoal: "ship",
    definitionOfDone: [{ kind: "evidence", evidenceKind: "test-output" }],
  });
  return { root, w, cfg };
}
const out = <T>(r: { out: unknown }) => r.out as T;

test("init refuses twice and unknown commands exit 2", async () => {
  const { root, cfg } = await project();
  const r1 = await runCommand(["init", "scrum", "--config", cfg], root);
  assert.equal(r1.exit, 0);
  assert.deepEqual(out<{ state: { roles: string[] } }>(r1).state.roles, [
    "product-owner",
    "scrum-master",
    "developer",
  ]);
  const r2 = await runCommand(["init", "scrum", "--config", cfg], root);
  assert.equal(r2.exit, 1);
  assert.equal(out<{ error: { code: string } }>(r2).error.code, "invalid-input");
  assert.equal((await runCommand(["frobnicate"], root)).exit, 2);
  assert.equal((await runCommand([], root)).exit, 2);
});

test("full loop: add → ceremony plan → next → complete → status → board → metrics", async () => {
  const { root, w, cfg } = await project();
  await runCommand(["init", "scrum", "--config", cfg], root);
  const a = await w("a.json", { id: "A", title: "a", weight: 1, acceptance: ["ok"] });
  assert.equal((await runCommand(["add", a, "--by", "product-owner"], root)).exit, 0);
  const plan = await w("plan.json", { goal: "g", items: ["A"] });
  const rp = await runCommand(["ceremony", "plan", plan, "--by", "scrum-master"], root);
  assert.equal(rp.exit, 0);
  assert.equal(out<{ lastEvent: { type: string } }>(rp).lastEvent.type, "sprint.opened");
  const rn = await runCommand(["next"], root);
  assert.equal(rn.exit, 0);
  const briefs = out<{ briefs: Array<{ item: { id: string }; role: { id: string } }> }>(rn).briefs;
  assert.equal(briefs[0]!.item.id, "A");
  assert.equal(briefs[0]!.role.id, "developer");
  assert.ok(
    JSON.parse(await readFile(path.join(root, ".workflow", "briefs", "A.json"), "utf8")).item,
  );
  const h = await w("h.json", {
    item: "A",
    role: "developer",
    produced: [{ kind: "test-output", ref: "ci" }],
    notes: "done",
    do_not: [],
    open_questions: [],
  });
  const rc = await runCommand(
    [
      "complete",
      "A",
      h,
      "--tokens-in",
      "100",
      "--tokens-out",
      "50",
      "--duration-ms",
      "1000",
      "--model",
      "haiku",
    ],
    root,
  );
  assert.equal(rc.exit, 0);
  assert.equal(out<{ item: { status: string } }>(rc).item.status, "review");
  const st = out<{ counts: Record<string, number>; openIteration: { id: string } }>(
    await runCommand(["status"], root),
  );
  assert.equal(st.counts["review"], 1);
  assert.equal(st.openIteration.id, "S1");
  const board = out<{ columns: Array<{ stage: string; items: Array<{ id: string }> }> }>(
    await runCommand(["board"], root),
  );
  assert.equal(board.columns.find((c) => c.stage === "review")!.items[0]!.id, "A");
  const rev = await w("rev.json", { accepted: true, goalMet: true });
  assert.equal((await runCommand(["ceremony", "review", rev, "--by", "human"], root)).exit, 0);
  const metrics = out<{ metrics: { velocity: number[] } }>(await runCommand(["metrics"], root));
  assert.deepEqual(metrics.metrics.velocity, [0]); // A was in review, not done, at sprint end
});

test("validate reports violations without exit 1; role add/list; decide", async () => {
  const { root, w, cfg } = await project();
  await runCommand(["init", "scrum", "--config", cfg], root);
  const act = await w("act.json", {
    type: "ceremony.refine",
    by: "developer",
    payload: { items: [{ id: "A", patch: { priority: 1 } }] },
  });
  const rv = await runCommand(["validate", act], root);
  assert.equal(rv.exit, 0);
  assert.equal(
    out<{ violations: Array<{ rule: string }> }>(rv).violations[0]!.rule,
    "po-orders-backlog",
  );
  const role = await w("role.json", {
    id: "qa",
    name: "QA",
    modelTier: "small",
    capabilities: ["review", "verify"],
    canApprove: [],
    inputs: [],
    outputs: [],
    do_not: [],
  });
  assert.equal((await runCommand(["role", "add", role], root)).exit, 0);
  assert.ok(
    out<{ roles: string[] }>(await runCommand(["role", "list"], root)).roles.includes("qa"),
  );
  assert.equal((await runCommand(["decide", "p1", "approve", "--by", "human"], root)).exit, 1);
  assert.deepEqual(out<{ pending: unknown[] }>(await runCommand(["pending"], root)).pending, []);
});

test("add rejects ids that could escape the .workflow directory", async () => {
  const { root, w, cfg } = await project();
  await runCommand(["init", "scrum", "--config", cfg], root);
  for (const id of ["../evil", "a/b", "a\\b", "x..y"]) {
    const f = await w("bad.json", { id, title: "t", weight: 1, acceptance: ["ok"] });
    const r = await runCommand(["add", f], root);
    assert.equal(r.exit, 1);
    assert.equal(out<{ error: { code: string; fix: string } }>(r).error.code, "invalid-input");
    assert.match(out<{ error: { fix: string } }>(r).error.fix, /letters, digits/);
  }
});

test("ceremony with a prototype-key name is unknown-ceremony, not a crash", async () => {
  const { root, cfg } = await project();
  await runCommand(["init", "scrum", "--config", cfg], root);
  const r = await runCommand(["ceremony", "constructor"], root);
  assert.equal(r.exit, 1);
  assert.equal(out<{ error: { code: string } }>(r).error.code, "unknown-ceremony");
});

test("concurrent add commands do not lose updates", async () => {
  const { root, w, cfg } = await project();
  await runCommand(["init", "scrum", "--config", cfg], root);
  const ids = ["A", "B", "C", "D", "E", "F"];
  const files = await Promise.all(
    ids.map((id) => w(`${id}.json`, { id, title: id, weight: 1, acceptance: ["ok"] })),
  );
  const results = await Promise.all(files.map((f) => runCommand(["add", f], root)));
  assert.deepEqual(
    results.map((r) => r.exit),
    ids.map(() => 0),
  );
  const state = JSON.parse(await readFile(path.join(root, ".workflow", "state.json"), "utf8"));
  assert.deepEqual(new Set(Object.keys(state.items)), new Set(ids));
});

test("kanban: init → replenishment → next → complete → status report → board", async () => {
  const { root, w } = await project();
  const kcfg = await w("kanban.json", { cadences: { replenishment: { everyTurns: 1 } } });
  const r0 = await runCommand(["init", "kanban", "--config", kcfg], root);
  assert.equal(r0.exit, 0);
  assert.deepEqual(out<{ state: { stages: string[]; roles: string[] } }>(r0).state, {
    methodology: "kanban",
    stages: ["options", "ready", "dev", "review", "done"],
    roles: ["service-request-manager", "service-delivery-manager", "worker"],
  });
  const a = await w("ka.json", { id: "A", title: "a", acceptance: ["ok"] });
  assert.equal((await runCommand(["add", a, "--by", "service-request-manager"], root)).exit, 0);
  const rep = await w("rep.json", { items: ["A"] });
  const rr = await runCommand(
    ["ceremony", "replenishment", rep, "--by", "service-request-manager"],
    root,
  );
  assert.equal(rr.exit, 0);
  assert.equal(out<{ lastEvent: { type: string } }>(rr).lastEvent.type, "cadence.replenishment");
  const rn = await runCommand(["next"], root);
  const briefs = out<{
    briefs: Array<{ item: { id: string; stage: string }; role: { id: string } }>;
  }>(rn).briefs;
  assert.deepEqual(
    briefs.map((b) => [b.item.id, b.item.stage, b.role.id]),
    [["A", "dev", "worker"]],
  );
  const h = await w("kh.json", {
    item: "A",
    role: "worker",
    produced: [{ kind: "test-output", ref: "ci" }],
    notes: "done",
    do_not: [],
    open_questions: [],
  });
  const rc = await runCommand(
    [
      "complete",
      "A",
      h,
      "--tokens-in",
      "10",
      "--tokens-out",
      "5",
      "--duration-ms",
      "100",
      "--model",
      "small",
    ],
    root,
  );
  assert.equal(rc.exit, 0);
  assert.equal(out<{ item: { stage: string; status: string } }>(rc).item.stage, "review");
  const rs = await runCommand(["status"], root);
  const report = out<{
    report: {
      cadencesDue: Array<{
        cadence: string;
        everyTurns: number;
        lastAt: string | null;
        due: boolean;
        turnsSince: number;
      }>;
    };
  }>(rs).report;
  assert.equal(report.cadencesDue.length, 6);
  const repl = report.cadencesDue.find((c) => c.cadence === "replenishment")!;
  assert.equal(typeof repl.lastAt, "string");
  assert.ok(Number.isFinite(Date.parse(repl.lastAt!)));
  assert.deepEqual(
    { ...repl, lastAt: null },
    { cadence: "replenishment", everyTurns: 1, lastAt: null, turnsSince: 1, due: true },
  );
  const rb = await runCommand(["board"], root);
  const cols = out<{ columns: Array<{ stage: string; items: Array<{ id: string }> }> }>(rb).columns;
  assert.deepEqual(
    cols.find((c) => c.stage === "review")!.items.map((i) => i.id),
    ["A"],
  );
  const rm = await runCommand(["metrics"], root);
  assert.deepEqual(
    out<{ metrics: { wipByColumn: Record<string, number> } }>(rm).metrics.wipByColumn,
    { options: 0, ready: 0, dev: 0, review: 1, done: 0 },
  );
});

test("status.report is null for scrum", async () => {
  const { root, cfg } = await project();
  await runCommand(["init", "scrum", "--config", cfg], root);
  assert.equal(out<{ report: unknown }>(await runCommand(["status"], root)).report, null);
});
