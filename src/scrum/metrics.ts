import type { Budget, WorkflowState } from "../types.ts";

interface Closed {
  reason: string;
  done: string[];
  carryover: string[];
  doneWeight: number;
  committedWeight: number;
  spent: Required<Budget>;
  budget: Budget;
}

export interface ScrumMetrics {
  velocity: number[];
  meanVelocity: number;
  burndown: number[];
  commitmentReliability: number;
  sprintGoalHitRate: number;
  carryoverRatio: number;
  budgetUtilisation: number;
  costPerPoint: number;
}

const ratio = (num: number, den: number) => (den === 0 ? 0 : num / den);

export function scrumMetrics(state: WorkflowState): ScrumMetrics {
  const closed = state.events
    .filter((e) => e.type === "sprint.closed")
    .map((e) => e.payload as Closed);
  const counted = closed.filter((c) => c.reason !== "cancel");
  const velocity = counted.map((c) => c.doneWeight);
  const doneWeight = counted.reduce((s, c) => s + c.doneWeight, 0);
  const committedWeight = counted.reduce((s, c) => s + c.committedWeight, 0);
  const increments = state.events
    .filter((e) => e.type === "increment")
    .map((e) => e.payload as { goalMet: boolean });
  const withTokens = closed.filter((c) => c.budget.tokens !== undefined);
  const tokensSpent = counted.reduce((s, c) => s + c.spent.tokens, 0);
  return {
    velocity,
    meanVelocity: ratio(
      velocity.reduce((s, x) => s + x, 0),
      velocity.length,
    ),
    burndown: state.events
      .filter((e) => e.type === "daily")
      .map((e) => (e.payload as { remainingWeight: number }).remainingWeight),
    commitmentReliability: ratio(doneWeight, committedWeight),
    sprintGoalHitRate: ratio(increments.filter((i) => i.goalMet).length, increments.length),
    carryoverRatio: ratio(
      closed.reduce((s, c) => s + c.carryover.length, 0),
      closed.reduce((s, c) => s + c.done.length + c.carryover.length, 0),
    ),
    budgetUtilisation: ratio(
      withTokens.reduce((s, c) => s + c.spent.tokens, 0),
      withTokens.reduce((s, c) => s + (c.budget.tokens ?? 0), 0),
    ),
    costPerPoint: ratio(tokensSpent, doneWeight), // cost per delivered point over completed sprints
  };
}
