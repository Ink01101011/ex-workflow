import { test } from "node:test";
import assert from "node:assert/strict";
import { createState } from "../state.ts";
import { WorkflowError } from "../errors.ts";
import { registerRole, retireRole } from "./registry.ts";
import { T0, base, dev, role, stages } from "./fixtures.ts";

test("registerRole adds the role and an event; duplicates fail", () => {
  const s = registerRole(base(), dev, "admin", T0);
  assert.ok(s.roles["dev"]);
  assert.equal(s.events.at(-1)!.type, "role.registered");
  assert.throws(
    () => registerRole(s, dev, "admin"),
    (e: unknown) => e instanceof WorkflowError && e.code === "duplicate-role",
  );
});

test("retireRole refuses while the role holds open items", () => {
  let s = registerRole(base(), dev, "admin", T0);
  s = {
    ...s,
    items: {
      A: {
        id: "A",
        type: "task",
        title: "a",
        dependsOn: [],
        stage: "todo",
        status: "in_progress",
        role: "dev",
        acceptance: [],
        evidence: [],
        blockers: [],
        transitions: [],
      },
    },
  };
  assert.throws(
    () => retireRole(s, "dev", "admin"),
    (e: unknown) =>
      e instanceof WorkflowError && e.code === "role-has-open-items" && e.items?.[0] === "A",
  );
  assert.throws(
    () => retireRole(s, "ghost", "admin"),
    (e: unknown) => e instanceof WorkflowError && e.code === "unknown-role",
  );
  const s2 = retireRole({ ...s, items: {} }, "dev", "admin", T0);
  assert.equal(s2.roles["dev"], undefined);
  assert.equal(s2.events.at(-1)!.type, "role.retired");
});

test("role ids are validated by registerRole and createState", () => {
  for (const id of ["__proto__", "../x", "a/b", "constructor"]) {
    assert.throws(
      () => registerRole(base(), role(id, ["deliver"]), "admin", T0),
      (e: unknown) => e instanceof WorkflowError && e.code === "invalid-input",
      id,
    );
    assert.throws(
      () =>
        createState({ methodology: "scrum", config: {}, stages, roles: [role(id, [])], now: T0 }),
      (e: unknown) => e instanceof WorkflowError && e.code === "invalid-input",
      id,
    );
  }
});
