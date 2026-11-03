import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkflowError, assertId, fail } from "./errors.ts";

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

test("assertId caps the length and refuses Windows device names and Object.prototype members (U9 P7, U11 O1/O9)", () => {
  const bad = (id: unknown) =>
    assert.throws(
      () => assertId(id, "item id"),
      (e: unknown) => e instanceof WorkflowError && e.code === "invalid-input",
      String(id),
    );
  for (const ok of [
    "CART-12",
    "a".repeat(128),
    "CONSOLE",
    "COM10",
    "com",
    "LPT",
    "NULL",
    "CON-1",
    "toStrings",
    "x.toString",
  ])
    assertId(ok, "item id");
  bad("a".repeat(129));
  for (const dev of [
    "CON",
    "con",
    "Prn",
    "AUX",
    "nul",
    "NUL.txt",
    "con.json",
    "COM1",
    "com9.log",
    "LPT1",
    "lpt9",
    "aux.tar.gz",
  ])
    bad(dev);
  for (const p of [
    "toString",
    "valueOf",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "constructor",
    "__proto__",
    "__defineGetter__",
    "prototype",
  ])
    bad(p);
});
