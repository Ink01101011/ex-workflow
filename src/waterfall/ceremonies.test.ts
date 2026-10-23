import { test } from "node:test";
import assert from "node:assert/strict";
import { init } from "../methodology.ts";
import { addEvidence, addItem, getItem, moveItem } from "../items.ts";
import { decide } from "../gates.ts";
import { WorkflowError } from "../errors.ts";
import type { Event, WorkflowState } from "../types.ts";
import { waterfall } from "./index.ts";
import { phasesOf } from "./phases.ts";

const T0 = "2026-10-22T00:00:00.000Z";
const T1 = "2026-10-22T01:00:00.000Z";
const T2 = "2026-10-22T02:00:00.000Z";
const m = waterfall();
const c = m.ceremonies;
const pm = "project-manager";
const last = (s: WorkflowState): Event => s.events[s.events.length - 1]!;
const err = (code: string, re: RegExp) => (e: unknown) =>
  e instanceof WorkflowError && e.code === code && re.test(e.message);

function withRequirements() {
  let s = init({ methodology: m, config: {}, now: T0 }).state;
  s = addItem(s, { id: "R1", title: "r1", phase: "requirements" }, "business-analyst", T0);
  s = addItem(s, { id: "R2", title: "r2", phase: "requirements" }, "business-analyst", T0);
  return s;
}
/** Finish an item the short way: work → done with evidence, authored by `by`. */
function finish(s: WorkflowState, id: string, by: string, kinds: string[]): WorkflowState {
  s = moveItem(s, id, { status: "in_progress" }, by, T1);
  for (const k of kinds) s = addEvidence(s, id, { kind: k, ref: `${id}/${k}`, by }, T1);
  return moveItem(s, id, { stage: "done", status: "done" }, by, T1);
}

test("kickoff opens the phase and its iteration; refuses the wrong phase, role or order", () => {
  let s = withRequirements();
  assert.throws(
    () => c["kickoff"]!(s, { by: "developer", now: T0, phase: "requirements" }),
    err("missing-capability", /facilitate/),
  );
  assert.throws(() => c["kickoff"]!(s, { by: pm, now: T0 }), err("invalid-input", /needs phase/));
  assert.throws(
    () => c["kickoff"]!(s, { by: pm, now: T0, phase: "nope" }),
    err("config-invalid", /unknown phase/),
  );
  assert.throws(
    () => c["kickoff"]!(s, { by: pm, now: T0, phase: "design" }),
    err("rule-violation", /gate-before-next-phase/),
  );
  const r = c["kickoff"]!(s, { by: pm, now: T1, phase: "requirements" });
  assert.deepEqual(r.warnings, []);
  s = r.state;
  assert.equal(phasesOf(s)[0]!.status, "open");
  assert.deepEqual(
    s.iterations.map((i) => [i.id, i.goal, i.committed, i.startedAt]),
    [["requirements#1", "Requirements", ["R1", "R2"], T1]],
  );
  assert.deepEqual(last(s).payload, {
    phase: "requirements",
    version: 1,
    items: ["R1", "R2"],
    budget: {},
  });
  assert.throws(
    () => c["kickoff"]!(s, { by: pm, now: T1, phase: "requirements" }),
    err("rule-violation", /already open/),
  );
  assert.throws(
    () => c["kickoff"]!(s, { by: pm, now: T1, phase: "design" }),
    err("rule-violation", /still open/),
  );
});

