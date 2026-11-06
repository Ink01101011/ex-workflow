import { test } from "node:test";
import assert from "node:assert/strict";
import { appendEvent, createState } from "./state.ts";
import { addEvidence } from "./items/evidence.ts";
import { addItem, getItem } from "./items/record.ts";
import { moveItem } from "./items/move.ts";
import { authorOf, checkGate, decide, raisePending } from "./gates.ts";
import { WorkflowError } from "./errors.ts";
import type { Gate, Methodology, PendingHuman, Role, Stage, WorkflowState } from "./types.ts";

const T0 = "2026-10-19T00:00:00.000Z";
const gate: Gate = {
  id: "qa-gate",
  requires: [{ capability: "approve-gate" }],
  evidence: ["test-report"],
  onFail: { action: "return-to", stage: "doing" },
};
const stages: Stage[] = [
  { id: "doing", name: "Doing", entryPolicy: [], exitPolicy: [] },
  { id: "verify", name: "Verify", entryPolicy: [], exitPolicy: [], gate },
  { id: "done", name: "Done", entryPolicy: [], exitPolicy: [] },
];
const r = (id: string, caps: Role["capabilities"], canApprove: string[] = []): Role => ({
  id,
  name: id,
  modelTier: "small",
  capabilities: caps,
  canApprove,
  inputs: [],
  outputs: [],
  do_not: [],
});
const roles = [
  r("dev", ["deliver"]),
  r("qa", ["approve-gate"], ["qa-gate"]),
  r("devqa", ["deliver", "approve-gate"], ["qa-gate"]),
];
const base = () => {
  let s = createState({ methodology: "waterfall", config: {}, stages, roles, now: T0 });
  s = addItem(s, { id: "A", title: "a" }, "pm", T0);
  s = moveItem(s, "A", { stage: "doing", status: "in_progress" }, "dev", T0);
  s = moveItem(s, "A", { stage: "verify", status: "review" }, "dev", T0);
  return s;
};

test("checkGate fails on missing evidence", () => {
  const s = base();
  const res = checkGate(s, getItem(s, "A"), gate, "qa");
  assert.equal(res.outcome, "fail");
  if (res.outcome === "fail") assert.equal(res.violations[0]!.rule, "gate:evidence");
});

test("checkGate passes for an approver that is not the author", () => {
  const s = addEvidence(base(), "A", { kind: "test-report", ref: "r1", by: "qa" }, T0);
  assert.deepEqual(checkGate(s, getItem(s, "A"), gate, "qa"), { outcome: "pass" });
  const res = checkGate(s, getItem(s, "A"), gate, "dev");
  assert.equal(res.outcome, "fail");
  if (res.outcome === "fail") assert.equal(res.violations[0]!.rule, "gate:capability");
});

test("checkGate reports conflict of interest when author approves own work", () => {
  let s = createState({ methodology: "waterfall", config: {}, stages, roles, now: T0 });
  s = addItem(s, { id: "B", title: "b" }, "pm", T0);
  s = moveItem(s, "B", { stage: "doing", status: "in_progress" }, "devqa", T0);
  s = moveItem(s, "B", { stage: "verify", status: "review" }, "devqa", T0);
  s = addEvidence(s, "B", { kind: "test-report", ref: "r1", by: "devqa" }, T0);
  const res = checkGate(s, getItem(s, "B"), gate, "devqa");
  assert.equal(res.outcome, "fail");
  if (res.outcome === "fail") assert.equal(res.violations[0]!.rule, "conflict-of-interest");
});

