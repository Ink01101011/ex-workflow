import { test } from "node:test";
import assert from "node:assert/strict";
import { appendEvent, createState } from "../core/state.ts";
import { addItem, getItem } from "../core/items/record.ts";
import { moveItem } from "../core/items/move.ts";
import { clearBlocker, raiseBlocker } from "../core/items/blockers.ts";
import type { Role, Stage, WorkflowState } from "../core/types.ts";
import { workersOf } from "./workers.ts";

const T0 = "2026-11-06T00:00:00.000Z";
const r = (id: string): Role => ({
  id,
  name: id,
  modelTier: "small",
  capabilities: ["deliver"],
  canApprove: [],
  inputs: [],
  outputs: [],
  do_not: [],
});
const stages: Stage[] = ["dev", "test", "review"].map((id) => ({
  id,
  name: id,
  entryPolicy: [],
  exitPolicy: [],
}));
const base = (): WorkflowState => {
  const s = createState({
    methodology: "kanban",
    config: {},
    stages,
    roles: ["dev", "tester", "rev"].map(r),
    now: T0,
  });
  return addItem(s, { id: "A", title: "a" }, "pm", T0);
};
const walk = (s: WorkflowState, steps: [string, string][]) =>
  steps.reduce((st, [stage, by]) => moveItem(st, "A", { stage, status: "in_progress" }, by, T0), s);
const of = (s: WorkflowState) => workersOf(s, getItem(s, "A"));

test("workersOf: every role that dispatched the item, in order, plus its assigned role", () => {
  assert.deepEqual(of(base()), []);
  let s = walk(base(), [
    ["dev", "dev"],
    ["test", "tester"],
    ["review", "rev"],
  ]);
  assert.deepEqual(of(s), ["dev", "tester", "rev"]);
  s = { ...s, items: { ...s.items, A: { ...getItem(s, "A"), role: "pm" } } };
  assert.deepEqual(of(s), ["dev", "tester", "rev", "pm"]);
  // a move into any other status is not a dispatch
  s = moveItem(s, "A", { stage: "review", status: "review" }, "ops", T0);
  assert.equal(of(s).includes("ops"), false);
});

test("workersOf: only dispatches since the item's last rework count, plus the 1.3 author", () => {
  let s = walk(base(), [
    ["dev", "dev"],
    ["test", "tester"],
  ]);
  s = moveItem(s, "A", { stage: "dev", status: "todo" }, "tester", T0);
  s = appendEvent(s, "item.rework", "tester", { id: "A", by: "tester", notes: "n" }, T0);
  // the author by the 1.3 rule (the last dispatch) still counts; the earlier dev dispatch does not
  assert.deepEqual(of(s), ["tester"]);
  s = walk(s, [["dev", "rev"]]);
  assert.deepEqual(of(s), ["rev"]);
});

test("G5-1: a blocker raised and cleared after the rework does not drop post-rework dispatches", () => {
  let s = walk(base(), [
    ["dev", "dev"],
    ["test", "tester"],
  ]);
  s = moveItem(s, "A", { stage: "dev", status: "todo" }, "tester", T0);
  s = appendEvent(s, "item.rework", "tester", { id: "A", by: "tester", notes: "n" }, T0);
  s = walk(s, [
    ["dev", "dev"],
    ["test", "tester"],
  ]);
  // two blocked/cleared pairs: each appends transitions through blocker.* events, not item.transition
  for (const n of [1, 2]) {
    s = raiseBlocker(s, "A", "env down", "pm", "tester", T0);
    s = clearBlocker(s, "A", `A-b${n}`, "pm", T0);
    s = walk(s, [["test", "tester"]]);
  }
  s = walk(s, [["review", "rev"]]);
  assert.deepEqual(of(s), ["dev", "tester", "rev"]);
});

test("G5-1: a log that does not account for every transition counts all of them (fail closed)", () => {
  let s = walk(base(), [
    ["dev", "dev"],
    ["test", "tester"],
  ]);
  s = moveItem(s, "A", { stage: "dev", status: "todo" }, "tester", T0);
  s = appendEvent(s, "item.rework", "tester", { id: "A", by: "tester", notes: "n" }, T0);
  s = walk(s, [["dev", "rev"]]);
  // a transition no event records (a hand-edited state): the rework boundary is unknown
  const A = getItem(s, "A");
  const extra = { ...A.transitions.at(-1)!, by: "ops" };
  s = { ...s, items: { ...s.items, A: { ...A, transitions: [...A.transitions, extra] } } };
  assert.deepEqual(of(s), ["dev", "tester", "rev", "ops"]);
});