test("gateReview with a human gate: pending → decide approve baselines; reject keeps the phase open", () => {
  let s = withRequirements();
  s = c["kickoff"]!(s, { by: pm, now: T0, phase: "requirements" }).state;
  assert.throws(
    () => c["gateReview"]!(s, { by: "developer", now: T1, phase: "requirements" }),
    err("gate-unmet", /may not review gate "requirements-gate"/),
  );
  assert.throws(
    () => c["gateReview"]!(s, { by: pm, now: T1, phase: "design" }),
    err("invalid-transition", /"design" is pending/),
  );
  assert.throws(
    () => c["gateReview"]!(s, { by: pm, now: T1, phase: "requirements" }),
    err("rule-violation", /not done: R1, R2/),
  );
  s = finish(s, "R1", "business-analyst", ["srs"]);
  s = finish(s, "R2", "business-analyst", []);
  assert.throws(
    () => c["gateReview"]!(s, { by: "business-analyst", now: T1, phase: "requirements" }),
    err("gate-unmet", /may not review/),
  );
  assert.throws(
    () =>
      c["gateReview"]!(s, { by: pm, now: T1, phase: "requirements", deliverables: [{ kind: "" }] }),
    err("invalid-input", /deliverables/),
  );
  const r = c["gateReview"]!(s, {
    by: pm,
    now: T1,
    phase: "requirements",
    deliverables: [{ kind: "glossary", ref: "docs/glossary.md" }],
  });
  s = r.state;
  assert.equal(phasesOf(s)[0]!.status, "open");
  assert.deepEqual(phasesOf(s)[0]!.produced, [
    { kind: "glossary", ref: "docs/glossary.md", by: pm, at: T1 },
  ]);
  assert.deepEqual(
    s.pending.map((p) => [p.id, p.kind, p.gate, p.item]),
    [["p1", "gate", "requirements-gate", undefined]],
  );
  assert.deepEqual(
    s.events.slice(-3).map((e) => e.type),
    ["phase.deliverable", "pending.raised", "phase.gate-pending"],
  );
  assert.deepEqual(last(s).payload, {
    phase: "requirements",
    gate: "requirements-gate",
    by: pm,
    pending: "p1",
  });
  assert.throws(
    () => c["gateReview"]!(s, { by: pm, now: T1, phase: "requirements" }),
    err("no-op", /already awaiting a decision \(p1\)/),
  );
  const rejected = decide(s, "p1", "reject", "human", "srs is thin", T2, m);
  assert.equal(phasesOf(rejected)[0]!.status, "open");
  assert.deepEqual(last(rejected).payload, {
    phase: "requirements",
    gate: "requirements-gate",
    note: "srs is thin",
  });
  assert.equal(last(rejected).type, "phase.gate-failed");
  s = decide(s, "p1", "approve", "human", "ok", T2, m);
  assert.equal(phasesOf(s)[0]!.status, "baselined");
  assert.deepEqual(s.baseline!.approvedBy, [pm, "human"]);
  assert.equal(s.baseline!.version, 1);
  assert.deepEqual(new Set(Object.keys(s.baseline!.itemSnapshot)), new Set(["R1", "R2"]));
  assert.equal(s.iterations[0]!.outcome, "completed");
  assert.equal(last(s).type, "phase.baselined");
  assert.throws(
    () => c["gateReview"]!(s, { by: pm, now: T2, phase: "requirements" }),
    err("invalid-transition", /"requirements" is baselined, not open/),
  );
});

