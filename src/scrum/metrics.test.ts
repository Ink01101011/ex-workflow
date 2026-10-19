import { test } from "node:test";
import assert from "node:assert/strict";
import { init } from "../methodology.ts";
import { addItem } from "../items.ts";
import { next } from "../brief.ts";
import { complete } from "../complete.ts";
import { scrum } from "./index.ts";
import { scrumMetrics } from "./metrics.ts";
import type { WorkflowState } from "../types.ts";

const T0 = "2026-10-19T00:00:00.000Z";
const config = {
  sprintBudget: { tokens: 1000 },
  productGoal: "ship",
  definitionOfDone: [{ kind: "evidence", evidenceKind: "test-output" }],
};
const m = scrum();

function oneSprint(): WorkflowState {
  let { state } = init({ methodology: m, config, now: T0 });
  state = addItem(
    state,
    { id: "A", title: "a", weight: 2, acceptance: ["ok"] },
    "product-owner",
    T0,
  );
  state = addItem(
    state,
    { id: "B", title: "b", weight: 3, acceptance: ["ok"] },
    "product-owner",
    T0,
  );
  state = m.ceremonies["plan"]!(state, {
    by: "scrum-master",
    now: T0,
    goal: "g",
    items: ["A", "B"],
  }).state;
  state = next(state, m, { now: T0, fallbackTokensPerWeight: 10 }).state;
  state = complete(
    state,
    m,
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
      tokensIn: 100,
      tokensOut: 100,
      durationMs: 1,
      startedAt: T0,
      endedAt: T0,
    },
    T0,
  ).state;
  state = next(state, m, { now: T0, fallbackTokensPerWeight: 10 }).state; // review of A
  state = complete(
    state,
    m,
    { item: "A", role: "developer", produced: [], notes: "lgtm", do_not: [], open_questions: [] },
    {
      item: "A",
      role: "developer",
      model: "haiku",
      tokensIn: 50,
      tokensOut: 50,
      durationMs: 1,
      startedAt: T0,
      endedAt: T0,
    },
    T0,
  ).state;
  state = m.ceremonies["daily"]!(state, { by: "scrum-master", now: T0 }).state;
  state = m.ceremonies["review"]!(state, {
    by: "human",
    now: T0,
    accepted: true,
    goalMet: true,
  }).state;
  return state;
}

test("metrics after one sprint", () => {
  const s = oneSprint();
  const mm = scrumMetrics(s);
  assert.deepEqual(mm.velocity, [2]);
  assert.equal(mm.meanVelocity, 2);
  assert.deepEqual(mm.burndown, [3]); // daily ran after A was done, B (3) remaining
  assert.equal(mm.commitmentReliability, 0.4); // 2 of 5
  assert.equal(mm.sprintGoalHitRate, 1);
  assert.equal(mm.carryoverRatio, 0.5); // 1 done, 1 carried
  assert.equal(mm.budgetUtilisation, 0.3); // 300 of 1000
  assert.equal(mm.costPerPoint, 150); // 300 tokens / 2 points

  // a cancelled sprint's spent tokens must not change cost per point
  const last = s.events[s.events.length - 1]!;
  const cancelled = {
    ...s,
    events: [
      ...s.events,
      {
        ...last,
        type: "sprint.closed",
        payload: {
          reason: "cancel",
          done: [],
          carryover: [],
          doneWeight: 0,
          committedWeight: 0,
          spent: { tokens: 999 },
          budget: {},
        },
      },
    ],
  } as WorkflowState;
  assert.equal(scrumMetrics(cancelled).costPerPoint, 150);
});

test("metrics are a pure function of events", () => {
  const s = oneSprint();
  const eventsOnly = {
    ...s,
    items: {},
    iterations: [],
    accounting: [],
    roles: {},
    stages: [],
  } as WorkflowState;
  assert.deepEqual(scrumMetrics(eventsOnly), scrumMetrics(s));
  assert.deepEqual(m.metrics(s), scrumMetrics(s));
});

test("metrics on an empty state are zeros", () => {
  const { state } = init({ methodology: m, config, now: T0 });
  assert.deepEqual(scrumMetrics(state), {
    velocity: [],
    meanVelocity: 0,
    burndown: [],
    commitmentReliability: 0,
    sprintGoalHitRate: 0,
    carryoverRatio: 0,
    budgetUtilisation: 0,
    costPerPoint: 0,
  });
});
