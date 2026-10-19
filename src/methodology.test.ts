import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAction, init, validateAction } from "./methodology.ts";
import { WorkflowError } from "./errors.ts";
import type { Methodology, Role, Rule, Stage } from "./types.ts";

const T0 = "2026-10-19T00:00:00.000Z";
const stages: Stage[] = [
  { id: "todo", name: "To do", entryPolicy: [], exitPolicy: [] },
  { id: "done", name: "Done", entryPolicy: [], exitPolicy: [] },
];
const r = (id: string, caps: Role["capabilities"]): Role => ({
  id,
  name: id,
  modelTier: "small",
  capabilities: caps,
  canApprove: [],
  inputs: [],
  outputs: [],
  do_not: [],
});
const noAdd: Rule = {
  id: "no-add",
  severity: "error",
  check: (_s, a) =>
    a.type === "add"
      ? [{ rule: "no-add", severity: "error", message: "adding is forbidden", fix: "do not add" }]
      : [],
};
const warnAll: Rule = {
  id: "warn-all",
  severity: "warning",
  check: () => [{ rule: "warn-all", severity: "warning", message: "fyi", fix: "none" }],
};
const m = (rules: Rule[] = []): Methodology<{ x: number }> => ({
  name: "kanban",
  vocabulary: {} as Methodology["vocabulary"],
  validateConfig: (c) => {
    if (typeof (c as { x?: unknown }).x !== "number")
      throw new WorkflowError("config-invalid", "x must be a number", "pass { x: 1 }");
    return c as { x: number };
  },
  defaultStages: () => stages,
  defaultRoles: () => [r("dev", ["deliver"]), r("po", ["order-backlog"])],
  requiredCapabilities: ["deliver", "order-backlog"],
  exclusiveCapabilities: ["order-backlog"],
  plannerOptions: () => ({ schedulerMode: "level" }),
  candidates: () => [],
  invariants: () => [],
  ceremonies: {},
  rules,
  metrics: () => ({}),
  humanDefaults: { gates: "none" },
});

test("init validates config, builds defaults and checks capabilities", () => {
  const { state, warnings } = init({ methodology: m(), config: { x: 1 }, now: T0 });
  assert.equal(state.methodology, "kanban");
  assert.deepEqual(Object.keys(state.roles), ["dev", "po"]);
  assert.deepEqual(warnings, []);
  assert.throws(
    () => init({ methodology: m(), config: {} }),
    (e: unknown) => e instanceof WorkflowError && e.code === "config-invalid",
  );
  assert.throws(
    () => init({ methodology: m(), config: { x: 1 }, roles: [r("dev", ["deliver"])] }),
    (e: unknown) => e instanceof WorkflowError && e.code === "missing-capability",
  );
});

test("init warns on separation-lost", () => {
  const { warnings } = init({
    methodology: m(),
    config: { x: 1 },
    roles: [r("solo", ["deliver", "order-backlog"])],
    now: T0,
  });
  assert.equal(warnings[0]?.rule, "separation-lost");
});

test("applyAction aborts on error rules and surfaces warnings", () => {
  const { state } = init({ methodology: m([noAdd, warnAll]), config: { x: 1 }, now: T0 });
  assert.throws(
    () => applyAction(state, m([noAdd]), { type: "add", by: "po" }, (s) => s),
    (e: unknown) =>
      e instanceof WorkflowError && e.code === "rule-violation" && e.rule === "no-add",
  );
  const res = applyAction(state, m([noAdd, warnAll]), { type: "edit", by: "po" }, (s) => ({
    ...s,
    config: { x: 2 },
  }));
  assert.deepEqual(res.state.config, { x: 2 });
  assert.equal(res.warnings[0]?.rule, "warn-all");
  assert.deepEqual(
    validateAction(state, m([noAdd]), { type: "add", by: "po" }).map((v) => v.rule),
    ["no-add"],
  );
});
