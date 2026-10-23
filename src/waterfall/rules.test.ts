import { test } from "node:test";
import assert from "node:assert/strict";
import { init } from "../methodology.ts";
import { addEvidence, addItem, moveItem } from "../items.ts";
import type { Action, Rule, WorkflowState } from "../types.ts";
import { waterfall } from "./index.ts";
import { phasesOf, withPhases } from "./phases.ts";
import { waterfallRules } from "./rules.ts";

const T0 = "2026-10-22T00:00:00.000Z";
const rules = Object.fromEntries(waterfallRules().map((r) => [r.id, r])) as Record<string, Rule>;
const ids = (vs: Array<{ rule: string }>) => vs.map((x) => x.rule);
const setStatus = (
  s: WorkflowState,
  id: string,
  status: "pending" | "open" | "baselined" | "reopened",
) =>
  withPhases(
    s,
    phasesOf(s).map((p) => (p.id === id ? { ...p, status } : p)),
  );
const ceremony = (type: string, by: string, payload: Record<string, unknown>): Action => ({
  type: `ceremony.${type}`,
  by,
  payload: { by, ...payload },
});

const editR1 = (): Action => ({
  type: "item.edit",
  by: "human",
  payload: { id: "R1", patch: { title: "x" } },
});

function base() {
  let s = init({ methodology: waterfall(), config: {}, now: T0 }).state;
  s = addItem(s, { id: "R1", title: "r1", phase: "requirements" }, "business-analyst", T0);
  s = addItem(s, { id: "R2", title: "r2", phase: "requirements" }, "business-analyst", T0);
  return s;
}

test("rules are seven, in spec order", () => {
  assert.deepEqual(
    waterfallRules().map((r) => r.id),
    [
      "phase-sequential",
      "gate-before-next-phase",
      "baseline-immutable",
      "change-needs-impact-analysis",
      "requirement-traced",
      "deliverables-present",
      "approver-not-author",
    ],
  );
});

test("phase-sequential: kickoff of an open/baselined phase or while another is open; items need a phase; no phase moves", () => {
  let s = base();
  const r = rules["phase-sequential"]!;
  assert.deepEqual(
    r.check(s, ceremony("kickoff", "project-manager", { phase: "requirements" })),
    [],
  );
  s = setStatus(s, "requirements", "open");
  assert.match(
    r.check(s, ceremony("kickoff", "project-manager", { phase: "requirements" }))[0]!.message,
    /already open/,
  );
  assert.match(
    r.check(s, ceremony("kickoff", "project-manager", { phase: "design" }))[0]!.message,
    /"requirements" is still open/,
  );
  s = setStatus(s, "requirements", "baselined");
  assert.match(
    r.check(s, ceremony("kickoff", "project-manager", { phase: "requirements" }))[0]!.message,
    /is baselined/,
  );
  assert.deepEqual(r.check(s, ceremony("kickoff", "project-manager", { phase: "design" })), []);
  assert.deepEqual(r.check(s, ceremony("kickoff", "project-manager", { phase: "nope" })), []); // the ceremony itself rejects unknown phases
  const add = (item: Record<string, unknown>) =>
    r.check(s, { type: "item.add", by: "human", payload: { item } });
  assert.match(add({ id: "X", title: "x" })[0]!.message, /belongs to no phase/);
  assert.match(add({ id: "X", title: "x", phase: "nope" })[0]!.message, /unknown phase "nope"/);
  assert.deepEqual(add({ id: "X", title: "x", phase: "design" }), []);
  assert.deepEqual(add({ id: "X", title: "x", parent: "R1" }), []);
  assert.deepEqual(add({ id: "CR-1", title: "c", type: "change-request" }), []);
  assert.deepEqual(add({ id: "Q", title: "q", type: "question" }), []);
  const edit = (patch: Record<string, unknown>) =>
    r.check(s, { type: "item.edit", by: "human", payload: { id: "R1", patch } });
  assert.match(
    edit({ phase: "design" })[0]!.message,
    /cannot move from phase "requirements" to "design"/,
  );
  assert.deepEqual(edit({ phase: "requirements" }), []);
  assert.deepEqual(edit({ title: "t" }), []);
});

