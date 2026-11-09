import { test } from "node:test";
import assert from "node:assert/strict";
import { appendEvent, createState } from "./state.ts";
import { addEvidence } from "./items/evidence.ts";
import { addItem } from "./items/record.ts";
import { moveItem } from "./items/move.ts";
import { assertPolicies, evaluatePolicies } from "./policies.ts";
import { WorkflowError } from "./errors.ts";
import type { Policy, Stage, Violation } from "./types.ts";

const T0 = "2026-10-19T00:00:00.000Z";
const stages: Stage[] = [
  { id: "todo", name: "To do", entryPolicy: [], exitPolicy: [] },
  { id: "done", name: "Done", entryPolicy: [], exitPolicy: [] },
];
const base = () => createState({ methodology: "scrum", config: {}, stages, roles: [], now: T0 });
const all: Policy[] = [
  { kind: "evidence", evidenceKind: "test-output" },
  { kind: "acceptance-written" },
  { kind: "estimate-present" },
  { kind: "no-open-blockers" },
  { kind: "dependencies-done" },
  { kind: "custom", id: "lint", description: "lint passes" },
];

test("every policy kind reports when unmet, with a fix", () => {
  let s = addItem(base(), { id: "D", title: "dep" }, "po", T0);
  s = addItem(s, { id: "A", title: "a", dependsOn: ["D"] }, "po", T0);
  const v = evaluatePolicies(s, s.items["A"]!, all);
  assert.deepEqual(
    v.map((x) => x.rule),
    [
      "policy:evidence",
      "policy:acceptance-written",
      "policy:estimate-present",
      "policy:dependencies-done",
      "policy:custom:lint",
    ],
  );
  assert.ok(v.every((x) => x.fix.length > 0 && x.item === "A" && x.severity === "error"));
});

test("policies pass when satisfied", () => {
  let s = addItem(base(), { id: "D", title: "dep" }, "po", T0);
  s = moveItem(s, "D", { stage: "done", status: "done" }, "dev", T0);
  s = addItem(
    s,
    { id: "A", title: "a", dependsOn: ["D"], acceptance: ["works"], weight: 2 },
    "po",
    T0,
  );
  s = addEvidence(s, "A", { kind: "test-output", ref: "ci", by: "dev" }, T0);
  s = addEvidence(s, "A", { kind: "policy:lint", ref: "ci", by: "dev" }, T0);
  assert.deepEqual(evaluatePolicies(s, s.items["A"]!, all), []);
  assert.doesNotThrow(() => assertPolicies(s, s.items["A"]!, all, "leave todo"));
});

test("assertPolicies throws policy-unmet naming all fixes", () => {
  const s = addItem(base(), { id: "A", title: "a" }, "po", T0);
  assert.throws(
    () => assertPolicies(s, s.items["A"]!, all.slice(0, 2), "leave todo"),
    (e: unknown) =>
      e instanceof WorkflowError &&
      e.code === "policy-unmet" &&
      /test-output/.test(e.fix) &&
      /acceptance/.test(e.fix),
  );
});

const T1 = "2026-10-19T01:00:00.000Z";
const T2 = "2026-10-19T02:00:00.000Z";
const T3 = "2026-10-19T03:00:00.000Z";
const evPolicy: Policy[] = [
  { kind: "evidence", evidenceKind: "test-output" },
  { kind: "custom", id: "lint", description: "lint passes" },
];

