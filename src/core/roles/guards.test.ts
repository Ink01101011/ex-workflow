import { test } from "node:test";
import assert from "node:assert/strict";
import { createState } from "../state.ts";
import { WorkflowError } from "../errors.ts";
import { canDo, requireCap, requireCapabilities, separationLost } from "./guards.ts";
import { registerRole } from "./registry.ts";
import { T0, base, role } from "./fixtures.ts";

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

test("canDo and requireCap: human may do anything, roles need one of the capabilities", () => {
  const s = createState({
    methodology: "kanban",
    config: {},
    stages: [{ id: "a", name: "a", entryPolicy: [], exitPolicy: [] }],
    roles: [
      {
        id: "mgr",
        name: "m",
        modelTier: "large",
        capabilities: ["manage-flow"],
        canApprove: [],
        inputs: [],
        outputs: [],
        do_not: [],
      },
    ],
    now: "2026-10-22T00:00:00.000Z",
  });
  assert.equal(canDo(s, "human", "deliver"), true);
  assert.equal(canDo(s, "mgr", "deliver", "manage-flow"), true);
  assert.equal(canDo(s, "mgr", "deliver"), false);
  assert.equal(canDo(s, "nobody", "deliver"), false);
  assert.doesNotThrow(() => requireCap(s, "mgr", "manage-flow"));
  assert.throws(
    () => requireCap(s, "mgr", "deliver"),
    (e: unknown) =>
      e instanceof WorkflowError &&
      e.code === "missing-capability" &&
      /run this as one of: human/.test(e.fix),
  );
});
