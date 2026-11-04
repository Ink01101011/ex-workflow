import { test } from "node:test";
import assert from "node:assert/strict";
import { addItem, getItem } from "./record.ts";
import { clearBlocker, raiseBlocker } from "./blockers.ts";
import { moveItem } from "./move.ts";
import type { WorkflowState } from "../types.ts";
import { T0, base, code } from "./fixtures.ts";

test("blockers", () => {
  let s = addItem(base(), { id: "A", title: "First" }, "po", T0);
  s = raiseBlocker(s, "A", "waiting on API key", "po", "dev", T0);
  assert.equal(getItem(s, "A").status, "blocked");
  assert.equal(getItem(s, "A").blockers[0]!.id, "A-b1");
  assert.equal(s.events.at(-1)!.type, "blocker.raised");
  s = clearBlocker(s, "A", "A-b1", "po", "2026-10-19T02:00:00.000Z");
  assert.equal(getItem(s, "A").status, "todo");
  assert.equal(getItem(s, "A").blockers[0]!.clearedAt, "2026-10-19T02:00:00.000Z");
  assert.throws(
    () => clearBlocker(s, "A", "A-b9", "po"),
    (e) => code(e) === "invalid-input",
  );
});

const tr = (s: WorkflowState) =>
  (s.events.at(-1)!.payload as Record<string, unknown>)["transition"];

test("blocker events carry the item transition they caused, or null", () => {
  let s = addItem(base(), { id: "A", title: "First" }, "po", T0);
  s = raiseBlocker(s, "A", "one", "po", "dev", T0);
  assert.deepEqual(tr(s), {
    from: { stage: "backlog", status: "todo" },
    to: { stage: "backlog", status: "blocked" },
  });
  s = raiseBlocker(s, "A", "two", "po", "dev", T0);
  assert.equal(tr(s), null);
  s = clearBlocker(s, "A", "A-b1", "po", T0);
  assert.equal(tr(s), null);
  assert.deepEqual(s.events.at(-1)!.payload, {
    id: "A",
    blocker: "A-b1",
    transition: null,
    note: null,
  });
  s = clearBlocker(s, "A", "A-b2", "po", T0, "fixed");
  assert.deepEqual(tr(s), {
    from: { stage: "backlog", status: "blocked" },
    to: { stage: "backlog", status: "todo" },
  });
  assert.equal((s.events.at(-1)!.payload as { note: unknown }).note, "fixed");
});

test("clearing a blocker on an in_progress item re-queues it in the stage it was pulled from", () => {
  let s = addItem(base(), { id: "A", title: "First" }, "po", T0);
  s = moveItem(s, "A", { stage: "doing", status: "in_progress" }, "dev", T0);
  s = raiseBlocker(s, "A", "stuck", "po", "dev", T0);
  s = clearBlocker(s, "A", "A-b1", "po", T0);
  assert.equal(getItem(s, "A").stage, "backlog");
  assert.equal(getItem(s, "A").status, "todo");
});
