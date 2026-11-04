import { test } from "node:test";
import assert from "node:assert/strict";
import { deepFreeze } from "./deep-freeze.ts";

test("deepFreeze freezes nested objects and arrays and returns the same value", () => {
  const v = { a: [{ b: 1 }], c: { d: "x" } };
  assert.equal(deepFreeze(v), v);
  assert.ok(
    Object.isFrozen(v) && Object.isFrozen(v.a) && Object.isFrozen(v.a[0]) && Object.isFrozen(v.c),
  );
  assert.equal(deepFreeze(3), 3);
});
