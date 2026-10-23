import { test } from "node:test";
import assert from "node:assert/strict";
import { init } from "../methodology.ts";
import { addItem } from "../items.ts";
import { next } from "../brief.ts";
import { complete } from "../complete.ts";
import type { Accounting, Brief, Handoff, WorkflowState } from "../types.ts";
import { waterfall } from "./index.ts";
import { waterfallMetrics } from "./metrics.ts";

const T0 = "2026-10-22T00:00:00.000Z";
const m = waterfall();
const c = m.ceremonies;
const pm = "project-manager";
let clock = Date.parse(T0);
const tick = () => new Date((clock += 60_000)).toISOString();
const h = (b: Brief, kinds: string[]): Handoff => ({
  item: b.item.id,
  role: b.role.id,
  produced: kinds.map((k) => ({ kind: k, ref: `${b.item.id}/${k}` })),
  notes: "ok",
  do_not: [],
  open_questions: [],
});
const acc = (b: Brief): Accounting => ({
  item: b.item.id,
  role: b.role.id,
  model: "small",
  tokensIn: 300,
  tokensOut: 200,
  durationMs: 1000,
  startedAt: T0,
  endedAt: T0,
});
/** Dispatch everything ready and complete it with `kinds`; twice (work, then review). */
function workAll(s: WorkflowState, kinds: string[]): WorkflowState {
  for (let round = 0; round < 2; round++) {
    // weight 1 + an explicit fallback: without accounting history the default estimate (20000/weight) exceeds any small budget
    const r = next(s, m, { now: tick(), fallbackTokensPerWeight: 500 });
    s = r.state;
    for (const b of r.briefs)
      s = complete(s, m, h(b, round === 0 ? kinds : []), acc(b), tick()).state;
  }
  return s;
}
const ZERO = {
  requirements: 0,
  design: 0,
  implementation: 0,
  verification: 0,
  deployment: 0,
  maintenance: 0,
};

