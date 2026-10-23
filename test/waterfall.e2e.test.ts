import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, workflowStateSchema } from "../src/schema/index.ts";
import {
  addItem,
  applyAction,
  complete,
  decide,
  editItem,
  getItem,
  init,
  next,
} from "../src/index.ts";
import {
  phasesOf,
  traceabilityMatrix,
  waterfall,
  waterfallMetrics,
} from "../src/waterfall/index.ts";
import type {
  Accounting,
  Brief,
  Handoff,
  ItemPatch,
  NewItem,
  WorkflowError,
  WorkflowState,
} from "../src/index.ts";

const m = waterfall();
const c = m.ceremonies;
const pm = "project-manager";
let clock = Date.parse("2026-11-02T09:00:00.000Z");
const tick = () => new Date((clock += 60_000)).toISOString();
const config = {
  phases: [
    { id: "requirements" },
    { id: "design" },
    { id: "implementation", budget: { tokens: 5000 } },
    { id: "verification" },
    { id: "deployment" },
    { id: "maintenance" },
  ],
};
const h = (b: Brief, kinds: string[]): Handoff => ({
  item: b.item.id,
  role: b.role.id,
  produced: kinds.map((k) => ({ kind: k, ref: `${b.item.id}/${k}` })),
  notes: `${b.item.id} by ${b.role.id}`,
  do_not: [],
  open_questions: [],
});
const acc = (b: Brief): Accounting => ({
  item: b.item.id,
  role: b.role.id,
  model: "small-worker",
  tokensIn: 300,
  tokensOut: 200,
  durationMs: 1000,
  startedAt: tick(),
  endedAt: tick(),
});
/** Everything ready in the open phase: work it, then review it. */
function workAll(s: WorkflowState, kinds: string[]): WorkflowState {
  for (let round = 0; round < 2; round++) {
    const r = next(s, m, { now: tick() });
    s = r.state;
    assert.ok(
      r.briefs.length > 0,
      `round ${round}: nothing dispatched (${r.reason ?? "no reason"})`,
    );
    for (const b of r.briefs)
      s = complete(s, m, h(b, round === 0 ? kinds : []), acc(b), tick()).state;
  }
  return s;
}
/** add/edit through the methodology rules, as the CLI does. */
const add = (s: WorkflowState, item: NewItem, by: string) =>
  applyAction(s, m, { type: "item.add", by, payload: { item } }, (x) =>
    addItem(x, item, by, tick()),
  ).state;
const edit = (s: WorkflowState, id: string, patch: ItemPatch, by: string) =>
  applyAction(s, m, { type: "item.edit", by, payload: { id, patch } }, (x) =>
    editItem(x, id, patch, by, tick()),
  ).state;
/** gateReview by the PM, then the human approves the pending gate. */
function gate(s: WorkflowState, phase: string): WorkflowState {
  s = c["gateReview"]!(s, { by: pm, now: tick(), phase }).state;
  const p = s.pending[s.pending.length - 1]!;
  assert.equal(p.kind, "gate");
  return decide(s, p.id, "approve", "human", `gate ${phase} ok`, tick(), m);
}
const statuses = (s: WorkflowState) => phasesOf(s).map((p) => p.status);
const isRule = (rule: string) => (e: unknown) =>
  (e as WorkflowError).code === "rule-violation" && (e as WorkflowError).rule === rule;

