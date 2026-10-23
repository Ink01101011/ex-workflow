import { openIteration } from "../planner.ts";
import type { Budget, WorkflowState } from "../types.ts";

interface Closed {
  id?: string;
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
  /** The open sprint right now; all zeros when none is open. */
  current: Record<string, number>;
}

const ratio = (num: number, den: number) => (den === 0 ? 0 : num / den);

export function scrumMetrics(state: WorkflowState): ScrumMetrics {
  const corrections = state.events.filter((e) => e.type === "accounting.corrected");
  const closed = state.events
    .filter((e) => e.type === "sprint.closed")
    .map((e) => {
      const c = e.payload as Closed;
      // corrections recorded after the close still belong to that sprint's spend
      const late = corrections
        .filter(
          (x) =>
            x.seq > e.seq &&
            c.id !== undefined &&
            (x.payload as { iteration: string | null }).iteration === c.id,
        )
        .reduce((sum, x) => sum + (x.payload as { delta: { tokens: number } }).delta.tokens, 0);
      return late === 0 ? c : { ...c, spent: { ...c.spent, tokens: c.spent.tokens + late } };
    });
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
    current: currentSprint(state),
  };
}

function currentSprint(state: WorkflowState): Record<string, number> {
  const it = openIteration(state);
  const items = (it?.committed ?? []).map((id) => state.items[id]).filter((i) => i !== undefined);
  const weight = (list: typeof items) => list.reduce((sum, i) => sum + (i.weight ?? 0), 0);
  const committedWeight = weight(items);
  const doneWeight = weight(items.filter((i) => i.status === "done"));
  const spentTokens = it?.spent.tokens ?? 0;
  const budgetTokens = it?.budget.tokens ?? 0;
  return {
    spentTokens,
    spentTurns: it?.spent.turns ?? 0,
    budgetTokens,
    committedWeight,
    doneWeight,
    remainingWeight: committedWeight - doneWeight,
    costPerPoint: ratio(spentTokens, doneWeight),
    budgetUtilisation: ratio(spentTokens, budgetTokens),
  };
}