test("gateReview without a human gate baselines at once; traceability is computed at to-phases and the matrix delivered at the last one", () => {
  let s = init({ methodology: m, config: { humanGates: [] }, now: T0 }).state;
  s = addItem(s, { id: "R1", title: "r1", phase: "requirements" }, "business-analyst", T0);
  s = c["kickoff"]!(s, { by: pm, now: T0, phase: "requirements" }).state;
  s = finish(s, "R1", "business-analyst", ["srs"]);
  s = c["gateReview"]!(s, { by: pm, now: T1, phase: "requirements" }).state;
  assert.equal(phasesOf(s)[0]!.status, "baselined");
  assert.deepEqual(s.baseline!.approvedBy, [pm]);
  assert.deepEqual(s.pending, []);
  s = addItem(s, { id: "D1", title: "d1", phase: "design", traces: ["R1"] }, "architect", T1);
  s = c["kickoff"]!(s, { by: pm, now: T1, phase: "design" }).state;
  s = finish(s, "D1", "architect", ["design-doc", "interface-spec"]);
  s = c["gateReview"]!(s, { by: pm, now: T1, phase: "design" }).state;
  const tc = s.events.filter((e) => e.type === "traceability.computed");
  assert.equal(tc.length, 1);
  assert.deepEqual((tc[0]!.payload as { coverage: unknown }).coverage, { traced: 0, total: 1 }); // verification not linked yet
  assert.equal(phasesOf(s)[1]!.produced, undefined); // no matrix deliverable before the last to-phase
  s = addItem(s, { id: "I1", title: "i1", phase: "implementation" }, "developer", T1);
  s = c["kickoff"]!(s, { by: pm, now: T1, phase: "implementation" }).state;
  s = finish(s, "I1", "developer", ["code-baseline"]);
  s = c["gateReview"]!(s, { by: pm, now: T1, phase: "implementation" }).state;
  s = addItem(s, { id: "V1", title: "v1", phase: "verification", traces: ["R1"] }, "developer", T1);
  s = c["kickoff"]!(s, { by: pm, now: T1, phase: "verification" }).state;
  s = finish(s, "V1", "developer", ["test-report"]);
  s = c["gateReview"]!(s, { by: pm, now: T2, phase: "verification" }).state;
  assert.equal(phasesOf(s)[3]!.status, "baselined");
  const produced = phasesOf(s)[3]!.produced!;
  assert.equal(produced.length, 1);
  assert.equal(produced[0]!.kind, "traceability-matrix");
  assert.match(produced[0]!.ref, /^traceability\.computed#\d+$/);
  assert.equal(s.events.filter((e) => e.type === "traceability.computed").length, 2);
  assert.equal(s.baselines!.length, 4);
});

test("gateReview refuses an untraced requirement at a to-phase gate", () => {
  let s = init({ methodology: m, config: { humanGates: [] }, now: T0 }).state;
  s = addItem(s, { id: "R1", title: "r1", phase: "requirements" }, "business-analyst", T0);
  s = c["kickoff"]!(s, { by: pm, now: T0, phase: "requirements" }).state;
  s = finish(s, "R1", "business-analyst", ["srs"]);
  s = c["gateReview"]!(s, { by: pm, now: T1, phase: "requirements" }).state;
  s = addItem(s, { id: "D1", title: "d1", phase: "design" }, "architect", T1);
  s = c["kickoff"]!(s, { by: pm, now: T1, phase: "design" }).state;
  s = finish(s, "D1", "architect", ["design-doc", "interface-spec"]);
  assert.throws(
    () => c["gateReview"]!(s, { by: pm, now: T1, phase: "design" }),
    err("rule-violation", /requirement-traced.*"R1".*no trace into "design"/),
  );
});

function baselinedThrough(
  phaseIds: string[],
  config: Record<string, unknown> = { humanGates: [] },
) {
  let s = init({ methodology: m, config, now: T0 }).state;
  for (const id of phaseIds) {
    const item = `${id[0]!.toUpperCase()}1`;
    s = addItem(
      s,
      { id: item, title: item, phase: id, traces: id === "requirements" ? [] : ["R1"] },
      "developer",
      T0,
    );
    s = c["kickoff"]!(s, { by: pm, now: T0, phase: id }).state;
    const kinds =
      {
        requirements: ["srs"],
        design: ["design-doc", "interface-spec"],
        implementation: ["code-baseline"],
        verification: ["test-report"],
      }[id] ?? [];
    s = finish(s, item, "developer", kinds);
    s = c["gateReview"]!(s, { by: pm, now: T1, phase: id }).state;
  }
  return s;
}

test("changeControlBoard validates the change and the board's authority", () => {
  let s = baselinedThrough(["requirements"]);
  s = addItem(
    s,
    { id: "CR-1", title: "add sso", type: "change-request", affects: ["R1"] },
    "developer",
    T1,
  );
  s = addItem(s, { id: "D9", title: "not a change", phase: "design" }, "developer", T1);
  const ccb = (input: Record<string, unknown>) =>
    c["changeControlBoard"]!(s, {
      by: pm,
      now: T1,
      change: "CR-1",
      decision: "approve",
      ...input,
    });
  assert.throws(() => ccb({ by: "developer" }), err("missing-capability", /control-change/));
  assert.throws(() => ccb({ change: undefined }), err("invalid-input", /needs change/));
  assert.throws(() => ccb({ change: "D9" }), err("invalid-input", /not a change-request/));
  assert.throws(() => ccb({ decision: "maybe" }), err("invalid-input", /decision/));
  assert.throws(() => ccb({}), err("rule-violation", /change-needs-impact-analysis/));
  // the board approves without a human when approvers do not include "human"
  const lax = init({
    methodology: m,
    config: { humanGates: [], changeControl: { approvers: [{ capability: "control-change" }] } },
    now: T0,
  }).state;
  let s2 = addItem(
    lax,
    {
      id: "CR-1",
      title: "c",
      type: "change-request",
      impactAnalysis: { summary: "s", reopen: [], weight: 1 },
    },
    "developer",
    T0,
  );
  s2 = c["changeControlBoard"]!(s2, {
    by: pm,
    now: T1,
    change: "CR-1",
    decision: "reject",
    note: "too costly",
  }).state;
  assert.equal(getItem(s2, "CR-1").status, "dropped");
  assert.deepEqual(last(s2).payload, {
    change: "CR-1",
    decision: "reject",
    by: pm,
    note: "too costly",
    reopened: [],
    suspended: null,
    weight: 0,
    affects: [],
  });
  assert.throws(
    () => c["changeControlBoard"]!(s2, { by: pm, now: T1, change: "CR-1", decision: "approve" }),
    err("invalid-transition", /already rejected/),
  );
});

test("changeControlBoard with a human approver: recommendation → pending → decide reopens phases and suspends the open one", () => {
  let s = baselinedThrough(["requirements", "design", "implementation"]);
  s = addItem(s, { id: "V1", title: "v1", phase: "verification", traces: ["R1"] }, "developer", T1);
  s = c["kickoff"]!(s, { by: pm, now: T1, phase: "verification" }).state;
  s = addItem(
    s,
    {
      id: "CR-1",
      title: "add sso",
      type: "change-request",
      affects: ["R1"],
      impactAnalysis: { summary: "sso", reopen: ["requirements", "design"], weight: 3 },
    },
    "business-analyst",
    T1,
  );
  const r = c["changeControlBoard"]!(s, {
    by: pm,
    now: T1,
    change: "CR-1",
    decision: "approve",
    note: "worth it",
  });
  s = r.state;
  assert.equal(getItem(s, "CR-1").status, "awaiting_human");
  assert.deepEqual(
    s.pending.map((p) => [p.id, p.kind, p.item]),
    [["p1", "decision", "CR-1"]],
  );
  assert.equal(last(s).type, "change.recommended");
  assert.deepEqual(last(s).payload, {
    change: "CR-1",
    decision: "approve",
    note: "worth it",
    pending: "p1",
  });
  assert.throws(
    () => c["changeControlBoard"]!(s, { by: pm, now: T1, change: "CR-1", decision: "approve" }),
    err("no-op", /awaiting the human decision \(p1\)/),
  );
  const rejected = decide(s, "p1", "reject", "human", "no", T2, m);
  assert.equal(getItem(rejected, "CR-1").status, "dropped");
  assert.deepEqual(
    phasesOf(rejected).map((p) => p.status),
    ["baselined", "baselined", "baselined", "open", "pending", "pending"],
  );
  s = decide(s, "p1", "approve", "human", "go", T2, m);
  assert.equal(getItem(s, "CR-1").status, "done");
  assert.equal(getItem(s, "CR-1").stage, "done");
  assert.deepEqual(
    phasesOf(s).map((p) => p.status),
    ["reopened", "reopened", "baselined", "reopened", "pending", "pending"],
  );
  assert.equal(s.iterations.find((i) => i.id === "verification#1")!.outcome, "cancelled");
  assert.deepEqual(
    s.events.slice(-5).map((e) => e.type),
    ["item.transition", "phase.reopened", "phase.reopened", "phase.suspended", "change.decided"],
  );
  assert.deepEqual(last(s).payload, {
    change: "CR-1",
    decision: "approve",
    by: "human",
    note: "go",
    reopened: ["requirements", "design"],
    suspended: "verification",
    weight: 3,
    affects: ["R1"],
  });
  // the reopened phase can be kicked off again (version 2) and its items edited through the rules
  s = c["kickoff"]!(s, { by: pm, now: T2, phase: "requirements" }).state;
  assert.equal(s.iterations[s.iterations.length - 1]!.id, "requirements#2");
  assert.deepEqual(
    m.rules.flatMap((rule) =>
      rule.check(s, {
        type: "item.edit",
        by: "human",
        payload: { id: "R1", patch: { title: "sso login" } },
      }),
    ),
    [],
  );
  assert.throws(
    () => c["kickoff"]!(s, { by: pm, now: T2, phase: "verification" }),
    err("rule-violation", /still open/),
  );
});

test("phaseRetrospective stores lessons, adopts and dismisses, applies agreements only", () => {
  let s = baselinedThrough(["requirements"]);
  assert.throws(
    () => c["phaseRetrospective"]!(s, { by: "developer", now: T1 }),
    err("missing-capability", /facilitate/),
  );
  assert.throws(
    () => c["phaseRetrospective"]!(s, { by: pm, now: T1, phase: "nope" }),
    err("config-invalid", /unknown phase/),
  );
  assert.throws(
    () =>
      c["phaseRetrospective"]!(s, { by: pm, now: T1, lessons: [{ text: "", scope: "policy" }] }),
    err("invalid-input", /lessons/),
  );
  assert.throws(
    () => c["phaseRetrospective"]!(s, { by: pm, now: T1, adopt: [{ id: "L9" }] }),
    err("invalid-input", /no lesson "L9"/),
  );
  s = {
    ...s,
    lessons: [
      {
        id: "L1",
        at: T0,
        text: "srs template was vague",
        scope: "spec",
        status: "raised",
        from: "business-analyst",
      },
    ],
  };
  const r = c["phaseRetrospective"]!(s, {
    by: pm,
    now: T1,
    phase: "requirements",
    lessons: [
      {
        text: "review the srs with qa before the gate",
        scope: "policy",
        suggestedChange: {
          kind: "agreement",
          text: "qa reads the srs before the requirements gate",
        },
      },
    ],
    adopt: [{ id: "L1", suggestedChange: { kind: "skill", note: "tighten the srs template" } }],
  });
  s = r.state;
  assert.deepEqual(
    s.lessons.map((l) => [l.id, l.status, l.from]),
    [
      ["L1", "adopted", "business-analyst"],
      ["L2", "adopted", pm],
    ],
  );
  assert.deepEqual(s.lessons[0]!.suggestedChange, {
    kind: "skill",
    note: "tighten the srs template",
  });
  assert.deepEqual(s.agreements, ["qa reads the srs before the requirements gate"]);
  assert.deepEqual(last(s).payload, {
    phase: "requirements",
    lessons: ["L2"],
    adopted: ["L1"],
    dismissed: [],
    agreements: ["qa reads the srs before the requirements gate"],
  });
  assert.throws(
    () => c["phaseRetrospective"]!(s, { by: pm, now: T1, dismiss: ["L1"] }),
    err("invalid-input", /already adopted/),
  );
  assert.equal(s.baseline!.version, 1); // untouched
});
