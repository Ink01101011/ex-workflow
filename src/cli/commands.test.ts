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
const T_RAISED = "2026-10-19T00:00:00.000Z";
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
  const a = await w("a.json", {
    id: "A",
    title: "a",
    weight: 1,
    acceptance: ["ok"],
  });
  assert.equal((await runCommand(["add", a, "--by", "product-owner"], root)).exit, 0);
  const plan = await w("plan.json", { goal: "g", items: ["A"] });
  const rp = await runCommand(["ceremony", "plan", plan, "--by", "scrum-master"], root);
  assert.equal(rp.exit, 0);
  assert.equal(out<{ lastEvent: { type: string } }>(rp).lastEvent.type, "sprint.opened");
  const rn = await runCommand(["next"], root);
  assert.equal(rn.exit, 0);
  const briefs = out<{
    briefs: Array<{ item: { id: string }; role: { id: string } }>;
  }>(rn).briefs;
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
  const st = out<{
    counts: Record<string, number>;
    openIteration: { id: string };
  }>(await runCommand(["status"], root));
  assert.equal(st.counts["review"], 1);
  assert.equal(st.openIteration.id, "S1");
  const board = out<{
    columns: Array<{ stage: string; items: Array<{ id: string }> }>;
  }>(await runCommand(["board"], root));
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
    const f = await w("bad.json", {
      id,
      title: "t",
      weight: 1,
      acceptance: ["ok"],
    });
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
  const kcfg = await w("kanban.json", {
    cadences: { replenishment: { everyTurns: 1 } },
  });
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
    briefs: Array<{
      item: { id: string; stage: string };
      role: { id: string };
    }>;
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
    {
      cadence: "replenishment",
      everyTurns: 1,
      lastAt: null,
      turnsSince: 1,
      due: true,
    },
  );
  const rb = await runCommand(["board"], root);
  const cols = out<{
    columns: Array<{ stage: string; items: Array<{ id: string }> }>;
  }>(rb).columns;
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

test("add and edit are checked by methodology rules and surface rule violations", async () => {
  const { root, w, cfg } = await project();
  await runCommand(["init", "scrum", "--config", cfg], root);
  const a = await w("a2.json", {
    id: "A",
    title: "a",
    weight: 1,
    acceptance: ["ok"],
  });
  const ra = await runCommand(["add", a, "--by", "product-owner"], root);
  assert.equal(ra.exit, 0);
  assert.equal(out<{ item: { id: string } }>(ra).item.id, "A");
  const p = await w("p2.json", { title: "a renamed" });
  const re = await runCommand(["edit", "A", p, "--by", "product-owner"], root);
  assert.equal(re.exit, 0);
  assert.equal(out<{ item: { title: string } }>(re).item.title, "a renamed");
  const same = await w("p3.json", { title: "a renamed" });
  const rn = await runCommand(["edit", "A", same, "--by", "product-owner"], root);
  assert.equal(rn.exit, 1);
  assert.equal(out<{ error: { code: string } }>(rn).error.code, "no-op");
});

