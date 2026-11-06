import { test } from "node:test";
import assert from "node:assert/strict";
import { appendEvent, createState } from "../../core/state.ts";
import { addEvidence } from "../../core/items/evidence.ts";
import { addItem } from "../../core/items/record.ts";
import { moveItem } from "../../core/items/move.ts";
import type { ContextAssumption, Role, WorkflowState } from "../../core/types.ts";
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
  assert.match(v[0]!.message, /no qualifying context snapshot/);
  assert.match(v[0]!.fix, /recordContextSnapshot/);
});

test("a snapshot with zero unverified required assumptions passes, unverified optional ones included", () => {
  assert.deepEqual(check(snap(base(), [sourced, { claim: "no cache" }])), []);
  assert.deepEqual(check(snap(base(), [{ ...sourced, required: false }])), []);
  assert.deepEqual(
    check(
      snap(base(), [
        { ...sourced, required: false },
        { claim: "no cache", required: false },
      ]),
    ),
    [],
  );
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

test("the worker may not ground its own item: the recorder refuses it and a hand-written one is ignored", () => {
  const own = (st: WorkflowState) =>
    addEvidence(
      st,
      "A",
      {
        kind: "context-snapshot",
        ref: "ctx/own",
        by: "worker",
        data: { revision: "r", assumptions: [sourced] } as never,
      },
      T0,
    );
  // assigned role
  assert.throws(() => snap(base("worker"), [sourced], "worker"), /worked on/);
  assert.match(check(own(base("worker")))[0]!.message, /no qualifying/);
  // author (dispatched by the worker, role cleared later)
  const s = moveItem(base(), "A", { stage: "dev", status: "in_progress" }, "worker", T0);
  assert.throws(() => snap(s, [sourced], "worker"), /worked on/);
  assert.match(check(own(s))[0]!.message, /no qualifying/);
  // with or without required claims
  assert.throws(() => snap(s, [{ ...sourced, required: false }], "worker"), /worked on/);
  // an independent role or a human may
  assert.deepEqual(check(snap(s, [sourced], "service-delivery-manager")), []);
  assert.deepEqual(check(snap(s, [sourced], "human")), []);
});

test("several problems are reported together, and the answer is deterministic", () => {
  let s = snap(base("worker"), [sourced, { claim: "unsourced", required: true }]);
  s = appendEvent(s, "repo.changed", "ci", { revision: "r2", paths: ["src/cart.ts"] }, T0);
  const v = check(s);
  assert.equal(v.length, 2);
  assert.deepEqual(check(structuredClone(s)), v);
});

test("G1-1: a worker of an earlier stage may not ground the item, not only the last author", () => {
  const role = (id: string): Role => ({
    id,
    name: id,
    modelTier: "small",
    capabilities: ["deliver"],
    canApprove: [],
    inputs: [],
    outputs: [],
    do_not: [],
  });
  let s = createState({
    methodology: "kanban",
    config: m.validateConfig({}),
    stages: ["dev", "test", "review"].map((id) => ({
      id,
      name: id,
      entryPolicy: [],
      exitPolicy: [],
    })),
    roles: ["dev", "tester", "scout"].map(role),
    now: T0,
  });
  s = addItem(s, { id: "A", title: "a" }, "pm", T0);
  s = moveItem(s, "A", { stage: "dev", status: "in_progress" }, "dev", T0);
  s = moveItem(s, "A", { stage: "test", status: "in_progress" }, "tester", T0);
  s = moveItem(s, "A", { stage: "review", status: "todo" }, "tester", T0);
  for (const by of ["dev", "tester"]) {
    assert.throws(() => snap(s, [sourced], by), /worked on/, by);
    const own = addEvidence(
      s,
      "A",
      {
        kind: "context-snapshot",
        ref: "ctx/own",
        by,
        data: { revision: "r", assumptions: [sourced] } as never,
      },
      T0,
    );
    assert.match(check(own)[0]!.message, /no qualifying/, by);
  }
  assert.deepEqual(check(snap(s, [sourced], "scout")), []);
});

test("G1-2, G2-1: a worker cannot ground its own item, nor replace a stale independent snapshot", () => {
  let s = moveItem(base(), "A", { stage: "dev", status: "in_progress" }, "worker", T0);
  // a worker-written snapshot (hand-built: the recorder refuses it) never counts, empty or not
  const own = (st: WorkflowState, assumptions: ContextAssumption[]) =>
    addEvidence(
      st,
      "A",
      {
        kind: "context-snapshot",
        ref: "ctx/own",
        by: "worker",
        data: { revision: "r", assumptions } as never,
      },
      T0,
    );
  assert.match(check(own(s, []))[0]!.message, /no qualifying context snapshot/);
  assert.match(check(own(s, [{ ...sourced, required: false }]))[0]!.message, /no qualifying/);
  // an independent snapshot gone stale stays the one that counts
  s = snap(s, [sourced], "service-delivery-manager");
  s = appendEvent(s, "repo.changed", "ci", { revision: "r2", paths: ["src/cart.ts"] }, T0);
  const v = check(own(s, [{ ...sourced, required: false }]));
  assert.equal(v.length, 1);
  assert.match(v[0]!.message, /stale/);
});
