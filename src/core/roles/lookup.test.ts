import { test } from "node:test";
import assert from "node:assert/strict";
import { approversFor, hasCapability, rolesWith } from "./lookup.ts";
import { registerRole } from "./registry.ts";
import { T0, base, po, role } from "./fixtures.ts";

test("capability queries", () => {
  const s = registerRole(base(), role("pm", ["approve-gate"], ["sprint-review"]), "admin", T0);
  assert.equal(hasCapability(po, "order-backlog"), true);
  assert.equal(hasCapability(po, "deliver"), false);
  assert.deepEqual(
    rolesWith(s, "order-backlog").map((r) => r.id),
    ["po"],
  );
  assert.deepEqual(
    approversFor(s, "sprint-review").map((r) => r.id),
    ["pm"],
  );
  assert.deepEqual(approversFor(s, "other"), []);
});
