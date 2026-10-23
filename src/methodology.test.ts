import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAction, changeConfig, init, validateAction } from "./methodology.ts";
import { addItem } from "./items.ts";
import { next } from "./brief.ts";
import { complete } from "./complete.ts";
import { scrum, type ScrumConfig } from "./scrum/index.ts";
import { WorkflowError } from "./errors.ts";
import type { Methodology, Role, Rule, Stage, WorkflowState } from "./types.ts";

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

const T2 = "2026-10-19T02:00:00.000Z";
const codeOf = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof WorkflowError ? e.code : String(e);
  }
  return "none";
};

function closedSprint() {
  const sm = scrum();
  const c = sm.ceremonies;
  let s = init({
    methodology: sm,
    config: {
      sprintBudget: { tokens: 1000 },
      productGoal: "ship v1",
      definitionOfDone: [{ kind: "evidence", evidenceKind: "test-output" }],
    },
    now: T0,
  }).state;
  for (const id of ["A", "B"])
    s = addItem(s, { id, title: id, weight: 1, acceptance: ["ok"] }, "product-owner", T0);
  s = c["plan"]!(s, { by: "scrum-master", now: T0, goal: "g", items: ["A"] }).state;
  s = next(s, sm, { now: T0, fallbackTokensPerWeight: 10 }).state;
  s = complete(
    s,
    sm,
    {
      item: "A",
      role: "developer",
      produced: [{ kind: "test-output", ref: "ci" }],
      notes: "",
      do_not: [],
      open_questions: [],
    },
    {
      item: "A",
      role: "developer",
      model: "haiku",
      tokensIn: 10,
      tokensOut: 10,
      durationMs: 10,
      startedAt: T0,
      endedAt: T0,
    },
    T0,
  ).state;
  s = c["review"]!(s, { by: "human", now: T0, accepted: true, goalMet: true }).state;
  s = c["retro"]!(s, { by: "scrum-master", now: T0, lessons: [] }).state;
  return { sm, c, s };
}

test("changeConfig between iterations re-validates, records config.changed and runs the hook; refused while open, for locked keys, and as a no-op", () => {
  const { sm: scrumM, c, s } = closedSprint();
  const res = changeConfig(
    s,
    scrumM as Methodology,
    { sprintBudget: { tokens: 1500000 } },
    "human",
    T2,
  );
  assert.deepEqual((res.state.config as ScrumConfig).sprintBudget, { tokens: 1500000 });
  const ev = res.state.events.at(-1)!;
  assert.equal(ev.type, "config.changed");
  assert.deepEqual(ev.payload, {
    changed: ["sprintBudget"],
    before: { sprintBudget: { tokens: 1000 } },
    after: { sprintBudget: { tokens: 1500000 } },
  });
  // the dogfood repro: the next plan with the new budget passes sprint-budget-fixed
  const planned = c["plan"]!(res.state, {
    by: "scrum-master",
    now: T2,
    goal: "g2",
    items: ["B"],
    budget: { tokens: 1500000 },
  });
  assert.equal(planned.state.iterations.at(-1)!.budget.tokens, 1500000);
  const mm = scrumM as Methodology;
  assert.equal(
    codeOf(() => changeConfig(planned.state, mm, { sprintBudget: { tokens: 5 } }, "human", T2)),
    "invalid-input",
  );
  assert.equal(
    codeOf(() => changeConfig(s, mm, { sprintBudget: {} }, "human", T2)),
    "config-invalid",
  );
  assert.throws(
    () => changeConfig(s, mm, { autoclose: false }, "human", T2),
    (e: unknown) =>
      e instanceof WorkflowError &&
      e.code === "invalid-input" &&
      /autoclose/.test(e.message) &&
      /known keys/.test(e.fix),
  );
  assert.equal(
    codeOf(() =>
      changeConfig(s, mm, { productGoal: (s.config as ScrumConfig).productGoal }, "human", T2),
    ),
    "no-op",
  );
  assert.equal(
    codeOf(() => changeConfig(s, mm, {}, "human", T2)),
    "invalid-input",
  );
});

test("scrum afterConfigChange keeps the review stage's exit policy equal to definitionOfDone", () => {
  const { sm: scrumM, s } = closedSprint();
  const res = changeConfig(
    s as WorkflowState,
    scrumM as Methodology,
    { definitionOfDone: [{ kind: "acceptance-written" }] },
    "human",
    T2,
  );
  assert.deepEqual(res.state.stages.find((st) => st.id === "review")!.exitPolicy, [
    { kind: "acceptance-written" },
  ]);
});
