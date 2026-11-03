import { test } from "node:test";
import assert from "node:assert/strict";
import { independenceConflicts } from "./independence.ts";

test("independenceConflicts returns no ids when the verifier did none of the work", () => {
  assert.deepEqual(independenceConflicts("reviewer", ["builder", "investigator"]), []);
  assert.deepEqual(independenceConflicts(["a", "b"], []), []);
  assert.deepEqual(independenceConflicts([], ["a"]), []);
});

test("independenceConflicts returns the verifier ids that also did the work", () => {
  assert.deepEqual(independenceConflicts("builder", ["builder"]), ["builder"]);
  assert.deepEqual(independenceConflicts(["x", "b", "a"], ["a", "b"]), ["b", "a"]);
});

test("independenceConflicts lists each conflicting id once, in verifier order", () => {
  assert.deepEqual(independenceConflicts(["a", "a", "b"], ["b", "a", "a"]), ["a", "b"]);
});

test("independenceConflicts compares ids exactly", () => {
  assert.deepEqual(independenceConflicts("Builder", ["builder"]), []);
  assert.deepEqual(independenceConflicts("", ["builder"]), []);
});
