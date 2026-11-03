import { test } from "node:test";
import assert from "node:assert/strict";
import { addItem, getItem } from "./record.ts";
import { addEvidence } from "./evidence.ts";
import { T0, base } from "./fixtures.ts";

test("addEvidence appends a timestamped entry and an event", () => {
  let s = addItem(base(), { id: "A", title: "First" }, "po", T0);
  s = addEvidence(s, "A", { kind: "test-output", ref: "ci#1", by: "dev" }, T0);
  assert.deepEqual(getItem(s, "A").evidence[0], {
    kind: "test-output",
    ref: "ci#1",
    by: "dev",
    at: T0,
  });
  assert.equal(s.events.at(-1)!.type, "item.evidence");
});
