import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkflowError, fail } from "./errors.ts";

test("fail throws a WorkflowError carrying code, fix and items", () => {
  assert.throws(
    () =>
      fail("unknown-item", "item X does not exist", "add it with addItem first", { items: ["X"] }),
    (e: unknown) =>
      e instanceof WorkflowError &&
      e.code === "unknown-item" &&
      e.fix === "add it with addItem first" &&
      e.items?.[0] === "X" &&
      e.name === "WorkflowError",
  );
});

test("WorkflowError requires a non-empty fix", () => {
  assert.throws(() => new WorkflowError("no-op", "nothing changed", ""), /fix must not be empty/);
});

test("WorkflowError serialises to a plain object", () => {
  const e = new WorkflowError("rule-violation", "m", "f", { rule: "wip-respected" });
  assert.deepEqual(e.toJSON(), {
    code: "rule-violation",
    message: "m",
    fix: "f",
    rule: "wip-respected",
  });
});
