import { test } from "node:test";
import assert from "node:assert/strict";
import { appendEvent, createState } from "./state.ts";
import { addItem, getItem } from "./items/record.ts";
import { moveItem } from "./items/move.ts";
import { authorOf, authorsOf } from "./authors.ts";
import type { Stage, WorkflowState } from "./types.ts";

const T0 = "2026-11-09T00:00:00.000Z";
const stages: Stage[] = ["dev", "test", "review", "done"].map((id) => ({
  id,
  name: id,
  entryPolicy: [],
  exitPolicy: [],
}));
const base = (): WorkflowState => {
  let s = createState({ methodology: "kanban", config: {}, stages, roles: [], now: T0 });
  s = addItem(s, { id: "A", title: "a" }, "pm", T0);
  s = moveItem(s, "A", { stage: "dev", status: "in_progress" }, "dev", T0);
  s = moveItem(s, "A", { stage: "test", status: "todo" }, "dev", T0);
  s = moveItem(s, "A", { stage: "test", status: "in_progress" }, "qa", T0);
  return moveItem(s, "A", { stage: "review", status: "review" }, "qa", T0);
};
const of = (s: WorkflowState) => authorsOf(s, getItem(s, "A"));

test("authorsOf: every earlier-stage dispatch, then authorOf, each once", () => {
  const s = base();
  assert.equal(authorOf(s, getItem(s, "A")), "qa");
  assert.deepEqual(of(s), ["dev", "qa"]);
});

test("authorsOf: a reviewer dispatched into the current stage and the assigned role are not authors", () => {
  let s = moveItem(base(), "A", { stage: "review", status: "in_progress" }, "rev", T0);
  s = { ...s, items: { ...s.items, A: { ...getItem(s, "A"), role: "rev" } } };
  assert.deepEqual(of(s), ["dev", "qa"]);
});

test("authorsOf: before the last rework, only work the rework did not send back counts", () => {
  let s = appendEvent(base(), "item.rework", "rev", { id: "A", by: "rev", notes: "n" }, T0);
  // the rework sent nothing back yet: every earlier-stage dispatch still counts
  assert.deepEqual(of(s), ["dev", "qa"]);
  // it landed in test: the dev work was not redone and counts, the old test work does not
  s = moveItem(s, "A", { stage: "test", status: "todo" }, "rev", T0);
  s = moveItem(s, "A", { stage: "test", status: "in_progress" }, "qa2", T0);
  s = moveItem(s, "A", { stage: "review", status: "review" }, "qa2", T0);
  assert.deepEqual(of(s), ["dev", "qa2"]);
});

test("authorsOf fails closed: when the transition events do not match the transitions, every dispatch counts", () => {
  let s = appendEvent(base(), "item.rework", "rev", { id: "A", by: "rev", notes: "n" }, T0);
  // a hand-built transition with no event appending it
  const item = getItem(s, "A");
  const extra = { ...item.transitions.at(-1)!, by: "ghost" };
  s = { ...s, items: { ...s.items, A: { ...item, transitions: [...item.transitions, extra] } } };
  assert.deepEqual(of(s), ["dev", "qa"]);
});

test("authorsOf fails closed on unlisted stages: every dispatch counts", () => {
  let s = moveItem(base(), "A", { stage: "review", status: "in_progress" }, "rev", T0);
  const odd = { ...getItem(s, "A"), stage: "nowhere" };
  assert.deepEqual(authorsOf(s, odd), ["dev", "qa", "rev"]);
  // a dispatch from a stage state.stages no longer lists counts
  s = { ...s, stages: s.stages.filter((st) => st.id !== "dev") };
  assert.deepEqual(of(s), ["dev", "qa"]);
});

test("authorsOf (gate G3-4): an unlisted current stage counts every pre-rework dispatch", () => {
  // complete() order: the rework move first, then the item.rework event
  let s = moveItem(base(), "A", { stage: "test", status: "todo" }, "rev", T0);
  s = appendEvent(s, "item.rework", "rev", { id: "A", by: "rev", notes: "n" }, T0);
  s = moveItem(s, "A", { stage: "test", status: "in_progress" }, "qa2", T0);
  const odd = { ...getItem(s, "A"), stage: "nowhere" };
  assert.deepEqual(authorsOf(s, odd), ["dev", "qa", "qa2"]);
});