test("gate-before-next-phase lists the unbaselined earlier phases", () => {
  let s = base();
  const r = rules["gate-before-next-phase"]!;
  const v = r.check(s, ceremony("kickoff", "project-manager", { phase: "implementation" }));
  assert.equal(v.length, 1);
  assert.match(v[0]!.message, /requirements, design/);
  assert.match(v[0]!.fix, /starting with "requirements"/);
  s = setStatus(setStatus(s, "requirements", "baselined"), "design", "baselined");
  assert.deepEqual(
    r.check(s, ceremony("kickoff", "project-manager", { phase: "implementation" })),
    [],
  );
  assert.deepEqual(
    r.check(s, ceremony("kickoff", "project-manager", { phase: "requirements" })),
    [],
  );
});

test("baseline-immutable refuses edits to and adds into a baselined phase", () => {
  let s = base();
  const r = rules["baseline-immutable"]!;
  assert.deepEqual(r.check(s, editR1()), []);
  s = setStatus(s, "requirements", "baselined");
  s = {
    ...s,
    baselines: [
      { phase: "requirements", version: 2, at: T0, approvedBy: ["human"], itemSnapshot: {} },
    ],
  };
  const v = r.check(s, editR1());
  assert.equal(v[0]!.item, "R1");
  assert.match(v[0]!.message, /frozen.*"requirements".*v1/);
  assert.match(v[0]!.fix, /change-request/);
  const add = r.check(s, {
    type: "item.add",
    by: "human",
    payload: { item: { id: "R9", title: "late", phase: "requirements" } },
  });
  assert.match(add[0]!.message, /cannot add "R9" to baselined phase "requirements"/);
  assert.deepEqual(
    r.check(s, {
      type: "item.add",
      by: "human",
      payload: { item: { id: "Q", title: "q", type: "question", parent: "R1" } },
    }),
    [],
  );
  assert.deepEqual(
    r.check(s, {
      type: "item.add",
      by: "human",
      payload: { item: { id: "D1", title: "d", phase: "design" } },
    }),
    [],
  );
});

test("change-needs-impact-analysis validates the analysis and its reopen list", () => {
  let s = base();
  s = setStatus(s, "requirements", "baselined");
  s = addItem(
    s,
    { id: "CR-1", title: "c", type: "change-request", affects: ["R1"] },
    "developer",
    T0,
  );
  const r = rules["change-needs-impact-analysis"]!;
  const ccb = (decision: string) =>
    r.check(s, ceremony("changeControlBoard", "project-manager", { change: "CR-1", decision }));
  const withIa = (ia: unknown) => ({
    ...s,
    items: { ...s.items, "CR-1": { ...s.items["CR-1"]!, impactAnalysis: ia } },
  });
  assert.match(ccb("approve")[0]!.message, /no impact analysis/);
  assert.match(ccb("approve")[0]!.fix, /impactAnalysis/);
  s = withIa({ summary: "", reopen: ["requirements"], weight: 1 }) as WorkflowState;
  assert.match(ccb("approve")[0]!.message, /summary/);
  s = withIa({ summary: "s", reopen: ["nope"], weight: 1 }) as WorkflowState;
  assert.match(ccb("approve")[0]!.message, /unknown phase "nope"/);
  s = withIa({ summary: "s", reopen: ["design"], weight: 1 }) as WorkflowState;
  assert.match(ccb("approve")[0]!.message, /"design" was never baselined/);
  assert.deepEqual(ccb("reject"), []);
  s = withIa({ summary: "s", reopen: ["requirements"], weight: 1 }) as WorkflowState;
  assert.deepEqual(ccb("approve"), []);
  const lax = init({
    methodology: waterfall(),
    config: { changeControl: { requiresImpactAnalysis: false } },
    now: T0,
  }).state;
  const s2 = addItem(lax, { id: "CR-1", title: "c", type: "change-request" }, "developer", T0);
  assert.deepEqual(
    r.check(
      s2,
      ceremony("changeControlBoard", "project-manager", { change: "CR-1", decision: "approve" }),
    ),
    [],
  );
});

