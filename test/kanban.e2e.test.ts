import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, workflowStateSchema } from "../src/schema/index.ts";
import { addItem, clearBlocker, complete, getItem, init, next } from "../src/index.ts";
import { board, cadencesDue, kanban, kanbanMetrics } from "../src/kanban/index.ts";
import type { Accounting, Brief, Handoff, WorkflowError, WorkflowState } from "../src/index.ts";

const m = kanban();
const c = m.ceremonies;
const MIN = 60_000;
const config = {
  classesOfService: { standard: { sle: { percentile: 85, targetMs: 60 * MIN } } },
  cadences: { replenishment: { everyTurns: 4 } },
  throughputWindowMs: 60 * MIN,
};
let clock = Date.parse("2026-10-26T09:00:00.000Z");
const tick = () => new Date((clock += MIN)).toISOString();
const h = (item: string, role: string, over: Partial<Handoff> = {}): Handoff => ({
  item,
  role,
  produced: [{ kind: "test-output", ref: `ci/${item}` }],
  notes: `${item} done`,
  do_not: [],
  open_questions: [],
  ...over,
});
const acc = (item: string, role: string): Accounting => ({
  item,
  role,
  model: "small-worker",
  tokensIn: 300,
  tokensOut: 200,
  durationMs: 1000,
  startedAt: tick(),
  endedAt: tick(),
});
const finish = (s: WorkflowState, b: Brief, over: Partial<Handoff> = {}) =>
  complete(s, m, h(b.item.id, b.role.id, over), acc(b.item.id, b.role.id), tick()).state;
const byStage = (briefs: Brief[], stage: string) => briefs.filter((b) => b.item.stage === stage);