test("B10: evidence from before the last rework no longer satisfies evidence or custom policies", () => {
  let s = addItem(base(), { id: "A", title: "a" }, "po", T0);
  s = addEvidence(s, "A", { kind: "test-output", ref: "ci1", by: "dev" }, T0);
  s = addEvidence(s, "A", { kind: "policy:lint", ref: "ci1", by: "dev" }, T0);
  assert.deepEqual(evaluatePolicies(s, s.items["A"]!, evPolicy), []);
  s = appendEvent(s, "item.rework", "qa", { id: "A", by: "qa", notes: "again" }, T1);
  assert.deepEqual(
    evaluatePolicies(s, s.items["A"]!, evPolicy).map((x) => x.rule),
    ["policy:evidence", "policy:custom:lint"],
  );
  assert.equal(s.items["A"]!.evidence.length, 2); // kept, just not counted
  s = addEvidence(s, "A", { kind: "test-output", ref: "ci2", by: "dev" }, T2);
  s = addEvidence(s, "A", { kind: "policy:lint", ref: "ci2", by: "dev" }, T2);
  assert.deepEqual(evaluatePolicies(s, s.items["A"]!, evPolicy), []);
});

test("B10: a second rework resets freshness again; another item's rework does not", () => {
  let s = addItem(base(), { id: "A", title: "a" }, "po", T0);
  s = addItem(s, { id: "B", title: "b" }, "po", T0);
  s = addEvidence(s, "A", { kind: "test-output", ref: "ci1", by: "dev" }, T0);
  s = appendEvent(s, "item.rework", "qa", { id: "B", by: "qa", notes: "x" }, T1);
  assert.deepEqual(evaluatePolicies(s, s.items["A"]!, evPolicy.slice(0, 1)), []);
  s = appendEvent(s, "item.rework", "qa", { id: "A", by: "qa", notes: "x" }, T1);
  s = addEvidence(s, "A", { kind: "test-output", ref: "ci2", by: "dev" }, T2);
  assert.deepEqual(evaluatePolicies(s, s.items["A"]!, evPolicy.slice(0, 1)), []);
  s = appendEvent(s, "item.rework", "qa", { id: "A", by: "qa", notes: "y" }, T3);
  assert.equal(evaluatePolicies(s, s.items["A"]!, evPolicy.slice(0, 1)).length, 1);
});

test("B10: freshness follows event order, not timestamps: evidence before the rework event is stale even at the same instant, evidence after it counts", () => {
  let s = addItem(base(), { id: "A", title: "a" }, "po", T0);
  // the rework completion attaches the reviewer's evidence, then emits item.rework, at one `at`
  s = addEvidence(s, "A", { kind: "test-output", ref: "reviewer-notes", by: "qa" }, T1);
  s = appendEvent(s, "item.rework", "qa", { id: "A", by: "qa", notes: "n" }, T1);
  assert.equal(
    evaluatePolicies(s, s.items["A"]!, evPolicy.slice(0, 1)).length,
    1,
    "pre-rework evidence does not count",
  );
  // the author's next completion at the same injected instant counts
  s = addEvidence(s, "A", { kind: "test-output", ref: "ci-2", by: "dev" }, T1);
  assert.deepEqual(evaluatePolicies(s, s.items["A"]!, evPolicy.slice(0, 1)), []);
  // another item's rework leaves A alone
  s = addItem(s, { id: "B", title: "b" }, "po", T1);
  s = appendEvent(s, "item.rework", "qa", { id: "B", by: "qa", notes: "n" }, T1);
  assert.deepEqual(evaluatePolicies(s, s.items["A"]!, evPolicy.slice(0, 1)), []);
});

test("B10: a hand-built state with more item.evidence events than entries keeps every entry", () => {
  let s = addItem(base(), { id: "A", title: "a" }, "po", T0);
  s = addEvidence(s, "A", { kind: "test-output", ref: "ci1", by: "dev" }, T0);
  s = appendEvent(s, "item.rework", "qa", { id: "A", by: "qa", notes: "n" }, T0);
  s = addEvidence(s, "A", { kind: "code", ref: "x", by: "dev" }, T0);
  s = addEvidence(s, "A", { kind: "code", ref: "y", by: "dev" }, T0);
  for (let i = 0; i < 3; i++) s = appendEvent(s, "item.evidence", "dev", { id: "A" }, T0);
  assert.deepEqual(evaluatePolicies(s, s.items["A"]!, evPolicy.slice(0, 1)), []);
});

