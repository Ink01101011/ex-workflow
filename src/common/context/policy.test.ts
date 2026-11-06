import { test } from "node:test";
import assert from "node:assert/strict";
import { appendEvent, createState } from "../../core/state.ts";
import { addItem } from "../../core/items/record.ts";
import { moveItem } from "../../core/items/move.ts";
import type { ContextAssumption, WorkflowState } from "../../core/types.ts";
import { kanban } from "../../methodologies/kanban/index.ts";
import { recordContextSnapshot } from "./snapshot.ts";
import { contextGroundedViolations } from "./policy.ts";

const T0 = "2026-11-06T00:00:00.000Z";
const m = kanban();
const RULE = "policy:custom:context-grounded";
const base = (role?: string): WorkflowState => {
  const config = m.validateConfig({});
  const s = createState({
    methodology: "kanban",
    config,
    stages: m.defaultStages(config),
    roles: m.defaultRoles(config),
    now: T0,
  });
  return addItem(s, { id: "A", title: "a", ...(role ? { role } : {}) }, "srm", T0);
};
const sourced: ContextAssumption = {
  claim: "totals are cents",
  required: true,
  source: { path: "src/cart.ts", hash: "h" },
};
const snap = (s: WorkflowState, assumptions: ContextAssumption[], by = "human") =>
  recordContextSnapshot(s, m, { item: "A", revision: "r1", assumptions, ref: "ctx/A", by }).state;
const check = (s: WorkflowState) => contextGroundedViolations(s, s.items["A"]!);

test("no valid fresh snapshot is a violation with a fix", () => {
  const v = check(base());
  assert.equal(v.length, 1);
  assert.deepEqual([v[0]!.rule, v[0]!.severity, v[0]!.item], [RULE, "error", "A"]);
  assert.match(v[0]!.message, /no context snapshot/);
  assert.match(v[0]!.fix, /recordContextSnapshot/);
});

test("a snapshot with zero unverified required assumptions passes, unverified optional ones included", () => {
  assert.deepEqual(check(snap(base(), [sourced, { claim: "no cache" }])), []);
  assert.deepEqual(check(snap(base(), [])), []);
  assert.deepEqual(check(snap(base(), [{ claim: "no cache", required: false }])), []);
});

test("an unverified required assumption is a violation naming the claims", () => {
  const v = check(
    snap(base(), [sourced, { claim: "tax applied once", required: true }, { claim: "x" }]),
  );
  assert.deepEqual(
    v.map((x) => x.rule),
    [RULE],
  );
  assert.match(v[0]!.message, /tax applied once/);
  assert.doesNotMatch(v[0]!.message, /totals are cents|"x"/);
});

test("a stale snapshot is a violation naming the changed paths", () => {
  let s = snap(base(), [sourced]);
  s = appendEvent(s, "repo.changed", "ci", { revision: "r2", paths: ["src/cart.ts"] }, T0);
  const v = check(s);
  assert.equal(v.length, 1);
  assert.match(v[0]!.message, /stale/);
  assert.match(v[0]!.message, /src\/cart\.ts/);
  assert.deepEqual(check(snap(s, [sourced])), []);
});

test("the worker may not author its own snapshot for required claims", () => {
  // assigned role
  const v = check(snap(base("worker"), [sourced], "worker"));
  assert.equal(v.length, 1);
  assert.match(v[0]!.message, /"worker"/);
  assert.match(v[0]!.fix, /independent/);
  // author (dispatched by the worker, role cleared later)
  let s = moveItem(base(), "A", { stage: "dev", status: "in_progress" }, "worker", T0);
  assert.equal(check(snap(s, [sourced], "worker")).length, 1);
  // an independent role or a human may
  assert.deepEqual(check(snap(s, [sourced], "service-delivery-manager")), []);
  assert.deepEqual(check(snap(s, [sourced], "human")), []);
  // without required claims, the worker's own snapshot is accepted
  s = snap(base("worker"), [{ ...sourced, required: false }], "worker");
  assert.deepEqual(check(s), []);
});

test("several problems are reported together, and the answer is deterministic", () => {
  let s = snap(base("worker"), [sourced, { claim: "unsourced", required: true }], "worker");
  s = appendEvent(s, "repo.changed", "ci", { revision: "r2", paths: ["src/cart.ts"] }, T0);
  const v = check(s);
  assert.equal(v.length, 3);
  assert.deepEqual(check(structuredClone(s)), v);
});
