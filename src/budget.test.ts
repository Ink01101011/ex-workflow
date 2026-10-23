import { test } from "node:test";
import assert from "node:assert/strict";
import { ZERO_SPENT, addSpent, estimateTokens, isExhausted, remaining } from "./budget.ts";
import type { Accounting, WorkflowState } from "./types.ts";

const acc = (item: string, tokens: number, ms = 1000): Accounting => ({
  item,
  role: "dev",
  model: "small-1",
  tokensIn: tokens / 2,
  tokensOut: tokens / 2,
  durationMs: ms,
  startedAt: "x",
  endedAt: "y",
});

test("addSpent accumulates all three dimensions", () => {
  const s = addSpent(addSpent(ZERO_SPENT, acc("A", 1000)), acc("B", 500, 250));
  assert.deepEqual(s, { tokens: 1500, turns: 2, wallclockMs: 1250 });
});

test("remaining only reports defined dimensions and floors at zero", () => {
  assert.deepEqual(
    remaining({ tokens: 1000, turns: 1 }, { tokens: 1500, turns: 0, wallclockMs: 99 }),
    { tokens: 0, turns: 1 },
  );
});

test("isExhausted when any defined dimension is used up", () => {
  assert.equal(isExhausted({ tokens: 1000 }, { tokens: 999, turns: 50, wallclockMs: 0 }), false);
  assert.equal(
    isExhausted({ tokens: 1000, turns: 3 }, { tokens: 10, turns: 3, wallclockMs: 0 }),
    true,
  );
  assert.equal(isExhausted({}, { tokens: 1e9, turns: 1e9, wallclockMs: 1e9 }), false);
});

test("estimateTokens uses the median tokens-per-weight from history", () => {
  const state = {
    items: { A: { weight: 1 }, B: { weight: 2 }, C: { weight: 1 }, D: {} },
    accounting: [acc("A", 1000), acc("B", 4000), acc("C", 3000), acc("D", 99999)],
  } as unknown as WorkflowState;
  // per-weight: A=1000, B=2000, C=3000 → median 2000; D ignored (no weight)
  assert.equal(estimateTokens(state, 3), 6000);
  assert.equal(estimateTokens(state, undefined), 2000);
  assert.equal(estimateTokens({ items: {}, accounting: [] } as unknown as WorkflowState, 2), 40000);
  assert.equal(
    estimateTokens({ items: {}, accounting: [] } as unknown as WorkflowState, 2, 100),
    200,
  );
});

test("estimateTokens ignores placeholder lines and prices per call when asked", () => {
  const s = {
    items: { A: { weight: 1 }, B: { weight: 2 } },
    accounting: [acc("A", 200), acc("B", 600)],
  } as unknown as WorkflowState;
  const base = estimateTokens(s, 2);
  const withZero = {
    ...s,
    accounting: [...s.accounting, { ...acc("A", 0), estimate: true }],
  } as WorkflowState;
  assert.equal(estimateTokens(withZero, 2), base, "an estimate:true line does not move the median");
  // per-call: the median of tokens per completion, weight ignored
  assert.equal(estimateTokens(s, 5, 20000, "per-call"), 400);
  assert.equal(
    estimateTokens({ items: {}, accounting: [] } as unknown as WorkflowState, 5, 700, "per-call"),
    700,
    "no history: one call at the fallback",
  );
});