test("waterfall: init → add → kickoff → next/complete ×2 → status → gateReview → decide → frozen edit refused", async () => {
  const { root, w } = await project();
  const wcfg = await w("waterfall.json", {});
  const r0 = await runCommand(["init", "waterfall", "--config", wcfg], root);
  assert.equal(r0.exit, 0);
  assert.deepEqual(
    out<{ state: { methodology: string; stages: string[]; roles: string[] } }>(r0).state,
    {
      methodology: "waterfall",
      stages: ["work", "review", "done"],
      roles: [
        "project-manager",
        "developer",
        "business-analyst",
        "architect",
        "qa",
        "release-manager",
      ],
    },
  );
  const noPhase = await w("np.json", { id: "X", title: "x" });
  const rx = await runCommand(["add", noPhase, "--by", "business-analyst"], root);
  assert.equal(rx.exit, 1);
  assert.equal(out<{ error: { code: string; rule: string } }>(rx).error.rule, "phase-sequential");
  const r1 = await w("r1.json", {
    id: "R1",
    title: "login",
    phase: "requirements",
    acceptance: ["ok"],
  });
  assert.equal((await runCommand(["add", r1, "--by", "business-analyst"], root)).exit, 0);
  const k = await w("k.json", { phase: "requirements" });
  const rk = await runCommand(["ceremony", "kickoff", k, "--by", "project-manager"], root);
  assert.equal(rk.exit, 0);
  assert.equal(out<{ lastEvent: { type: string } }>(rk).lastEvent.type, "phase.opened");
  const rn = await runCommand(["next"], root);
  const briefs = out<{
    briefs: Array<{
      item: { id: string; stage: string };
      role: { id: string };
    }>;
  }>(rn).briefs;
  assert.deepEqual(
    briefs.map((b) => [b.item.id, b.item.stage, b.role.id]),
    [["R1", "work", "business-analyst"]],
  );
  const h1 = await w("wh1.json", {
    item: "R1",
    role: "business-analyst",
    produced: [{ kind: "srs", ref: "docs/srs.md" }],
    notes: "done",
    do_not: [],
    open_questions: [],
  });
  const rc = await runCommand(
    [
      "complete",
      "R1",
      h1,
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
  const rn2 = await runCommand(["next"], root);
  assert.deepEqual(
    out<{ briefs: Array<{ role: { id: string } }> }>(rn2).briefs.map((b) => b.role.id),
    ["qa"],
  );
  const h2 = await w("wh2.json", {
    item: "R1",
    role: "qa",
    produced: [],
    notes: "reviewed",
    do_not: [],
    open_questions: [],
  });
  assert.equal(
    (
      await runCommand(
        [
          "complete",
          "R1",
          h2,
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
      )
    ).exit,
    0,
  );
  type Report = {
    phases: Array<{ id: string; status: string; readyForGate: boolean }>;
    current: string | null;
    open: string | null;
    pendingGates: unknown[];
    coverage: { traced: number; total: number };
  };
  let report = out<{ report: Report }>(await runCommand(["status"], root)).report;
  assert.deepEqual(
    [report.current, report.open, report.phases[0]!.status, report.phases[0]!.readyForGate],
    ["requirements", "requirements", "open", true],
  );
  const g = await w("g.json", { phase: "requirements" });
  const rg = await runCommand(["ceremony", "gateReview", g, "--by", "project-manager"], root);
  assert.equal(rg.exit, 0);
  assert.equal(out<{ lastEvent: { type: string } }>(rg).lastEvent.type, "phase.gate-pending");
  const pending = out<{ pending: Array<{ id: string; kind: string }> }>(
    await runCommand(["pending"], root),
  ).pending;
  assert.deepEqual(
    pending.map((p) => [p.id, p.kind]),
    [["p1", "gate"]],
  );
  const rd = await runCommand(["decide", "p1", "approve", "--by", "human", "--note", "ok"], root);
  assert.equal(rd.exit, 0);
  report = out<{ report: Report }>(await runCommand(["status"], root)).report;
  assert.deepEqual(
    [report.current, report.open, report.phases[0]!.status, report.pendingGates, report.coverage],
    ["design", null, "baselined", [], { traced: 0, total: 1 }],
  );
  const patch = await w("wp.json", { title: "login (v2)" });
  const re = await runCommand(["edit", "R1", patch, "--by", "business-analyst"], root);
  assert.equal(re.exit, 1);
  const error = out<{ error: { code: string; rule: string; fix: string } }>(re).error;
  assert.equal(error.code, "rule-violation");
  assert.equal(error.rule, "baseline-immutable");
  assert.match(error.fix, /change-request/);
  const rm = await runCommand(["metrics"], root);
  assert.equal(
    out<{ metrics: { phaseCompletion: Record<string, number> } }>(rm).metrics.phaseCompletion[
      "requirements"
    ],
    100,
  );
});

test("add, edit, complete and role add refuse files that fail their schema before touching the state", async () => {
  const { root, w, cfg } = await project();
  assert.equal((await runCommand(["init", "scrum", "--config", cfg], root)).exit, 0);
  const statePath = path.join(root, ".workflow", "state.json");
  await w("item-a.json", { id: "A", title: "a" });
  assert.equal((await runCommand(["add", "item-a.json"], root)).exit, 0);
  const before = await readFile(statePath, "utf8");

  await w("bad-item.json", { id: "B", title: "b", type: "feature" });
  const add = await runCommand(["add", "bad-item.json"], root);
  assert.equal(add.exit, 1);
  assert.equal(out<{ error: { code: string } }>(add).error.code, "invalid-input");
  assert.match(
    out<{ error: { message: string } }>(add).error.message,
    /bad-item\.json does not match its schema: \/type expected one of/,
  );

  await w("bad-patch.json", { foo: 1, priority: "high" });
  const edit = await runCommand(["edit", "A", "bad-patch.json"], root);
  assert.equal(edit.exit, 1);
  assert.equal(out<{ error: { code: string } }>(edit).error.code, "invalid-input");
  assert.match(
    out<{ error: { message: string } }>(edit).error.message,
    /bad-patch\.json does not match its schema: \/foo unknown property/,
  );

  await w("bad-handoff.json", {
    item: "A",
    role: "developer",
    produced: [],
    notes: "n",
  });
  const done = await runCommand(
    [
      "complete",
      "A",
      "bad-handoff.json",
      "--tokens-in",
      "1",
      "--tokens-out",
      "1",
      "--duration-ms",
      "1",
      "--model",
      "m",
    ],
    root,
  );
  assert.equal(done.exit, 1);
  assert.match(
    out<{ error: { message: string } }>(done).error.message,
    /bad-handoff\.json does not match its schema: \/do_not missing required property/,
  );

  await w("bad-role.json", { id: "qa", name: "QA" });
  const role = await runCommand(["role", "add", "bad-role.json"], root);
  assert.equal(role.exit, 1);
  assert.match(
    out<{ error: { message: string } }>(role).error.message,
    /bad-role\.json does not match its schema: \/modelTier missing required property/,
  );

  assert.equal(await readFile(statePath, "utf8"), before);
});

test("init --roles refuses a roles file that fails the schema", async () => {
  const { root, w, cfg } = await project();
  await w("roles.json", [
    {
      id: "dev",
      name: "Dev",
      modelTier: "small",
      capabilities: ["deliver"],
      canApprove: [],
      inputs: [],
      outputs: [],
      do_not: [],
    },
    { id: "qa", name: "QA" },
  ]);
  const r = await runCommand(["init", "scrum", "--config", cfg, "--roles", "roles.json"], root);
  assert.equal(r.exit, 1);
  assert.equal(out<{ error: { code: string } }>(r).error.code, "invalid-input");
  assert.match(
    out<{ error: { message: string } }>(r).error.message,
    /roles\.json does not match its schema: \/modelTier missing required property/,
  );
  await assert.rejects(readFile(path.join(root, ".workflow", "state.json"), "utf8"));
});

test("init --roles refuses a roles file that is not an array, with a WorkflowError", async () => {
  const { root, w, cfg } = await project();
  await w("roles.json", { id: "dev", name: "Dev" });
  const r = await runCommand(["init", "scrum", "--config", cfg, "--roles", "roles.json"], root);
  assert.equal(r.exit, 1);
  assert.equal(out<{ error: { code: string } }>(r).error.code, "invalid-input");
  assert.match(
    out<{ error: { message: string } }>(r).error.message,
    /roles\.json must contain an array of role manifests/,
  );
});

test("next --fallback-tokens-per-weight prices a candidate when there is no history", async () => {
  const { root, w } = await project();
  const cfg = await w("tight.json", {
    sprintBudget: { tokens: 100 },
    productGoal: "ship",
    definitionOfDone: [{ kind: "evidence", evidenceKind: "test-output" }],
  });
  await runCommand(["init", "scrum", "--config", cfg], root);
  const a = await w("a.json", {
    id: "A",
    title: "a",
    weight: 1,
    acceptance: ["ok"],
  });
  await runCommand(["add", a, "--by", "product-owner"], root);
  const plan = await w("plan.json", { goal: "g", items: ["A"] });
  assert.equal(
    (await runCommand(["ceremony", "plan", plan, "--by", "scrum-master"], root)).exit,
    0,
  );
  const r1 = await runCommand(["next"], root);
  assert.equal(out<{ reason: string }>(r1).reason, "budget-exhausted");
  assert.equal(out<{ briefs: unknown[] }>(r1).briefs.length, 0);
  const r2 = await runCommand(["next", "--fallback-tokens-per-weight", "10"], root);
  assert.equal(out<{ briefs: unknown[] }>(r2).briefs.length, 1);
});

test("complete refuses 0 tokens without --estimate; account corrects the placeholder", async () => {
  const { root, w, cfg } = await project();
  await runCommand(["init", "scrum", "--config", cfg], root);
  const a = await w("a.json", {
    id: "A",
    title: "a",
    weight: 1,
    acceptance: ["ok"],
  });
  await runCommand(["add", a, "--by", "product-owner"], root);
  const plan = await w("plan.json", { goal: "g", items: ["A"] });
  await runCommand(["ceremony", "plan", plan, "--by", "scrum-master"], root);
  await runCommand(["next"], root);
  const h = await w("h.json", {
    item: "A",
    role: "developer",
    produced: [{ kind: "test-output", ref: "ci" }],
    notes: "done",
    do_not: [],
    open_questions: [],
  });
  const zero = [
    "complete",
    "A",
    h,
    "--tokens-in",
    "0",
    "--tokens-out",
    "0",
    "--duration-ms",
    "0",
    "--model",
    "haiku",
  ];
  const refused = await runCommand(zero, root);
  assert.equal(refused.exit, 1);
  assert.equal(out<{ error: { code: string } }>(refused).error.code, "accounting-invalid");
  assert.equal((await runCommand([...zero, "--estimate"], root)).exit, 0);
  const ra = await runCommand(
    ["account", "A", "--tokens-in", "500", "--tokens-out", "100", "--by", "human"],
    root,
  );
  assert.equal(ra.exit, 0);
  const res = out<{
    line: { tokensIn: number; estimate?: boolean };
    event: { type: string };
  }>(ra);
  assert.equal(res.line.tokensIn, 500);
  assert.equal(res.line.estimate, undefined);
  assert.equal(res.event.type, "accounting.corrected");
  const metrics = out<{ metrics: { current: Record<string, number> } }>(
    await runCommand(["metrics"], root),
  );
  assert.equal(metrics.metrics.current["spentTokens"], 600);
  assert.equal(
    (await runCommand(["account", "A", "--line", "9", "--tokens-in", "1"], root)).exit,
    1,
  );
  assert.equal((await runCommand(["account"], root)).exit, 2);
});

async function oneItemDone(
  root: string,
  w: (n: string, d: unknown) => Promise<string>,
  cfg: string,
) {
  await runCommand(["init", "scrum", "--config", cfg], root);
  const a = await w("a.json", { id: "A", title: "a", weight: 1, acceptance: ["ok"] });
  await runCommand(["add", a, "--by", "product-owner"], root);
  const plan = await w("plan.json", { goal: "g", items: ["A"] });
  await runCommand(["ceremony", "plan", plan, "--by", "scrum-master"], root);
  await runCommand(["next"], root);
  return a;
}
const doneFlags = [
  "--tokens-in",
  "100",
  "--tokens-out",
  "50",
  "--duration-ms",
  "1000",
  "--model",
  "haiku",
];

test("config set changes the budget between sprints (the #8 repro) and is refused while a sprint is open", async () => {
  const { root, w, cfg } = await project();
  await oneItemDone(root, w, cfg);
  const patch = await w("patch.json", { sprintBudget: { tokens: 1500000 } });
  const open = await runCommand(["config", "set", patch], root);
  assert.equal(open.exit, 1);
  assert.equal(out<{ error: { code: string } }>(open).error.code, "invalid-input");
  const h = await w("h.json", {
    item: "A",
    role: "developer",
    produced: [{ kind: "test-output", ref: "ci" }],
    notes: "done",
    do_not: [],
    open_questions: [],
  });
  assert.equal((await runCommand(["complete", "A", h, ...doneFlags], root)).exit, 0);
  const rev = await w("rev.json", { accepted: true, goalMet: true });
  assert.equal((await runCommand(["ceremony", "review", rev, "--by", "human"], root)).exit, 0);
  const retro = await w("retro.json", { lessons: [] });
  assert.equal(
    (await runCommand(["ceremony", "retro", retro, "--by", "scrum-master"], root)).exit,
    0,
  );
  const set = await runCommand(["config", "set", patch], root);
  assert.equal(set.exit, 0);
  assert.deepEqual(out<{ changed: string[] }>(set).changed, ["sprintBudget"]);
  const b = await w("b.json", { id: "B", title: "b", weight: 1, acceptance: ["ok"] });
  await runCommand(["add", b, "--by", "product-owner"], root);
  const plan2 = await w("plan2.json", { goal: "g2", items: ["B"], budget: { tokens: 1500000 } });
  assert.equal(
    (await runCommand(["ceremony", "plan", plan2, "--by", "scrum-master"], root)).exit,
    0,
  );
  assert.equal((await runCommand(["config", "bogus"], root)).exit, 2);
});

test("unblock clears an open blocker with a note and re-queues the item", async () => {
  const { root, w, cfg } = await project();
  await oneItemDone(root, w, cfg);
  const h = await w("h.json", {
    item: "A",
    role: "developer",
    produced: [],
    notes: "stuck",
    do_not: [],
    open_questions: [],
    verdict: "blocked",
  });
  const rc = await runCommand(["complete", "A", h, ...doneFlags], root);
  assert.equal(rc.exit, 0);
  assert.equal(out<{ item: { status: string } }>(rc).item.status, "blocked");
  const r = await runCommand(["unblock", "A", "--note", "fixed"], root);
  assert.equal(r.exit, 0);
  assert.equal(out<{ item: { status: string } }>(r).item.status, "todo");
  const again = await runCommand(["unblock", "A"], root);
  assert.equal(again.exit, 1);
  assert.equal(out<{ error: { code: string } }>(again).error.code, "invalid-input");
  const state = JSON.parse(await readFile(path.join(root, ".workflow", "state.json"), "utf8"));
  const ev = state.events.filter((e: { type: string }) => e.type === "blocker.cleared").at(-1);
  assert.equal(ev.payload.note, "fixed");
});

test("unblock --blocker clears only the named open blocker; an unknown id is refused", async () => {
  const { root, w, cfg } = await project();
  await oneItemDone(root, w, cfg);
  const h = await w("h.json", {
    item: "A",
    role: "developer",
    produced: [],
    notes: "stuck",
    do_not: [],
    open_questions: [],
    verdict: "blocked",
  });
  assert.equal((await runCommand(["complete", "A", h, ...doneFlags], root)).exit, 0);
  const statePath = path.join(root, ".workflow", "state.json");
  const st = JSON.parse(await readFile(statePath, "utf8"));
  st.items["A"].blockers.push({ id: "A-b2", reason: "second", owner: "human", raisedAt: T_RAISED });
  await writeFile(statePath, JSON.stringify(st));
  const unknown = await runCommand(["unblock", "A", "--blocker", "nope"], root);
  assert.equal(unknown.exit, 1);
  assert.equal(out<{ error: { code: string } }>(unknown).error.code, "invalid-input");
  const r = await runCommand(["unblock", "A", "--blocker", "A-b2"], root);
  assert.equal(r.exit, 0);
  assert.equal(out<{ item: { status: string } }>(r).item.status, "blocked");
  const after = JSON.parse(await readFile(statePath, "utf8"));
  const open = after.items["A"].blockers.filter((b: { clearedAt?: string }) => !b.clearedAt);
  assert.deepEqual(
    open.map((b: { id: string }) => b.id),
    ["A-b1"],
  );
});

test("complete warns about ignored open questions and status lists them", async () => {
  const { root, w, cfg } = await project();
  await runCommand(["init", "scrum", "--config", cfg], root);
  const a = await w("a.json", { id: "A", title: "a", weight: 1, acceptance: ["ok"] });
  await runCommand(["add", a, "--by", "product-owner"], root);
  const plan = await w("plan.json", { goal: "g", items: ["A"] });
  await runCommand(["ceremony", "plan", plan, "--by", "scrum-master"], root);
  await runCommand(["next"], root);
  const h = await w("h.json", {
    item: "A",
    role: "developer",
    produced: [{ kind: "test-output", ref: "ci" }],
    notes: "done",
    do_not: [],
    open_questions: ["which PO?"],
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
  assert.equal(
    out<{ warnings: Array<{ rule: string }> }>(rc).warnings[0]!.rule,
    "open-questions-ignored",
  );
  const st = out<{ openQuestions: Array<{ item: string; questions: string[] }> }>(
    await runCommand(["status"], root),
  );
  assert.equal(st.openQuestions[0]!.item, "A");
  assert.deepEqual(st.openQuestions[0]!.questions, ["which PO?"]);
});
