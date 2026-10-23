import { test } from "node:test";
import assert from "node:assert/strict";
import { init } from "../methodology.ts";
import { addItem } from "../items.ts";
import { WorkflowError } from "../errors.ts";
import { ZERO_SPENT } from "../budget.ts";
import type { WorkflowState } from "../types.ts";
import { baselinePhase, reopenPhases } from "./baseline.ts";
import { waterfall } from "./index.ts";
import { phasesOf, withPhases } from "./phases.ts";

const T0 = "2026-10-22T00:00:00.000Z";
const T1 = "2026-10-22T01:00:00.000Z";
const setStatus = (
  s: WorkflowState,
  id: string,
  status: "pending" | "open" | "baselined" | "reopened",
) =>
  withPhases(
    s,
    phasesOf(s).map((p) => (p.id === id ? { ...p, status } : p)),
  );

test("baselinePhase freezes the phase, snapshots its items, closes its iteration, versions", () => {
  let s = init({ methodology: waterfall(), config: {}, now: T0 }).state;
  s = addItem(s, { id: "R1", title: "r1", phase: "requirements" }, "human", T0);
  s = addItem(s, { id: "D1", title: "d1", phase: "design" }, "human", T0);
  s = setStatus(s, "requirements", "open");
  s = {
    ...s,
    iterations: [
      {
        id: "requirements#1",
        goal: "Requirements",
        budget: {},
        spent: ZERO_SPENT,
        startedAt: T0,
        committed: ["R1"],
        carryover: [],
      },
    ],
  };
  s = baselinePhase(s, "requirements", ["project-manager", "human"], T1);
  assert.equal(phasesOf(s)[0]!.status, "baselined");
  assert.equal(s.baselines!.length, 1);
  assert.deepEqual(s.baseline, s.baselines![0]);
  assert.equal(s.baseline!.version, 1);
  assert.deepEqual(s.baseline!.approvedBy, ["project-manager", "human"]);
  assert.deepEqual(Object.keys(s.baseline!.itemSnapshot), ["R1"]);
  assert.equal(s.iterations[0]!.endedAt, T1);
  assert.equal(s.iterations[0]!.outcome, "completed");
  const ev = s.events[s.events.length - 1]!;
  assert.equal(ev.type, "phase.baselined");
  assert.deepEqual(ev.payload, {
    phase: "requirements",
    version: 1,
    approvedBy: ["project-manager", "human"],
    items: ["R1"],
  });
  assert.throws(
    () => baselinePhase(s, "requirements", ["human"], T1),
    (e: unknown) =>
      e instanceof WorkflowError && e.code === "invalid-transition" && /baselined/.test(e.message),
  );
  // second baseline of the same phase is version 2
  s = setStatus(s, "requirements", "open");
  s = baselinePhase(s, "requirements", ["human"], T1);
  assert.equal(s.baseline!.version, 2);
  assert.equal(s.baselines!.length, 2);
});

test("reopenPhases reopens baselined phases, suspends a later open phase, refuses pending ones", () => {
  let s = init({ methodology: waterfall(), config: {}, now: T0 }).state;
  s = setStatus(s, "requirements", "baselined");
  s = setStatus(s, "design", "baselined");
  s = setStatus(s, "implementation", "open");
  s = {
    ...s,
    iterations: [
      {
        id: "implementation#1",
        goal: "Implementation",
        budget: {},
        spent: ZERO_SPENT,
        startedAt: T0,
        committed: [],
        carryover: [],
      },
    ],
  };
  const r = reopenPhases(s, ["design"], T1);
  assert.deepEqual(r.reopened, ["design"]);
  assert.equal(r.suspended, "implementation");
  assert.deepEqual(
    phasesOf(r.state).map((p) => p.status),
    ["baselined", "reopened", "reopened", "pending", "pending", "pending"],
  );
  assert.equal(r.state.iterations[0]!.outcome, "cancelled");
  assert.equal(r.state.iterations[0]!.endedAt, T1);
  // reopening the open phase itself is a no-op for it; nothing is suspended
  const r2 = reopenPhases(s, ["implementation"], T1);
  assert.deepEqual(r2.reopened, []);
  assert.equal(r2.suspended, null);
  assert.equal(r2.state.iterations[0]!.endedAt, undefined);
  assert.throws(
    () => reopenPhases(s, ["verification"], T1),
    (e: unknown) =>
      e instanceof WorkflowError && e.code === "invalid-input" && /never baselined/.test(e.message),
  );
  assert.throws(
    () => reopenPhases(s, ["nope"], T1),
    (e: unknown) => e instanceof WorkflowError && e.code === "config-invalid",
  );
});