test("waterfall metrics from events: completion, budget variance, coverage, defects, changes, rework", () => {
  let s = init({
    methodology: m,
    config: {
      humanGates: [],
      phases: [
        { id: "requirements", budget: { tokens: 4000 } },
        { id: "design" },
        { id: "implementation" },
        { id: "verification" },
        { id: "deployment" },
        { id: "maintenance" },
      ],
    },
    now: T0,
  }).state;
  assert.deepEqual(waterfallMetrics(s), {
    phaseCompletion: ZERO,
    budgetPlanned: ZERO,
    budgetSpent: ZERO,
    scheduleVariance: ZERO,
    requirementCoverage: 0,
    requirementsTraced: 0,
    requirementsTotal: 0,
    defectsPerPhase: ZERO,
    changeRequests: 0,
    changesApproved: 0,
    changesRejected: 0,
    changeApprovalRate: 0,
    reworkWeight: 0,
    phasesReopened: 0,
  });
  s = addItem(
    s,
    { id: "R1", title: "r1", phase: "requirements", weight: 1 },
    "business-analyst",
    tick(),
  );
  s = addItem(
    s,
    { id: "R2", title: "r2", phase: "requirements", weight: 1 },
    "business-analyst",
    tick(),
  );
  s = addItem(
    s,
    {
      id: "B1",
      title: "typo in srs",
      type: "bug",
      phase: "requirements",
      weight: 1,
      affects: ["R1"],
    },
    "qa",
    tick(),
  );
  s = c["kickoff"]!(s, { by: pm, now: tick(), phase: "requirements" }).state;
  s = workAll(s, ["srs"]); // R1, R2, B1 each: work (500 tokens) + review (500 tokens)
  let mx = waterfallMetrics(s);
  assert.equal(mx.phaseCompletion["requirements"], 100);
  assert.equal(mx.budgetPlanned["requirements"], 4000);
  assert.equal(mx.budgetSpent["requirements"], 3000);
  assert.equal(mx.scheduleVariance["requirements"], -1000);
  assert.deepEqual(mx.defectsPerPhase, { ...ZERO, requirements: 1 });
  s = c["gateReview"]!(s, { by: pm, now: tick(), phase: "requirements" }).state;
  s = addItem(
    s,
    { id: "D1", title: "d1", phase: "design", weight: 1, traces: ["R1", "B1"] },
    "architect",
    tick(),
  );
  s = addItem(s, { id: "D2", title: "d2", phase: "design", weight: 1 }, "architect", tick());
  s = c["kickoff"]!(s, { by: pm, now: tick(), phase: "design" }).state;
  s = workAll(s, ["design-doc", "interface-spec"]);
  mx = waterfallMetrics(s);
  assert.equal(mx.phaseCompletion["design"], 100);
  assert.equal(mx.requirementCoverage, 0); // no gate computed it yet
  s = { ...s, items: { ...s.items, D2: { ...s.items["D2"]!, traces: ["R2"] } } };
  s = c["gateReview"]!(s, { by: pm, now: tick(), phase: "design" }).state;
  mx = waterfallMetrics(s);
  assert.deepEqual(
    [mx.requirementsTraced, mx.requirementsTotal, mx.requirementCoverage],
    [0, 3, 0],
  ); // R1, R2, B1 are rows; verification still unlinked
  s = addItem(
    s,
    {
      id: "CR-1",
      title: "c1",
      type: "change-request",
      affects: ["R1"],
      impactAnalysis: { summary: "s", reopen: ["requirements"], weight: 5 },
    },
    "qa",
    tick(),
  );
  s = addItem(
    s,
    {
      id: "CR-2",
      title: "c2",
      type: "change-request",
      impactAnalysis: { summary: "s", reopen: [], weight: 2 },
    },
    "qa",
    tick(),
  );
  const noHuman = {
    ...s,
    config: {
      ...(s.config as object),
      changeControl: {
        requiresImpactAnalysis: true,
        approvers: [{ capability: "control-change" }],
      },
    },
  } as WorkflowState;
  s = c["changeControlBoard"]!(noHuman, {
    by: pm,
    now: tick(),
    change: "CR-1",
    decision: "approve",
  }).state;
  s = c["changeControlBoard"]!(s, {
    by: pm,
    now: tick(),
    change: "CR-2",
    decision: "reject",
  }).state;
  mx = waterfallMetrics(s);
  assert.deepEqual(
    [
      mx.changeRequests,
      mx.changesApproved,
      mx.changesRejected,
      mx.changeApprovalRate,
      mx.reworkWeight,
      mx.phasesReopened,
    ],
    [2, 1, 1, 0.5, 5, 1],
  );
  assert.equal(mx.phaseCompletion["design"], 100);
  // the escalation question inherits the phase through its parent and is not counted
  s = addItem(
    s,
    { id: "R1-q1", title: "q", type: "question", parent: "R1", role: pm },
    "developer",
    tick(),
  );
  assert.equal(waterfallMetrics(s).phaseCompletion["requirements"], 100);
  // membership and spend from events only; coverage is live, so the items stay
  const stripped = {
    ...s,
    iterations: [],
    accounting: [],
    phases: undefined,
    baselines: undefined,
    baseline: undefined,
    pending: [],
  } as unknown as WorkflowState;
  assert.deepEqual(waterfallMetrics(stripped), waterfallMetrics(s));
});

test("metrics and status report share one live coverage, change-requests excluded (#25)", () => {
  let s = init({
    methodology: m,
    config: { phases: [{ id: "requirements" }, { id: "design" }] },
    now: T0,
  }).state;
  s = addItem(s, { id: "R1", title: "r1", phase: "requirements" }, "human", tick());
  s = addItem(s, { id: "D1", title: "d1", phase: "design", traces: ["R1"] }, "human", tick());
  for (const id of ["CR-1", "CR-2", "CR-3"])
    s = addItem(
      s,
      {
        id,
        title: id,
        type: "change-request",
        phase: "requirements",
        impactAnalysis: { summary: "s", reopen: [], weight: 1 },
      },
      "human",
      tick(),
    );
  const mx = waterfallMetrics(s);
  assert.deepEqual(
    [mx.requirementsTraced, mx.requirementsTotal, mx.requirementCoverage],
    [1, 1, 1],
  );
  const rep = m.report!(s) as unknown as { coverage: { traced: number; total: number } };
  assert.deepEqual(rep.coverage, { traced: 1, total: 1 });
});
