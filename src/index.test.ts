import { test } from "node:test";
import assert from "node:assert/strict";
import { VERSION } from "./index.ts";

test("package exposes a version", () => {
  assert.equal(VERSION, "1.0.1");
});
