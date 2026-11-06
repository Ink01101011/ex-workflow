import { test } from "node:test";
import assert from "node:assert/strict";
import { appendEvent, createState } from "./state.ts";
import { addEvidence } from "./items/evidence.ts";
import { addItem, getItem } from "./items/record.ts";
import { moveItem } from "./items/move.ts";
import { checkGate } from "./gates.ts";
import { resolvedGate, widenGate } from "./gate-escalation.ts";
import type { Gate, GateEscalation, GateRequirement, Role, Stage } from "./types.ts";

const T0 = "2026-11-06T00:00:00.000Z";

// seeded LCG (no Math.random in the engine or its property tests)
const lcg = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const CAPS = ["review", "verify", "approve-gate"];
const KINDS = ["test-report", "risk-assessment", "sbom"];
const pick = <T>(rnd: () => number, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const some = <T>(rnd: () => number, xs: readonly T[]): T[] => xs.filter(() => rnd() < 0.4);
const reqs = (rnd: () => number): GateRequirement[] => [
  ...(rnd() < 0.3 ? ["human" as const] : []),
  ...some(rnd, CAPS).map((capability) => ({ capability })),
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
  r("qa", ["review", "verify", "approve-gate"], ["g"]),
  r("rev", ["review"], ["g"]),
];
const stages: Stage[] = [
  { id: "doing", name: "Doing", entryPolicy: [], exitPolicy: [] },
  { id: "verify", name: "Verify", entryPolicy: [], exitPolicy: [] },
];
const base = (evidence: string[]) => {
  let s = createState({ methodology: "kanban", config: {}, stages, roles, now: T0 });
  s = addItem(s, { id: "A", title: "a" }, "pm", T0);
  s = moveItem(s, "A", { stage: "doing", status: "in_progress" }, "dev", T0);
  s = moveItem(s, "A", { stage: "verify", status: "review" }, "dev", T0);
  for (const kind of evidence) s = addEvidence(s, "A", { kind, ref: kind, by: "dev" }, T0);
  return s;
};

test("widenGate appends missing requirements and evidence and keeps the rest of the gate", () => {
  const gate: Gate = {
    id: "g",
    requires: [{ capability: "review" }],
    evidence: ["test-report"],
    onFail: { action: "return-to", stage: "doing" },
  };
  const wide = widenGate(gate, {
    requires: ["human", { capability: "review" }],
    evidence: ["test-report", "sbom"],
  });
  assert.deepEqual(wide, {
    id: "g",
    requires: [{ capability: "review" }, "human"],
    evidence: ["test-report", "sbom"],
    onFail: { action: "return-to", stage: "doing" },
  });
  assert.deepEqual(widenGate(gate, undefined), gate);
  // the static gate is not mutated
  assert.deepEqual(gate.requires, [{ capability: "review" }]);
});

test("widenGate ignores malformed hook output instead of applying it as given", () => {
  const gate: Gate = { id: "g", requires: ["human"], evidence: [], onFail: { action: "block" } };
  const junk = {
    requires: [{ capability: "" }, { cap: "x" }, 7, null, "robot"],
    evidence: ["", 3],
    reason: {},
  } as unknown as GateEscalation;
  assert.deepEqual(widenGate(gate, junk), gate);
  assert.deepEqual(widenGate(gate, { requires: "human", evidence: null } as never), gate);
  // a non-array counts as one entry
  const open: Gate = { ...gate, requires: [] };
  assert.deepEqual(widenGate(open, { requires: "human", evidence: "sbom" } as never), {
    ...open,
    requires: ["human"],
    evidence: ["sbom"],
  });
});

test("widenGate gives a requirement identity only for a non-empty string capability (G1-7, G2-4)", () => {
  const open: Gate = { id: "g", requires: [], evidence: [], onFail: { action: "block" } };
  // a truthy non-string capability no longer collides with "human" and is skipped
  const x = {
    requires: [{ capability: 1 }, "human", { capability: { toString: 1 } }],
    evidence: [],
  };
  assert.deepEqual(widenGate(open, x as never).requires, ["human"]);
  const human: Gate = { ...open, requires: ["human"] };
  assert.deepEqual(widenGate(human, x as never).requires, ["human"]);
  assert.deepEqual(
    widenGate(open, { requires: [{ capability: "" }], evidence: [] } as never),
    open,
  );
});

test("property: a widened gate never answers pass where the static gate does not (500 seeded cases)", () => {
  const rnd = lcg(35);
  for (let n = 0; n < 500; n++) {
    const gate: Gate = {
      id: "g",
      requires: reqs(rnd),
      evidence: some(rnd, KINDS),
      onFail: { action: "block" },
    };
    const x: GateEscalation = { requires: reqs(rnd), evidence: some(rnd, KINDS), reason: {} };
    const wide = widenGate(gate, x);
    // superset, static entries first and unchanged
    assert.deepEqual(wide.requires.slice(0, gate.requires.length), gate.requires);
    assert.deepEqual(wide.evidence.slice(0, gate.evidence.length), gate.evidence);
    for (const q of x.requires)
      assert.ok(
        wide.requires.some((w) =>
          q === "human" ? w === "human" : w !== "human" && w.capability === q.capability,
        ),
      );
    for (const k of x.evidence) assert.ok(wide.evidence.includes(k));
    // idempotent
    assert.deepEqual(widenGate(wide, x), wide);
    const s = base(some(rnd, KINDS));
    const item = getItem(s, "A");
    const by = pick(rnd, ["human", "qa", "rev", "dev"]);
    const before = checkGate(s, item, gate, by).outcome;
    const after = checkGate(s, item, wide, by).outcome;
    if (after === "pass") assert.equal(before, "pass", `case ${n}`);
    if (before !== "pass") assert.notEqual(after, "pass", `case ${n}`);
  }
});

test("resolvedGate widens by the gate.resolved recorded with the pending only (G2-5)", () => {
  const gate: Gate = {
    id: "g",
    requires: [{ capability: "review" }],
    evidence: [],
    onFail: { action: "block" },
  };
  const pend = (s: ReturnType<typeof base>) => appendEvent(s, "pending.raised", "system", {}, T0);
  const at = (s: ReturnType<typeof base>) => s.events.length - 1;
  const res = (item: string, g: string, requires: unknown[], evidence: string[] = []) => ({
    item,
    gate: g,
    requires,
    evidence,
    reason: {},
  });
  let s = pend(base([]));
  assert.deepEqual(resolvedGate(s, "A", gate, at(s)), gate);
  assert.deepEqual(resolvedGate(s, "A", gate, -1), gate);
  // another item's or gate's resolution does not apply
  for (const x of [res("B", "g", ["human"]), res("A", "other", ["human"])]) {
    s = pend(appendEvent(base([]), "gate.resolved", "qa", x, T0));
    assert.deepEqual(resolvedGate(s, "A", gate, at(s)), gate);
  }
  // the one just before the pending (the item's own transitions may sit in between) applies
  s = appendEvent(base([]), "gate.resolved", "qa", res("A", "g", ["human"], ["sbom"]), T0);
  s = pend(moveItem(s, "A", { status: "awaiting_human" }, "system", T0));
  assert.deepEqual(resolvedGate(s, "A", gate, at(s)).requires, [{ capability: "review" }, "human"]);
  assert.deepEqual(resolvedGate(s, "A", gate, at(s)).evidence, ["sbom"]);
  // a later one does not, and a recorded payload can never remove a static requirement
  const later = appendEvent(s, "gate.resolved", "qa", res("A", "g", []), T0);
  assert.deepEqual(resolvedGate(later, "A", gate, at(s)).requires, [
    { capability: "review" },
    "human",
  ]);
  s = pend(appendEvent(base([]), "gate.resolved", "qa", res("A", "g", []), T0));
  assert.deepEqual(resolvedGate(s, "A", gate, at(s)).requires, [{ capability: "review" }]);
});