test("one waterfall project with a change request", () => {
  let s = init({ methodology: m, config, now: tick() }).state;
  assert.throws(
    () => add(s, { id: "X", title: "no phase", weight: 1 }, "business-analyst"),
    isRule("phase-sequential"),
  );

  // requirements
  s = add(
    s,
    { id: "R1", title: "login", phase: "requirements", weight: 1, acceptance: ["user can log in"] },
    "business-analyst",
  );
  s = add(
    s,
    { id: "R2", title: "export", phase: "requirements", weight: 1, acceptance: ["csv downloads"] },
    "business-analyst",
  );
  s = c["kickoff"]!(s, { by: pm, now: tick(), phase: "requirements" }).state;
  s = workAll(s, ["srs"]);
  s = gate(s, "requirements");
  assert.deepEqual(statuses(s), [
    "baselined",
    "pending",
    "pending",
    "pending",
    "pending",
    "pending",
  ]);
  assert.deepEqual(
    [s.baseline!.phase, s.baseline!.version, s.baseline!.approvedBy],
    ["requirements", 1, [pm, "human"]],
  );
  assert.equal(s.iterations[0]!.spent.tokens, 2000);
  assert.throws(
    () => edit(s, "R1", { title: "login (sso)" }, "business-analyst"),
    isRule("baseline-immutable"),
  );

  // design
  s = add(
    s,
    { id: "D1", title: "auth design", phase: "design", weight: 1, traces: ["R1", "R2"] },
    "architect",
  );
  s = c["kickoff"]!(s, { by: pm, now: tick(), phase: "design" }).state;
  s = workAll(s, ["design-doc", "interface-spec"]);
  s = gate(s, "design");

  // implementation, with a token budget
  s = add(
    s,
    { id: "I1", title: "build auth", phase: "implementation", weight: 1, dependsOn: ["D1"] },
    "developer",
  );
  s = c["kickoff"]!(s, { by: pm, now: tick(), phase: "implementation" }).state;
  const r = next(s, m, { now: tick() });
  assert.deepEqual(
    r.briefs.map((b) => [b.item.id, b.role.id, b.budgetRemaining]),
    [["I1", "developer", { tokens: 5000 }]],
  );
  s = complete(r.state, m, h(r.briefs[0]!, ["code-baseline"]), acc(r.briefs[0]!), tick()).state;
  const r2 = next(s, m, { now: tick() });
  s = complete(r2.state, m, h(r2.briefs[0]!, []), acc(r2.briefs[0]!), tick()).state;
  s = gate(s, "implementation");
  assert.equal(s.iterations.find((i) => i.id === "implementation#1")!.spent.tokens, 1000);

  // verification opens; a change-request arrives
  s = add(
    s,
    { id: "V1", title: "auth tests", phase: "verification", weight: 1, traces: ["R1", "R2"] },
    "developer",
  );
  s = c["kickoff"]!(s, { by: pm, now: tick(), phase: "verification" }).state;
  const cr1: NewItem = {
    id: "CR-1",
    title: "export needs pdf too",
    type: "change-request",
    affects: ["R2"],
  };
  assert.throws(() => add(s, cr1, "qa"), isRule("change-needs-impact-analysis")); // refused at add (#24)
  s = addItem(s, cr1, "qa", tick()); // direct addItem stays unguarded: the board still checks
  assert.throws(
    () => c["changeControlBoard"]!(s, { by: pm, now: tick(), change: "CR-1", decision: "approve" }),
    isRule("change-needs-impact-analysis"),
  );
  s = edit(
    s,
    "CR-1",
    {
      impactAnalysis: {
        summary: "pdf export changes the requirement and the design",
        reopen: ["requirements", "design"],
        weight: 3,
      },
    },
    "qa",
  );
  s = c["changeControlBoard"]!(s, {
    by: pm,
    now: tick(),
    change: "CR-1",
    decision: "approve",
    note: "customer commitment",
  }).state;
  assert.equal(getItem(s, "CR-1").status, "awaiting_human");
  const crPending = s.pending[s.pending.length - 1]!;
  assert.deepEqual([crPending.id, crPending.kind, crPending.item], ["p4", "decision", "CR-1"]);
  s = decide(s, crPending.id, "approve", "human", "agreed", tick(), m);
  assert.equal(getItem(s, "CR-1").status, "done");
  assert.deepEqual(statuses(s), [
    "reopened",
    "reopened",
    "baselined",
    "reopened",
    "pending",
    "pending",
  ]);
  assert.equal(s.iterations.find((i) => i.id === "verification#1")!.outcome, "cancelled");
  assert.throws(
    () => c["kickoff"]!(s, { by: pm, now: tick(), phase: "verification" }),
    isRule("gate-before-next-phase"),
  );

  // rework: requirements v2, design v2
  s = c["kickoff"]!(s, { by: pm, now: tick(), phase: "requirements" }).state;
  s = add(
    s,
    {
      id: "R3",
      title: "pdf export",
      phase: "requirements",
      weight: 1,
      parent: "CR-1",
      acceptance: ["pdf downloads"],
    },
    "business-analyst",
  );
  s = edit(s, "R1", { title: "login (sso)" }, "business-analyst"); // editable again while reopened
  s = workAll(s, ["srs"]);
  s = gate(s, "requirements");
  assert.deepEqual([s.baseline!.phase, s.baseline!.version], ["requirements", 2]);
  s = c["kickoff"]!(s, { by: pm, now: tick(), phase: "design" }).state;
  s = add(
    s,
    { id: "D2", title: "pdf design", phase: "design", weight: 1, traces: ["R3"] },
    "architect",
  );
  s = workAll(s, ["design-doc", "interface-spec"]);
  s = gate(s, "design");
  assert.deepEqual([s.baseline!.phase, s.baseline!.version], ["design", 2]);
  assert.deepEqual(statuses(s), [
    "baselined",
    "baselined",
    "baselined",
    "reopened",
    "pending",
    "pending",
  ]);

  // verification again, with the matrix
  s = c["kickoff"]!(s, { by: pm, now: tick(), phase: "verification" }).state;
  assert.equal(s.iterations[s.iterations.length - 1]!.id, "verification#2");
  s = add(
    s,
    { id: "V2", title: "pdf tests", phase: "verification", weight: 1, traces: ["R3"] },
    "developer",
  );
  s = workAll(s, ["test-report"]);
  s = gate(s, "verification");
  const matrix = traceabilityMatrix(s);
  assert.deepEqual(matrix.coverage, { traced: 3, total: 3 });
  assert.deepEqual(matrix.missing, []);
  assert.deepEqual(
    phasesOf(s)[3]!.produced!.map((p) => p.kind),
    ["traceability-matrix"],
  );

  // deployment; maintenance stays pending
  s = add(s, { id: "P1", title: "release 1.0", phase: "deployment", weight: 1 }, "release-manager");
  s = c["kickoff"]!(s, { by: pm, now: tick(), phase: "deployment" }).state;
  s = workAll(s, ["release-notes", "deployment-record"]);
  s = gate(s, "deployment");
  assert.deepEqual(statuses(s), [
    "baselined",
    "baselined",
    "baselined",
    "baselined",
    "baselined",
    "pending",
  ]);
  assert.equal(s.baselines!.length, 7);
  assert.deepEqual(s.pending, []);

  // the governance trail, in order
  const trail = s.events
    .filter((e) => /^(phase|change|traceability|pending)\./.test(e.type))
    .map((e) => e.type);
  const gateHuman = ["pending.raised", "phase.gate-pending", "pending.decided", "phase.baselined"];
  assert.deepEqual(trail, [
    "phase.opened",
    ...gateHuman, // requirements #1
    "phase.opened",
    "traceability.computed",
    ...gateHuman, // design #1
    "phase.opened",
    ...gateHuman, // implementation
    "phase.opened", // verification #1
    "pending.raised",
    "change.recommended",
    "pending.decided",
    "phase.reopened",
    "phase.reopened",
    "phase.suspended",
    "change.decided",
    "phase.opened",
    ...gateHuman, // requirements #2
    "phase.opened",
    "traceability.computed",
    ...gateHuman, // design #2
    "phase.opened",
    "traceability.computed",
    "phase.deliverable",
    ...gateHuman, // verification #2
    "phase.opened",
    ...gateHuman, // deployment
  ]);

  // metrics from events alone
  const mx = waterfallMetrics(s);
  assert.deepEqual(mx.phaseCompletion, {
    requirements: 100,
    design: 100,
    implementation: 100,
    verification: 100,
    deployment: 100,
    maintenance: 0,
  });
  assert.deepEqual(mx.budgetPlanned, {
    requirements: 0,
    design: 0,
    implementation: 5000,
    verification: 0,
    deployment: 0,
    maintenance: 0,
  });
  assert.deepEqual(mx.budgetSpent, {
    requirements: 3000,
    design: 2000,
    implementation: 1000,
    verification: 2000,
    deployment: 1000,
    maintenance: 0,
  });
  assert.deepEqual(mx.scheduleVariance, {
    requirements: 3000,
    design: 2000,
    implementation: -4000,
    verification: 2000,
    deployment: 1000,
    maintenance: 0,
  });
  assert.deepEqual(
    [mx.requirementsTraced, mx.requirementsTotal, mx.requirementCoverage],
    [3, 3, 1],
  );
  assert.deepEqual(mx.defectsPerPhase, {
    requirements: 0,
    design: 0,
    implementation: 0,
    verification: 0,
    deployment: 0,
    maintenance: 0,
  });
  assert.deepEqual(
    [
      mx.changeRequests,
      mx.changesApproved,
      mx.changesRejected,
      mx.changeApprovalRate,
      mx.reworkWeight,
      mx.phasesReopened,
    ],
    [1, 1, 0, 1, 3, 2],
  );
  // membership and spend replay from events; coverage is live, so the items stay
  const stripped = {
    ...s,
    iterations: [],
    accounting: [],
    phases: undefined,
    baselines: undefined,
    baseline: undefined,
    pending: [],
  } as unknown as WorkflowState;
  assert.deepEqual(waterfallMetrics(stripped), mx);
  // §14: the generated schema validates the fixture in the form loadState() sees
  assertValid(workflowStateSchema, JSON.parse(JSON.stringify(s)), "final scenario state");
});
