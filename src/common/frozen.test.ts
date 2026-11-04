import { test } from "node:test";
import assert from "node:assert/strict";
import { frozenChanges } from "./frozen.ts";

const SHA = "a".repeat(40);

test("frozenChanges returns no keys when every frozen field is supplied unchanged", () => {
  assert.deepEqual(
    frozenChanges({ baseSha: SHA, harness: "bench" }, { baseSha: SHA, harness: "bench" }),
    [],
  );
});

test("frozenChanges returns the keys whose supplied value differs, in frozen key order", () => {
  assert.deepEqual(
    frozenChanges(
      { baseSha: SHA, harness: "bench", workspace: "w1" },
      {
        workspace: "w2",
        harness: "other",
        baseSha: SHA,
      },
    ),
    ["harness", "workspace"],
  );
});

test("frozenChanges ignores supplied keys the frozen record does not hold", () => {
  assert.deepEqual(frozenChanges({ harness: "bench" }, { harness: "bench", score: 3 }), []);
});

test("frozenChanges treats a missing supplied record or field as a change", () => {
  assert.deepEqual(frozenChanges({ harness: "bench" }, {}), ["harness"]);
  assert.deepEqual(frozenChanges({ harness: "bench" }, undefined), ["harness"]);
});

test("frozenChanges compares only the listed keys when keys are given", () => {
  const frozen = { id: "h1", claim: "c", falsifiedBy: "f", note: "x" };
  assert.deepEqual(
    frozenChanges(frozen, { id: "h1", claim: "c", falsifiedBy: "f" }, [
      "id",
      "claim",
      "falsifiedBy",
    ]),
    [],
  );
  assert.deepEqual(frozenChanges(frozen, { id: "h1", claim: "c2" }, ["claim"]), ["claim"]);
});

test("frozenChanges compares by identity, so a frozen field holds an id, SHA or ref", () => {
  assert.deepEqual(frozenChanges({ n: 1 }, { n: "1" }), ["n"]);
  const list = ["a"];
  assert.deepEqual(frozenChanges({ list }, { list }), []);
  assert.deepEqual(frozenChanges({ list }, { list: ["a"] }), ["list"]);
});

test("frozenChanges reads only own fields of the supplied record (U11 N5)", () => {
  // an inherited member is a missing field, even when it equals the frozen value
  const inherited = Object.create({ harness: "bench" }) as object;
  assert.deepEqual(frozenChanges({ harness: "bench" }, inherited), ["harness"]);
  assert.deepEqual(frozenChanges({ toString: Object.prototype.toString }, {}), ["toString"]);
  assert.deepEqual(frozenChanges({ harness: "bench" }, Object.create(null) as object), ["harness"]);
});

test("frozenChanges: a missing field reads as undefined, a change unless the frozen value is undefined too", () => {
  assert.deepEqual(frozenChanges({ note: undefined }, {}), []);
  assert.deepEqual(frozenChanges({ note: undefined }, undefined), []);
  assert.deepEqual(frozenChanges({ note: undefined }, { note: undefined }), []);
  assert.deepEqual(frozenChanges({ note: undefined }, { note: "x" }), ["note"]);
  assert.deepEqual(frozenChanges({ note: "x" }, { note: undefined }), ["note"]);
});