test("human gates go to pending and decide resolves them", () => {
  const humanGate: Gate = { ...gate, requires: ["human"] };
  let s = addEvidence(base(), "A", { kind: "test-report", ref: "r1", by: "qa" }, T0);
  assert.deepEqual(checkGate(s, getItem(s, "A"), humanGate, "qa"), { outcome: "human" });
  assert.deepEqual(checkGate(s, getItem(s, "A"), humanGate, "human"), { outcome: "pass" });
  s = raisePending(
    s,
    { kind: "gate", item: "A", gate: "qa-gate", question: "approve qa-gate for A?" },
    T0,
  );
  assert.equal(s.pending[0]!.id, "p1");
  assert.equal(getItem(s, "A").status, "awaiting_human");
  const approved = decide(s, "p1", "approve", "human", "ok", T0);
  assert.equal(approved.pending.length, 0);
  assert.equal(getItem(approved, "A").stage, "done");
  assert.equal(getItem(approved, "A").status, "done");
  const rejected = decide(s, "p1", "reject", "human", "flaky tests", T0);
  assert.equal(getItem(rejected, "A").stage, "doing");
  assert.equal(getItem(rejected, "A").status, "todo");

  const blockStages: Stage[] = stages.map((st) =>
    st.id === "verify"
      ? { ...st, gate: { ...gate, requires: ["human"], onFail: { action: "block" } } }
      : st,
  );
  let b = createState({
    methodology: "waterfall",
    config: {},
    stages: blockStages,
    roles,
    now: T0,
  });
  b = addItem(b, { id: "A", title: "a" }, "pm", T0);
  b = moveItem(b, "A", { stage: "doing", status: "in_progress" }, "dev", T0);
  b = moveItem(b, "A", { stage: "verify", status: "review" }, "dev", T0);
  b = addEvidence(b, "A", { kind: "test-report", ref: "r1", by: "qa" }, T0);
  b = raisePending(b, { kind: "gate", item: "A", gate: "qa-gate", question: "approve?" }, T0);
  const blocked = decide(b, "p1", "reject", "human", "flaky tests", T0);
  assert.equal(getItem(blocked, "A").status, "blocked");
  assert.equal(getItem(blocked, "A").stage, "verify");
  assert.match(getItem(blocked, "A").blockers[0]!.reason, /rejected/);
  assert.match(getItem(blocked, "A").blockers[0]!.reason, /flaky/);

  assert.throws(
    () => decide(s, "p9", "approve", "x", ""),
    (e: unknown) => e instanceof WorkflowError && e.code === "unknown-pending",
  );
});

test("a reviewer dispatched into the gated stage is not the author; the earlier-stage worker is", () => {
  let s = addEvidence(base(), "A", { kind: "test-report", ref: "r1", by: "qa" }, T0);
  s = moveItem(s, "A", { stage: "verify", status: "in_progress" }, "qa", T0);
  assert.equal(authorOf(s, getItem(s, "A")), "dev");
  assert.deepEqual(checkGate(s, getItem(s, "A"), gate, "qa"), { outcome: "pass" });
});

test("decide hands the removed pending entry to methodology.afterDecide", () => {
  let s = createState({
    methodology: "waterfall",
    config: {},
    stages,
    roles: [r("pm", ["approve-gate"], ["qa-gate"])],
    now: T0,
  });
  s = raisePending(s, { kind: "gate", gate: "qa-gate", question: "baseline?" }, T0);
  assert.equal(s.pending[0]!.id, "p1");
  assert.equal(s.pending[0]!.item, undefined);
  const seen: Array<[PendingHuman, string, string, string]> = [];
  const m = {
    afterDecide(
      state: WorkflowState,
      entry: PendingHuman,
      decision: string,
      by: string,
      note: string,
      now: string,
    ) {
      seen.push([entry, decision, by, note]);
      return { ...state, agreements: [...state.agreements, `decided ${entry.id} ${now}`] };
    },
  } as unknown as Methodology;
  const s2 = decide(s, "p1", "approve", "human", "ok", "2026-10-19T01:00:00.000Z", m);
  assert.deepEqual(s2.pending, []);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]![0].id, "p1");
  assert.equal(seen[0]![0].gate, "qa-gate");
  assert.deepEqual(seen[0]!.slice(1), ["approve", "human", "ok"]);
  assert.deepEqual(s2.agreements, ["decided p1 2026-10-19T01:00:00.000Z"]);
  assert.equal(s2.events[s2.events.length - 1]!.type, "pending.decided");
  // without a methodology nothing else happens
  const s3 = decide(s, "p1", "reject", "human", "no", T0);
  assert.deepEqual(s3.pending, []);
  assert.deepEqual(s3.agreements, []);
});

test("B10: gate evidence recorded before the last rework no longer counts; fresh evidence does; second rework resets", () => {
  const T1 = "2026-10-19T01:00:00.000Z";
  const T2 = "2026-10-19T02:00:00.000Z";
  const T3 = "2026-10-19T03:00:00.000Z";
  let s = addEvidence(base(), "A", { kind: "test-report", ref: "r1", by: "dev" }, T0);
  assert.equal(checkGate(s, getItem(s, "A"), gate, "qa").outcome, "pass");
  s = appendEvent(s, "item.rework", "qa", { id: "A", by: "qa", notes: "n" }, T1);
  const stale = checkGate(s, getItem(s, "A"), gate, "qa");
  assert.equal(stale.outcome, "fail");
  if (stale.outcome === "fail") assert.equal(stale.violations[0]!.rule, "gate:evidence");
  assert.equal(getItem(s, "A").evidence.length, 1);
  s = addEvidence(s, "A", { kind: "test-report", ref: "r2", by: "dev" }, T2);
  assert.equal(checkGate(s, getItem(s, "A"), gate, "qa").outcome, "pass");
  s = appendEvent(s, "item.rework", "qa", { id: "A", by: "qa", notes: "m" }, T3);
  assert.equal(checkGate(s, getItem(s, "A"), gate, "qa").outcome, "fail");
});