// ---- #36 custom-policy hook (design spec section 27) -------------------
const grounded: Policy = { kind: "custom", id: "context-grounded", description: "grounded" };
const hooked = (answer: Violation[] | undefined, seen: Policy[] = []) => ({
  customPolicy: (_s: unknown, _i: unknown, p: Policy) => {
    seen.push(p);
    return answer;
  },
});
const ungrounded: Violation = {
  rule: "policy:custom:context-grounded",
  severity: "error",
  item: "A",
  message: "no snapshot",
  fix: "record one",
};

test("#36: a methodology's customPolicy answers a custom policy instead of the evidence check", () => {
  const s = addItem(base(), { id: "A", title: "a" }, "po", T0);
  const seen: Policy[] = [];
  // the hook passes it although no policy:context-grounded evidence exists
  assert.deepEqual(evaluatePolicies(s, s.items["A"]!, [grounded], hooked([], seen)), []);
  assert.deepEqual(seen, [grounded]);
  assert.deepEqual(evaluatePolicies(s, s.items["A"]!, [grounded], hooked([ungrounded])), [
    ungrounded,
  ]);
  // non-custom policies never reach the hook
  const none: Policy[] = [];
  evaluatePolicies(s, s.items["A"]!, all.slice(0, 5), hooked([], none));
  assert.deepEqual(none, []);
});

test("#36: without a hook, or when it returns undefined, another custom policy keeps the 1.2 evidence check", () => {
  const lint: Policy = { kind: "custom", id: "lint", description: "lint clean" };
  let s = addItem(base(), { id: "A", title: "a" }, "po", T0);
  const rules = (m?: ReturnType<typeof hooked>) =>
    evaluatePolicies(s, s.items["A"]!, [lint], m).map((v) => v.rule);
  assert.deepEqual(rules(), ["policy:custom:lint"]);
  assert.deepEqual(rules(hooked(undefined)), ["policy:custom:lint"]);
  assert.deepEqual(rules({} as ReturnType<typeof hooked>), ["policy:custom:lint"]);
  s = addEvidence(s, "A", { kind: "policy:lint", ref: "x", by: "dev" }, T0);
  assert.deepEqual(rules(), []);
  assert.deepEqual(rules(hooked(undefined)), []);
});

test("#47: the reserved context-grounded policy fails closed without a hook; its evidence never satisfies it", () => {
  let s = addItem(base(), { id: "A", title: "a" }, "po", T0);
  s = addEvidence(s, "A", { kind: "policy:context-grounded", ref: "x", by: "dev" }, T0);
  for (const m of [undefined, hooked(undefined), {} as ReturnType<typeof hooked>]) {
    const out: Violation[] = evaluatePolicies(s, s.items["A"]!, [grounded], m);
    assert.deepEqual(
      out.map((v) => v.rule),
      ["policy:custom:context-grounded"],
    );
    assert.match(out[0]!.message, /context-grounding hook/);
    assert.match(out[0]!.fix, /withContextGrounding/);
  }
  // a hook still answers it
  assert.deepEqual(evaluatePolicies(s, s.items["A"]!, [grounded], hooked([])), []);
});

test("#36: assertPolicies takes the methodology as an optional trailing argument", () => {
  const s = addItem(base(), { id: "A", title: "a" }, "po", T0);
  assert.doesNotThrow(() => assertPolicies(s, s.items["A"]!, [grounded], "enter dev", hooked([])));
  assert.throws(
    () => assertPolicies(s, s.items["A"]!, [grounded], "enter dev", hooked([ungrounded])),
    (e: unknown) =>
      e instanceof WorkflowError && e.code === "policy-unmet" && e.fix === "record one",
  );
  assert.throws(
    () => assertPolicies(s, s.items["A"]!, [grounded], "enter dev"),
    (e: unknown) => e instanceof WorkflowError && e.code === "policy-unmet",
  );
});
