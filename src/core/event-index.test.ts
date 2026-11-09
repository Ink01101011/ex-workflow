import { test } from "node:test";
import assert from "node:assert/strict";
import type { Event, WorkflowState } from "./types.ts";
import { eventIndex, firstAfter, sinceRework } from "./event-index.ts";

const ev = (type: string, payload: unknown): Event =>
  ({ seq: 0, at: "2026-11-06T00:00:00.000Z", type, by: "x", payload }) as Event;
const state = (events: Event[]) => ({ events }) as unknown as WorkflowState<string>;

test("eventIndex: positions per item, the last rework, and each path's repo.changed entries", () => {
  const s = state([
    ev("item.evidence", { id: "A" }),
    ev("item.transition", { id: "A" }),
    ev("repo.changed", { revision: "r", paths: ["a", "b", "a", 7] }),
    ev("item.rework", { id: "A" }),
    ev("item.evidence", { id: "B" }),
    ev("item.evidence", { id: "A" }),
    ev("repo.changed", { revision: "r", paths: ["b"] }),
    ev("repo.changed", { revision: "r", paths: "a" }),
    ev("item.rework", { id: "A" }),
    ev("item.transition", { id: "A" }),
  ]);
  const ix = eventIndex(s);
  assert.deepEqual(ix.evidence.get("A"), [0, 5]);
  assert.deepEqual(ix.evidence.get("B"), [4]);
  assert.deepEqual(ix.transitions.get("A"), [1, 9]);
  assert.equal(ix.rework.get("A"), 8);
  // every listing, in order; non-strings and non-array paths ignored
  assert.deepEqual(ix.changed.get("a"), [
    [2, 0],
    [2, 2],
  ]);
  assert.deepEqual(ix.changed.get("b"), [
    [2, 1],
    [6, 0],
  ]);
  assert.equal(sinceRework(ix, "A", ix.evidence.get("A")), 0);
  assert.equal(sinceRework(ix, "A", ix.transitions.get("A")), 1);
  assert.equal(sinceRework(ix, "B", ix.evidence.get("B")), undefined);
  assert.equal(sinceRework(ix, "A", undefined), 0);
});

test("G5-1: transition positions include blocker events that appended a transition", () => {
  const t = { from: { stage: "d", status: "todo" }, to: { stage: "d", status: "blocked" } };
  const ix = eventIndex(
    state([
      ev("item.transition", { id: "A" }),
      ev("blocker.raised", { id: "A", blocker: "A-b1", transition: t }),
      ev("blocker.raised", { id: "A", blocker: "A-b2", transition: null }),
      ev("blocker.cleared", { id: "A", blocker: "A-b1", transition: null }),
      ev("blocker.cleared", { id: "A", blocker: "A-b2", transition: t }),
      ev("item.rework", { id: "A" }),
    ]),
  );
  assert.deepEqual(ix.transitions.get("A"), [0, 1, 4]);
});

test("eventIndex is cached per events array and rebuilt when the array changed in place", () => {
  const events = [ev("item.evidence", { id: "A" })];
  const s = state(events);
  const ix = eventIndex(s);
  assert.equal(eventIndex(s), ix);
  assert.equal(eventIndex(state(events)), ix);
  events.push(ev("item.evidence", { id: "A" }));
  assert.deepEqual(eventIndex(s).evidence.get("A"), [0, 1]);
  events[1] = ev("item.evidence", { id: "B" });
  assert.deepEqual(eventIndex(s).evidence.get("B"), [1]);
  assert.notEqual(eventIndex(state([...events])), eventIndex(s));
});

const id = (x: number) => x;

test("firstAfter: binary search over an ascending list", () => {
  const xs = [1, 3, 3, 7];
  assert.deepEqual(
    [-1, 0, 1, 2, 3, 6, 7, 9].map((p) => firstAfter(xs, p, id)),
    [0, 0, 1, 1, 3, 3, 4, 4],
  );
  assert.equal(firstAfter([], 0, id), 0);
});
