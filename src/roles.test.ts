import { test } from "node:test";
import assert from "node:assert/strict";
import { createState } from "./state.ts";
import {
  approversFor,
  hasCapability,
  registerRole,
  requireCapabilities,
  retireRole,
  rolesWith,
  separationLost,
} from "./roles.ts";
import { WorkflowError } from "./errors.ts";
import type { Role, Stage } from "./types.ts";

const T0 = "2026-10-19T00:00:00.000Z";
const stages: Stage[] = [{ id: "todo", name: "To do", entryPolicy: [], exitPolicy: [] }];
const role = (id: string, caps: Role["capabilities"], canApprove: string[] = []): Role => ({
  id,
  name: id,
  modelTier: "small",
  capabilities: caps,
  canApprove,
  inputs: [],
  outputs: [],
  do_not: [],
});
const po = role("po", ["order-backlog", "define-acceptance"]);
const dev = role("dev", ["deliver", "review"]);
const base = () => createState({ methodology: "scrum", config: {}, stages, roles: [po], now: T0 });

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

test("requireCapabilities names the missing capability and the exclusive clash", () => {
  const s = base();
  assert.throws(
    () => requireCapabilities(s, ["order-backlog", "deliver"], []),
    (e: unknown) =>
      e instanceof WorkflowError && e.code === "missing-capability" && /deliver/.test(e.message),
  );
  const s2 = registerRole(s, role("po2", ["order-backlog"]), "admin", T0);
  assert.throws(
    () => requireCapabilities(s2, ["order-backlog"], ["order-backlog"]),
    (e: unknown) =>
      e instanceof WorkflowError && e.code === "exclusive-capability" && /po, po2/.test(e.message),
  );
  assert.doesNotThrow(() => requireCapabilities(s, ["order-backlog"], ["order-backlog"]));
});

test("separationLost finds roles that hold every required capability", () => {
  const s = registerRole(
    base(),
    role("solo", ["order-backlog", "facilitate", "deliver"]),
    "admin",
    T0,
  );
  assert.deepEqual(
    separationLost(s, ["order-backlog", "facilitate", "deliver"]).map((r) => r.id),
    ["solo"],
  );
  assert.deepEqual(separationLost(s, ["order-backlog", "review"]), []);
});
