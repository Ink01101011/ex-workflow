import type { Accounting, Budget, WorkflowState } from "./types.ts";

export const ZERO_SPENT: Required<Budget> = { tokens: 0, turns: 0, wallclockMs: 0 };

export function addSpent(spent: Required<Budget>, acc: Accounting): Required<Budget> {
  return {
    tokens: spent.tokens + acc.tokensIn + acc.tokensOut,
    turns: spent.turns + 1,
    wallclockMs: spent.wallclockMs + acc.durationMs,
  };
}

export function remaining(budget: Budget, spent: Required<Budget>): Budget {
  const out: Budget = {};
  if (budget.tokens !== undefined) out.tokens = Math.max(0, budget.tokens - spent.tokens);
  if (budget.turns !== undefined) out.turns = Math.max(0, budget.turns - spent.turns);
  if (budget.wallclockMs !== undefined)
    out.wallclockMs = Math.max(0, budget.wallclockMs - spent.wallclockMs);
  return out;
}

export function isExhausted(budget: Budget, spent: Required<Budget>): boolean {
  return (
    (budget.tokens !== undefined && spent.tokens >= budget.tokens) ||
    (budget.turns !== undefined && spent.turns >= budget.turns) ||
    (budget.wallclockMs !== undefined && spent.wallclockMs >= budget.wallclockMs)
  );
}

export function estimateTokens(
  state: WorkflowState,
  weight: number | undefined,
  fallbackPerWeight = 20000,
): number {
  const w = weight ?? 1;
  const samples: number[] = [];
  for (const a of state.accounting) {
    const iw = state.items[a.item]?.weight;
    if (iw === undefined || iw <= 0) continue;
    samples.push((a.tokensIn + a.tokensOut) / iw);
  }
  if (samples.length === 0) return fallbackPerWeight * w;
  samples.sort((x, y) => x - y);
  const mid = Math.floor(samples.length / 2);
  const median = samples.length % 2 ? samples[mid]! : (samples[mid - 1]! + samples[mid]!) / 2;
  return Math.round(median * w);
}