test("one kanban week with an expedite", () => {
  let s = init({ methodology: m, config, now: tick() }).state;
  const srm = "service-request-manager";
  const sdm = "service-delivery-manager";
  s = addItem(s, { id: "A", title: "search box", acceptance: ["finds by name"] }, srm, tick());
  s = addItem(s, { id: "B", title: "export csv", acceptance: ["downloads"] }, srm, tick());
  s = addItem(
    s,
    {
      id: "F",
      title: "tax rate change",
      acceptance: ["new rate applied"],
      classOfService: "fixed-date",
      deadline: new Date(clock + 120 * MIN).toISOString(),
    },
    srm,
    tick(),
  );
  s = addItem(
    s,
    {
      id: "I",
      title: "refactor logger",
      acceptance: ["no behaviour change"],
      classOfService: "intangible",
    },
    srm,
    tick(),
  );

  // Monday: replenish four options, tighten dev WIP to 2
  s = c["replenishment"]!(s, { by: srm, now: tick(), items: ["A", "B", "F", "I"] }).state;
  assert.equal(getItem(s, "A").stage, "ready");
  const sdr = c["service-delivery-review"]!(s, { by: sdm, now: tick(), wip: { dev: 2 } });
  assert.deepEqual(sdr.warnings, []);
  s = sdr.state;
  let r = next(s, m, { now: tick() });
  s = r.state;
  assert.equal(r.briefs.length, 2);
  assert.equal(r.reason, "wip-full");
  assert.ok(
    !r.briefs.some((b) => b.item.id === "I"),
    "intangible work waits while others are ready",
  );
  assert.ok(r.briefs.every((b) => b.item.stage === "dev" && b.role.id === "worker"));
  assert.match(r.briefs[0]!.invariants[2]!, /WIP limit of "Development": 2/);
  for (const b of r.briefs) s = finish(s, b);

  // Tuesday: two cards in review, two more pulled; an expedite arrives; a second expedite is refused
  r = next(s, m, { now: tick() });
  s = r.state;
  assert.equal(byStage(r.briefs, "review").length, 2);
  assert.equal(byStage(r.briefs, "dev").length, 2);
  s = addItem(
    s,
    { id: "E", title: "prod hotfix", acceptance: ["500s stop"], classOfService: "expedite" },
    srm,
    tick(),
  );
  s = addItem(
    s,
    { id: "X", title: "another hotfix", acceptance: ["ok"], classOfService: "expedite" },
    srm,
    tick(),
  );
  s = c["replenishment"]!(s, { by: srm, now: tick(), items: ["E"] }).state;
  assert.throws(
    () => c["replenishment"]!(s, { by: srm, now: tick(), items: ["X"] }),
    (e: unknown) =>
      (e as WorkflowError).code === "rule-violation" &&
      (e as WorkflowError).rule === "one-expedite",
  );
  for (const b of byStage(r.briefs, "review")) s = finish(s, b, { produced: [] }); // two deliveries
  const [devA, devB] = byStage(r.briefs, "dev");
  s = finish(s, devA!);
  s = finish(s, devB!, {
    verdict: "escalate",
    open_questions: ["which tax table version applies?"],
    produced: [],
  });
  const qid = `${devB!.item.id}-q1`;
  assert.equal(getItem(s, qid).role, srm);
  assert.equal(getItem(s, devB!.item.id).stage, "ready");
  assert.deepEqual(getItem(s, devB!.item.id).dependsOn, [qid]);

  // Wednesday: the question goes first, the expedite jumps the queue and bypasses WIP; the question is answered; a review completes
  r = next(s, m, { now: tick() });
  s = r.state;
  assert.equal(r.briefs[0]!.item.id, qid); // a question is dispatched before everything, then the expedite
  assert.equal(r.briefs[1]!.item.id, "E");
  assert.equal(r.briefs[1]!.item.stage, "dev");
  assert.ok(r.briefs.some((b) => b.item.id === qid && b.role.id === srm));
  assert.ok(
    !r.briefs.some((b) => b.item.id === devB!.item.id),
    "the parent waits for its question",
  );
  for (const b of r.briefs)
    s = finish(
      s,
      b,
      b.item.id === qid
        ? { produced: [], notes: "use table v7" }
        : b.item.stage === "review"
          ? { produced: [] }
          : {},
    );
  assert.equal(getItem(s, qid).status, "done");

  // Thursday: the parent resumes with the answer upstream, then gets blocked; operations-review assigns the blocker
  r = next(s, m, { now: tick() });
  s = r.state;
  const parent = r.briefs.find((b) => b.item.id === devB!.item.id)!;
  assert.deepEqual(
    parent.upstream.map((u) => [u.item, u.notes]),
    [[qid, "use table v7"]],
  );
  s = finish(s, parent, {
    verdict: "blocked",
    notes: "waiting for finance sign-off",
    produced: [],
  });
  for (const b of r.briefs.filter((x) => x.item.id !== parent.item.id))
    s = finish(s, b, b.item.stage === "review" ? { produced: [] } : {});
  const ops = c["operations-review"]!(s, {
    by: sdm,
    now: tick(),
    assign: [{ item: parent.item.id, blocker: `${parent.item.id}-b1`, owner: sdm }],
  });
  s = ops.state;
  assert.equal(
    (ops.state.events.at(-1)!.payload as { blockers: Array<{ owner: string }> }).blockers[0]!.owner,
    sdm,
  );
  s = clearBlocker(s, parent.item.id, `${parent.item.id}-b1`, sdm, tick());
  assert.equal(getItem(s, parent.item.id).stage, "ready");

  // Friday: drain the board; cadences
  for (let guard = 0; guard < 10; guard++) {
    r = next(s, m, { now: tick() });
    s = r.state;
    if (r.briefs.length === 0) break;
    for (const b of r.briefs) s = finish(s, b, b.item.stage === "review" ? { produced: [] } : {});
  }
  const risk = c["risk-review"]!(s, { by: sdm, now: tick() });
  s = risk.state;
  assert.deepEqual(risk.state.events.at(-1)!.payload, {
    fixedDate: [],
    staleBlockers: [],
    expediteActive: [],
  });
  s = c["delivery-planning"]!(s, {
    by: sdm,
    now: tick(),
    items: ["A", "B", "F", "I", "E"],
    window: "week-44",
  }).state;
  s = c["strategy-review"]!(s, {
    by: sdm,
    now: tick(),
    classesOfService: { expedite: { wipBypass: 2 } },
  }).state;

  // The board is empty, every card delivered, the metrics come from events alone
  const cols = board(s, tick());
  assert.deepEqual(
    cols.filter((col) => col.id !== "done").map((col) => col.cards.length),
    [1, 0, 0, 0],
  ); // X is still an option
  assert.equal(cols.find((col) => col.id === "done")!.cards.length, 6); // five deliveries and the answered question
  for (const id of ["A", "B", "F", "I", "E"]) assert.equal(getItem(s, id).status, "done");
  const mm = kanbanMetrics(s);
  assert.equal(mm.leadTimeMs.length, 5);
  assert.equal(
    mm.throughput.reduce((x, y) => x + y, 0),
    5,
  );
  assert.deepEqual(mm.wipByColumn, { options: 1, ready: 0, dev: 0, review: 0, done: 0 });
  assert.deepEqual(mm.sleCompliance, { standard: 1 });
  assert.ok(mm.flowEfficiency > 0 && mm.flowEfficiency <= 1);
  assert.ok(mm.blockerTimeMs > 0);
  assert.deepEqual(mm, kanbanMetrics({ ...s, items: {}, iterations: [], accounting: [] }));
  assert.equal(cadencesDue(s).find((d) => d.cadence === "replenishment")!.due, true);
  const types = s.events.map((e) => e.type);
  for (const t of [
    "cadence.replenishment",
    "cadence.service-delivery-review",
    "item.escalated",
    "blocker.reassigned",
    "cadence.operations-review",
    "cadence.risk-review",
    "cadence.delivery-planning",
    "cadence.strategy-review",
  ])
    assert.ok(types.includes(t), `missing event ${t}`);
  // §14: the generated schema validates the fixture in the form loadState() sees
  assertValid(workflowStateSchema, JSON.parse(JSON.stringify(s)), "final scenario state");
});
