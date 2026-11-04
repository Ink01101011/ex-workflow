import { test } from "node:test";
import assert from "node:assert/strict";
import { addItem, getItem } from "./record.ts";
import { moveItem } from "./move.ts";
import { T0, base, code } from "./fixtures.ts";

test("moveItem records a transition and guards terminal statuses", () => {
  const s = addItem(base(), { id: "A", title: "First" }, "po", T0);
  const s2 = moveItem(
    s,
    "A",
    { stage: "doing", status: "in_progress" },
    "dev",
    "2026-10-19T01:00:00.000Z",
  );
  const a = getItem(s2, "A");
  assert.equal(a.stage, "doing");
  assert.deepEqual(a.transitions[0], {
    from: { stage: "backlog", status: "todo" },
    to: { stage: "doing", status: "in_progress" },
    at: "2026-10-19T01:00:00.000Z",
    by: "dev",
  });
  const s3 = moveItem(s2, "A", { stage: "done", status: "done" }, "dev", T0);
  assert.throws(
    () => moveItem(s3, "A", { status: "todo" }, "dev"),
    (e) => code(e) === "invalid-transition",
  );
  assert.throws(
    () => moveItem(s2, "A", { stage: "doing", status: "in_progress" }, "dev"),
    (e) => code(e) === "no-op",
  );
});
