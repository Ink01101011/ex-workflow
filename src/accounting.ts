import { fail } from "./errors.ts";
import { getItem } from "./items.ts";
import { appendEvent, nowOf } from "./state.ts";
import type { Accounting, Iteration, WorkflowState } from "./types.ts";

export interface AccountingPatch {
  tokensIn?: number;
  tokensOut?: number;
  durationMs?: number;
  model?: string;
}

const NUMERIC = [
  ["tokensIn", "tokens-in"],
  ["tokensOut", "tokens-out"],
  ["durationMs", "duration-ms"],
] as const;

const pick = (a: Accounting) => ({
  tokensIn: a.tokensIn,
  tokensOut: a.tokensOut,
  durationMs: a.durationMs,
  model: a.model,
});

/**
 * Rewrite one accounting line of an item (`line` is 1-based among the item's lines, default the last).
 * The owning iteration's spent follows the delta, open or closed; the event records before/after.
 */
export function correctAccounting(
  state: WorkflowState,
  itemId: string,
  patch: AccountingPatch,
  by: string,
  now?: string,
  line?: number,
): WorkflowState {
  getItem(state, itemId);
  const indexes: number[] = [];
  state.accounting.forEach((a, i) => {
    if (a.item === itemId) indexes.push(i);
  });
  if (indexes.length === 0)
    fail(
      "invalid-input",
      `item "${itemId}" has no accounting line to correct`,
      `complete "${itemId}" first (exwf complete), then exwf account`,
      { items: [itemId] },
    );
  const n = line ?? indexes.length;
  if (!Number.isInteger(n) || n < 1 || n > indexes.length)
    fail(
      "invalid-input",
      `item "${itemId}" has ${indexes.length} accounting line(s), not line ${String(line)}`,
      `pass --line 1..${indexes.length}`,
      { items: [itemId] },
    );
  const idx = indexes[n - 1]!;
  const before = state.accounting[idx]!;
  for (const [k, flag] of NUMERIC) {
    const v = patch[k];
    if (v !== undefined && (!Number.isFinite(v) || v < 0))
      fail(
        "accounting-invalid",
        `${k} must be a non-negative number`,
        `pass --${flag} <n> with a measured figure`,
        { items: [itemId] },
      );
  }
  if (patch.model !== undefined && patch.model.trim() === "")
    fail(
      "accounting-invalid",
      "model must not be empty",
      "pass --model with the model id that ran the work",
      { items: [itemId] },
    );
  const { estimate: _drop, ...rest } = before;
  const after: Accounting = {
    ...rest,
    tokensIn: patch.tokensIn ?? before.tokensIn,
    tokensOut: patch.tokensOut ?? before.tokensOut,
    durationMs: patch.durationMs ?? before.durationMs,
    model: patch.model ?? before.model,
  };
  if (after.tokensIn + after.tokensOut === 0)
    fail(
      "accounting-invalid",
      `the correction leaves "${itemId}" at 0 tokens`,
      "pass the host's usage figures with --tokens-in / --tokens-out",
      { items: [itemId] },
    );
  const b = pick(before);
  const a = pick(after);
  const unchanged =
    b.tokensIn === a.tokensIn &&
    b.tokensOut === a.tokensOut &&
    b.durationMs === a.durationMs &&
    b.model === a.model;
  // replacing a placeholder with the same figures still settles it, so it is not a no-op
  if (unchanged && before.estimate !== true)
    fail(
      "no-op",
      `accounting for "${itemId}" line ${n} already has these figures`,
      "pass at least one different value to exwf account",
      { items: [itemId] },
    );
  const delta = {
    tokens: a.tokensIn + a.tokensOut - (b.tokensIn + b.tokensOut),
    durationMs: a.durationMs - b.durationMs,
  };
  const item = state.items[itemId]!;
  let owner: Iteration | undefined;
  for (const it of state.iterations) {
    // the last iteration that was open when the line was recorded and carried the item
    if (
      (it.committed.includes(itemId) || item.iteration === it.id) &&
      it.startedAt <= before.endedAt &&
      (it.endedAt === undefined || before.endedAt <= it.endedAt)
    )
      owner = it;
  }
  let s: WorkflowState = {
    ...state,
    accounting: state.accounting.map((x, i) => (i === idx ? after : x)),
  };
  if (owner)
    s = {
      ...s,
      iterations: s.iterations.map((it) =>
        it.id === owner.id
          ? {
              ...it,
              spent: {
                ...it.spent,
                tokens: Math.max(0, it.spent.tokens + delta.tokens),
                wallclockMs: Math.max(0, it.spent.wallclockMs + delta.durationMs),
              },
            }
          : it,
      ),
    };
  return appendEvent(
    s,
    "accounting.corrected",
    by,
    {
      item: itemId,
      line: n,
      iteration: owner?.id ?? null,
      before: b,
      after: a,
      delta,
    },
    nowOf(now),
  );
}