test("requirement-traced fires at the gates of traceability.to phases only", () => {
  let s = base();
  s = addItem(s, { id: "D1", title: "d1", phase: "design", traces: ["R1"] }, "architect", T0);
  const r = rules["requirement-traced"]!;
  assert.deepEqual(
    r.check(s, ceremony("gateReview", "project-manager", { phase: "requirements" })),
    [],
  );
  const v = r.check(s, ceremony("gateReview", "project-manager", { phase: "design" }));
  assert.deepEqual(
    v.map((x) => x.item),
    ["R2"],
  );
  assert.match(v[0]!.message, /"R2".*no trace into "design"/);
  assert.match(v[0]!.fix, /traces: \["R2"\]/);
  s = addItem(s, { id: "D2", title: "d2", phase: "design", traces: ["R2"] }, "architect", T0);
  assert.deepEqual(r.check(s, ceremony("gateReview", "project-manager", { phase: "design" })), []);
  assert.deepEqual(
    r
      .check(s, ceremony("gateReview", "project-manager", { phase: "verification" }))
      .map((x) => x.item),
    ["R1", "R2"],
  );
});

test("deliverables-present wants every item done and every deliverable produced", () => {
  let s = base();
  s = setStatus(s, "requirements", "open");
  const r = rules["deliverables-present"]!;
  let v = r.check(s, ceremony("gateReview", "project-manager", { phase: "requirements" }));
  assert.deepEqual(ids(v), ["deliverables-present", "deliverables-present"]);
  assert.match(v[0]!.message, /2 item\(s\).*not done: R1, R2/);
  assert.match(v[1]!.message, /no deliverable "srs"/);
  assert.match(v[1]!.fix, /"kind": "srs"/);
  s = moveItem(s, "R1", { stage: "done", status: "done" }, "human", T0);
  s = moveItem(s, "R2", { status: "dropped" }, "human", T0);
  s = addEvidence(s, "R1", { kind: "srs", ref: "docs/srs.md", by: "business-analyst" }, T0);
  assert.deepEqual(
    r.check(s, ceremony("gateReview", "project-manager", { phase: "requirements" })),
    [],
  );
  // the input's deliverables count; the matrix is the engine's job at the last traceability phase
  s = setStatus(setStatus(s, "requirements", "baselined"), "verification", "open");
  v = r.check(
    s,
    ceremony("gateReview", "project-manager", {
      phase: "verification",
      deliverables: [{ kind: "test-report", ref: "r" }],
    }),
  );
  assert.deepEqual(v, []);
  v = r.check(s, ceremony("gateReview", "project-manager", { phase: "verification" }));
  assert.deepEqual(
    v.map((x) => x.message),
    ['phase "verification" has no deliverable "test-report"'],
  );
});

test("approver-not-author: gate reviewers and change deciders must not be the author", () => {
  let s = base();
  s = setStatus(s, "requirements", "open");
  s = moveItem(s, "R1", { status: "in_progress" }, "business-analyst", T0);
  s = moveItem(s, "R1", { stage: "done", status: "done" }, "business-analyst", T0);
  const r = rules["approver-not-author"]!;
  assert.deepEqual(
    r.check(s, ceremony("gateReview", "project-manager", { phase: "requirements" })),
    [],
  );
  assert.deepEqual(r.check(s, ceremony("gateReview", "human", { phase: "requirements" })), []);
  const v = r.check(s, ceremony("gateReview", "business-analyst", { phase: "requirements" }));
  assert.match(v[0]!.message, /"business-analyst" authored R1/);
  assert.match(v[0]!.fix, /human, project-manager/);
  s = addItem(s, { id: "CR-1", title: "c", type: "change-request" }, "project-manager", T0);
  assert.match(
    r.check(
      s,
      ceremony("changeControlBoard", "project-manager", { change: "CR-1", decision: "approve" }),
    )[0]!.message,
    /raised change "CR-1"/,
  );
  assert.deepEqual(
    r.check(s, ceremony("changeControlBoard", "human", { change: "CR-1", decision: "approve" })),
    [],
  );
});