test("decide judges an escalated pending against the recorded gate.resolved (spec 27, #35)", () => {
  // the static gate lets qa approve; complete() recorded an escalation to human before the pending
  let s = addEvidence(base(), "A", { kind: "test-report", ref: "r", by: "dev" }, T0);
  s = appendEvent(
    s,
    "gate.resolved",
    "qa",
    {
      item: "A",
      gate: "qa-gate",
      requires: [{ capability: "approve-gate" }, "human"],
      evidence: ["test-report"],
      reason: { level: "high", why: "assessed", assessment: "risk/A.md", by: "human" },
    },
    T0,
  );
  s = raisePending(s, { kind: "gate", item: "A", gate: "qa-gate", question: "?" }, T0);
  // no methodology passed: what `exwf decide` does
  assert.throws(
    () => decide(s, "p1", "approve", "qa", "", T0),
    (e) => e instanceof WorkflowError && e.code === "gate-unmet",
  );
  assert.equal(getItem(decide(s, "p1", "approve", "human", "", T0), "A").status, "done");
  // a resolution for another gate or item leaves the static gate in force
  let t = addEvidence(base(), "A", { kind: "test-report", ref: "r", by: "dev" }, T0);
  t = appendEvent(
    t,
    "gate.resolved",
    "qa",
    { item: "B", gate: "qa-gate", requires: ["human"], evidence: [], reason: {} },
    T0,
  );
  t = raisePending(t, { kind: "gate", item: "A", gate: "qa-gate", question: "?" }, T0);
  assert.equal(getItem(decide(t, "p1", "approve", "qa", "", T0), "A").status, "done");
});

test("decide on a crafted gate.resolved with a non-string capability answers, never a TypeError (G2-4)", () => {
  let s = addEvidence(base(), "A", { kind: "test-report", ref: "r", by: "dev" }, T0);
  s = appendEvent(
    s,
    "gate.resolved",
    "qa",
    {
      item: "A",
      gate: "qa-gate",
      requires: [{ capability: "approve-gate" }, { capability: { toString: 1 } }],
      evidence: [],
      reason: {},
    },
    T0,
  );
  s = raisePending(s, { kind: "gate", item: "A", gate: "qa-gate", question: "?" }, T0);
  // the malformed entry has no identity and is skipped; the static gate lets qa approve
  assert.equal(getItem(decide(s, "p1", "approve", "qa", "", T0), "A").status, "done");
});

test("decide uses the gate.resolved recorded with the pending, not a later one (G2-5, G3-1)", () => {
  let s = addEvidence(base(), "A", { kind: "test-report", ref: "r", by: "dev" }, T0);
  const human = { item: "A", gate: "qa-gate", requires: ["human"], evidence: [], reason: {} };
  s = appendEvent(s, "gate.resolved", "qa", human, T0);
  s = raisePending(s, { kind: "gate", item: "A", gate: "qa-gate", question: "?" }, T0);
  // a crafted resolution appended after the pending cannot relax the one it was raised under
  const crafted = appendEvent(s, "gate.resolved", "qa", { ...human, requires: [] }, T0);
  assert.throws(
    () => decide(crafted, "p1", "approve", "qa", "", T0),
    (e) => e instanceof WorkflowError && e.code === "gate-unmet",
  );
  // a resolution not recorded with this pending (an earlier round, another event in between) does
  // not apply: the static gate lets qa approve
  let t = addEvidence(base(), "A", { kind: "test-report", ref: "r", by: "dev" }, T0);
  t = appendEvent(t, "gate.resolved", "qa", human, T0);
  t = addEvidence(t, "A", { kind: "note", ref: "n", by: "dev" }, T0);
  t = raisePending(t, { kind: "gate", item: "A", gate: "qa-gate", question: "?" }, T0);
  assert.equal(getItem(decide(t, "p1", "approve", "qa", "", T0), "A").status, "done");
});
