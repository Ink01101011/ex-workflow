import { test } from "node:test";
import assert from "node:assert/strict";
import { init } from "../methodology.ts";
import { addItem, getItem } from "../items.ts";
import { next } from "../brief.ts";
import { complete } from "../complete.ts";
import { WorkflowError } from "../errors.ts";
import { closeSprint, scrum, validateScrumConfig } from "./index.ts";
import type { Accounting, Handoff } from "../types.ts";

const T0 = "2026-10-19T00:00:00.000Z";
const config = {
  sprintBudget: { tokens: 1000 },
  productGoal: "ship v1",
  definitionOfDone: [{ kind: "evidence", evidenceKind: "test-output" }],
};

test("validateScrumConfig applies defaults and names bad fields", () => {
  const c = validateScrumConfig(config);
  assert.equal(c.refinementSharePct, 10);
  assert.equal(c.allowMidSprintAdd, "po-only");
  assert.throws(
    () => validateScrumConfig({ ...config, sprintBudget: {} }),
    (e: unknown) =>
      e instanceof WorkflowError && e.code === "config-invalid" && /sprintBudget/.test(e.message),
  );
  assert.throws(
    () => validateScrumConfig({ ...config, productGoal: "" }),
    (e: unknown) => e instanceof WorkflowError && /productGoal/.test(e.message),
  );
  assert.throws(
    () => validateScrumConfig({ ...config, allowMidSprintAdd: "yes" }),
    (e: unknown) => e instanceof WorkflowError && /allowMidSprintAdd/.test(e.message),
  );
});

test("init with scrum builds the five stages and three roles", () => {
  const { state, warnings } = init({ methodology: scrum(), config, now: T0 });
  assert.deepEqual(
    state.stages.map((s) => s.id),
    ["backlog", "sprint", "in_progress", "review", "done"],
  );
  assert.deepEqual(state.stages[3]!.exitPolicy, config.definitionOfDone);
  assert.deepEqual(Object.keys(state.roles), ["product-owner", "scrum-master", "developer"]);
  assert.deepEqual(warnings, []);
  assert.equal(scrum().vocabulary.backlog, "Product Backlog");
});

test("candidates are only items committed to the open sprint", () => {
  let { state } = init({ methodology: scrum(), config, now: T0 });
  state = addItem(state, { id: "A", title: "a", weight: 1 }, "product-owner", T0);
  state = addItem(state, { id: "B", title: "b", weight: 1 }, "product-owner", T0);
  assert.deepEqual(scrum().candidates(state), []);
  state = {
    ...state,
    iterations: [
      {
        id: "S1",
        goal: "g",
        budget: { tokens: 1000 },
        spent: { tokens: 0, turns: 0, wallclockMs: 0 },
        startedAt: T0,
        committed: ["A"],
        carryover: [],
      },
    ],
    items: { ...state.items, A: { ...state.items["A"]!, stage: "sprint", iteration: "S1" } },
  };
  assert.deepEqual(
    scrum()
      .candidates(state)
      .map((i) => i.id),
    ["A"],
  );
  const inv = scrum().invariants(state, state.items["A"]!);
  assert.equal(inv.length, 4);
  assert.match(inv[0]!, /g/);
});

test("afterComplete closes the sprint when the budget is exhausted and carries unfinished work over", () => {
  let { state } = init({
    methodology: scrum(),
    config: { ...config, sprintBudget: { tokens: 100 } },
    now: T0,
  });
  state = addItem(state, { id: "A", title: "a", weight: 1 }, "product-owner", T0);
  state = addItem(state, { id: "B", title: "b", weight: 1 }, "product-owner", T0);
  state = {
    ...state,
    iterations: [
      {
        id: "S1",
        goal: "g",
        budget: { tokens: 100 },
        spent: { tokens: 0, turns: 0, wallclockMs: 0 },
        startedAt: T0,
        committed: ["A", "B"],
        carryover: [],
      },
    ],
    items: {
      ...state.items,
      A: { ...state.items["A"]!, stage: "sprint", iteration: "S1" },
      B: { ...state.items["B"]!, stage: "sprint", iteration: "S1" },
    },
  };
  state = next(state, scrum(), { now: T0, fallbackTokensPerWeight: 10 }).state;
  assert.equal(getItem(state, "A").stage, "in_progress");
  const h: Handoff = {
    item: "A",
    role: "developer",
    produced: [{ kind: "code", ref: "a.ts" }],
    notes: "",
    do_not: [],
    open_questions: [],
  };
  const a: Accounting = {
    item: "A",
    role: "developer",
    model: "haiku",
    tokensIn: 80,
    tokensOut: 40,
    durationMs: 1,
    startedAt: T0,
    endedAt: T0,
  };
  state = complete(state, scrum(), h, a, T0).state;
  const s1 = state.iterations[0]!;
  assert.equal(s1.outcome, "completed");
  assert.ok(s1.endedAt);
  assert.deepEqual(new Set(s1.carryover), new Set(["A", "B"])); // A is in review, not done, so it carries over too
  assert.equal(s1.carryover.length, 2);
  assert.equal(getItem(state, "B").stage, "backlog");
  assert.equal(getItem(state, "B").iteration, undefined);
  assert.equal(state.events.at(-1)!.type, "sprint.closed");
});

test("closeSprint with cancel marks the outcome cancelled", () => {
  let { state } = init({ methodology: scrum(), config, now: T0 });
  state = {
    ...state,
    iterations: [
      {
        id: "S1",
        goal: "g",
        budget: { tokens: 1000 },
        spent: { tokens: 0, turns: 0, wallclockMs: 0 },
        startedAt: T0,
        committed: [],
        carryover: [],
      },
    ],
  };
  const s = closeSprint(state, "cancel", T0);
  assert.equal(s.iterations[0]!.outcome, "cancelled");
});

test("closeSprint never moves dropped items and reports them separately", () => {
  let { state } = init({ methodology: scrum(), config, now: T0 });
  state = addItem(state, { id: "A", title: "a", weight: 1 }, "product-owner", T0);
  state = addItem(state, { id: "B", title: "b", weight: 1 }, "product-owner", T0);
  state = {
    ...state,
    iterations: [
      {
        id: "S1",
        goal: "g",
        budget: { tokens: 1000 },
        spent: { tokens: 0, turns: 0, wallclockMs: 0 },
        startedAt: T0,
        committed: ["A", "B"],
        carryover: [],
      },
    ],
    items: {
      ...state.items,
      A: { ...state.items["A"]!, stage: "sprint", iteration: "S1" },
      B: { ...state.items["B"]!, stage: "sprint", iteration: "S1", status: "dropped" },
    },
  };
  const s = closeSprint(state, "review", T0);
  assert.deepEqual(s.iterations[0]!.carryover, ["A"]);
  assert.equal(getItem(s, "B").status, "dropped");
  assert.equal(getItem(s, "B").stage, "sprint");
  const ev = s.events.at(-1)!;
  assert.equal(ev.type, "sprint.closed");
  assert.deepEqual((ev.payload as { dropped: string[] }).dropped, ["B"]);
});
