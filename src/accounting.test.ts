import { test } from "node:test";
import assert from "node:assert/strict";
import { init } from "./methodology.ts";
import { addItem } from "./items.ts";
import { next } from "./brief.ts";
import { complete } from "./complete.ts";
import { correctAccounting } from "./accounting.ts";
import { openIteration } from "./planner.ts";
import { WorkflowError } from "./errors.ts";
import { scrum } from "./scrum/index.ts";
import type { Accounting, WorkflowState } from "./types.ts";

const T0 = "2026-10-19T00:00:00.000Z";
const T1 = "2026-10-19T01:00:00.000Z";
const T2 = "2026-10-19T02:00:00.000Z";
const m = scrum();
const config = {
  sprintBudget: { tokens: 100000 },
  productGoal: "ship",
  definitionOfDone: [{ kind: "evidence", evidenceKind: "test-output" }],
};
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof WorkflowError ? e.code : String(e);
  }
  return "no error";
};

/** Sprint S1 open with A (and B) committed and A dispatched; B has no accounting line. */
function dispatched(): WorkflowState {
  let { state } = init({ methodology: m, config, now: T0 });
  for (const id of ["A", "B"])
    state = addItem(state, { id, title: id, weight: 1, acceptance: ["ok"] }, "product-owner", T0);
  state = m.ceremonies["plan"]!(state, {
    by: "scrum-master",
    now: T0,
    goal: "g",
    items: ["A", "B"],
  }).state;
  return next(state, m, { now: T0, fallbackTokensPerWeight: 10 }).state;
}

const acc = (over: Partial<Accounting> = {}): Accounting => ({
  item: "A",
  role: "developer",
  model: "haiku",
  tokensIn: 0,
  tokensOut: 0,
  durationMs: 0,
  startedAt: T1,
  endedAt: T1,
  ...over,
});
const done = (state: WorkflowState, a: Accounting): WorkflowState =>
  complete(
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
    a,
    T1,
  ).state;

const s0 = done(dispatched(), acc({ estimate: true }));
const sNonZero = done(dispatched(), acc({ tokensIn: 100, tokensOut: 50, durationMs: 10 }));
// the sprint's budget is closed by the review ceremony; A sits in review, which is fine for accounting
const close = (state: WorkflowState): WorkflowState =>
  m.ceremonies["review"]!(state, {
    by: "human",
    now: T2,
    accepted: true,
    goalMet: true,
  }).state;

test("correctAccounting rewrites the last line, clears estimate, adjusts the open sprint's spent and records the delta", () => {
  assert.equal(openIteration(s0)!.spent.tokens, 0);
  const s1 = correctAccounting(
    s0,
    "A",
    { tokensIn: 40000, tokensOut: 2000, durationMs: 9000 },
    "human",
    T2,
  );
  const line = s1.accounting.at(-1)!;
  assert.equal(line.tokensIn, 40000);
  assert.equal(line.estimate, undefined);
  assert.equal(openIteration(s1)!.spent.tokens, 42000);
  assert.equal(openIteration(s1)!.spent.wallclockMs, 9000);
  const ev = s1.events.at(-1)!;
  assert.equal(ev.type, "accounting.corrected");
  assert.deepEqual(ev.payload, {
    item: "A",
    line: 1,
    iteration: "S1",
    before: { tokensIn: 0, tokensOut: 0, durationMs: 0, model: "haiku" },
    after: {
      tokensIn: 40000,
      tokensOut: 2000,
      durationMs: 9000,
      model: "haiku",
    },
    delta: { tokens: 42000, durationMs: 9000 },
  });
});

test("correctAccounting refuses an unknown line, a zero result and a no-op", () => {
  assert.equal(
    code(() => correctAccounting(s0, "A", { tokensIn: 1 }, "human", T2, 3)),
    "invalid-input",
  );
  assert.equal(
    code(() => correctAccounting(s0, "B", { tokensIn: 1 }, "human", T2)),
    "invalid-input",
  );
  assert.equal(
    code(() => correctAccounting(sNonZero, "A", { tokensIn: 0, tokensOut: 0 }, "human", T2)),
    "accounting-invalid",
  );
  assert.equal(
    code(() =>
      correctAccounting(sNonZero, "A", { tokensIn: sNonZero.accounting[0]!.tokensIn }, "human", T2),
    ),
    "no-op",
  );
  assert.equal(
    code(() => correctAccounting(s0, "A", { tokensIn: -5 }, "human", T2)),
    "accounting-invalid",
  );
  assert.equal(
    code(() => correctAccounting(s0, "A", { model: " " }, "human", T2)),
    "accounting-invalid",
  );
});

test("every correctAccounting refusal carries a fix", () => {
  for (const f of [
    () => correctAccounting(s0, "A", { tokensIn: 1 }, "human", T2, 3),
    () => correctAccounting(s0, "B", { tokensIn: 1 }, "human", T2),
    () => correctAccounting(sNonZero, "A", {}, "human", T2),
  ])
    try {
      f();
      assert.fail("expected a WorkflowError");
    } catch (e) {
      assert.ok(e instanceof WorkflowError && e.fix.trim() !== "");
    }
});

test("settling a placeholder with the same figures is not a no-op; a model-only change is a correction", () => {
  const settled = correctAccounting(sNonZero, "A", { model: "sonnet" }, "human", T2);
  assert.equal(settled.accounting[0]!.model, "sonnet");
  assert.equal(openIteration(settled)!.spent.tokens, openIteration(sNonZero)!.spent.tokens);
  const est = done(dispatched(), acc({ tokensIn: 5, estimate: true }));
  const cleared = correctAccounting(est, "A", { tokensIn: 5 }, "human", T2);
  assert.equal(cleared.accounting[0]!.estimate, undefined);
});

test("a correction after the sprint closed adjusts the closed iteration and is attributed to it", () => {
  const closed = close(s0);
  assert.equal(openIteration(closed), undefined);
  const s1 = correctAccounting(closed, "A", { tokensIn: 700, tokensOut: 300 }, "human", T2);
  const it = s1.iterations.find((x) => x.id === "S1")!;
  assert.equal(it.spent.tokens, 1000);
  assert.equal((s1.events.at(-1)!.payload as { iteration: string }).iteration, "S1");
});
