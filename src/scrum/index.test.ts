import { test } from "node:test";
import assert from "node:assert/strict";
import { init } from "../methodology.ts";
import { addItem, getItem } from "../items.ts";
import { raisePending } from "../gates.ts";
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
  assert.equal(validateScrumConfig(config).autoClose, undefined);
  const good = validateScrumConfig({
    ...config,
    autoClose: false,
    estimateMode: "per-call",
    fallbackTokensPerWeight: 500,
  });
  assert.deepEqual(
    [good.autoClose, good.estimateMode, good.fallbackTokensPerWeight],
    [false, "per-call", 500],
  );
  for (const [bad, name] of [
    [{ autoClose: "yes" }, "autoClose"],
    [{ estimateMode: "per-token" }, "estimateMode"],
    [{ fallbackTokensPerWeight: 0 }, "fallbackTokensPerWeight"],
    [{ fallbackTokensPerWeight: "20000" }, "fallbackTokensPerWeight"],
  ] as const) {
    assert.throws(
      () => validateScrumConfig({ ...config, ...bad }),
      (e: unknown) =>
        e instanceof WorkflowError &&
        e.code === "config-invalid" &&
        e.message.includes(name) &&
        e.fix.length > 0,
    );
  }
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
  state = addItem(state, { id: "A", title: "a", weight: 1, priority: 2 }, "product-owner", T0);
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
  state = next(state, scrum(), { now: T0, fallbackTokensPerWeight: 10, max: 1 }).state;
  assert.equal(getItem(state, "A").stage, "in_progress");
  assert.equal(getItem(state, "B").stage, "sprint"); // only A is in flight
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

const acct = (item: string, tokens: number, role = "developer"): Accounting => ({
  item,
  role,
  model: "haiku",
  tokensIn: tokens / 2,
  tokensOut: tokens / 2,
  durationMs: 1,
  startedAt: T0,
  endedAt: T0,
});
const hand = (item: string, over: Partial<Handoff> = {}): Handoff => ({
  item,
  role: "developer",
  produced: [{ kind: "code", ref: "x.ts" }],
  notes: "",
  do_not: [],
  open_questions: [],
  ...over,
});
function twoItemSprint(budget = 1000) {
  const m = scrum();
  let { state } = init({
    methodology: m,
    config: { ...config, sprintBudget: { tokens: budget } },
    now: T0,
  });
  state = addItem(
    state,
    { id: "A", title: "a", weight: 1, priority: 2, acceptance: ["ok"] },
    "product-owner",
    T0,
  );
  state = addItem(
    state,
    { id: "B", title: "b", weight: 1, priority: 1, acceptance: ["ok"] },
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
  return { m, state };
}

test("closeSprint releases blocked and awaiting_human items so they can be dispatched again", () => {
  const { m, state: dispatched } = twoItemSprint();
  assert.equal(getItem(dispatched, "A").status, "in_progress");
  assert.equal(getItem(dispatched, "B").status, "in_progress");
  let s = complete(
    dispatched,
    m,
    hand("A", { verdict: "blocked", notes: "waiting" }),
    acct("A", 10),
    T0,
  ).state;
  s = raisePending(s, { kind: "gate", item: "B", gate: "sprint-review", question: "ok?" }, T0);
  assert.equal(getItem(s, "B").status, "awaiting_human");
  s = m.ceremonies["cancel"]!(s, { by: "product-owner", now: T0, reason: "x" }).state;
  for (const id of ["A", "B"]) {
    const it = getItem(s, id);
    assert.equal(it.stage, "backlog");
    assert.equal(it.status, "todo");
    assert.equal(it.iteration, undefined);
    assert.equal(it.role, undefined);
    assert.equal(it.blockers.filter((b) => !b.clearedAt).length, 0);
  }
  assert.deepEqual(s.pending, []);
  const cleared = s.events.filter((e) => e.type === "blocker.cleared");
  assert.deepEqual(
    cleared.map((e) => e.payload),
    [{ id: "A", blocker: "A-b1", reason: "sprint closed" }],
  );
  assert.deepEqual(
    s.events.filter((e) => e.type === "pending.dropped").map((e) => e.payload),
    [{ id: "p1", item: "B", reason: "sprint closed" }],
  );
  s = m.ceremonies["retro"]!(s, { by: "scrum-master", now: T0, lessons: [] }).state;
  s = m.ceremonies["refine"]!(s, {
    by: "developer",
    now: T0,
    items: [
      { id: "A", patch: { weight: 2 } },
      { id: "B", patch: { weight: 2 } },
    ],
  }).state;
  s = m.ceremonies["plan"]!(s, {
    by: "scrum-master",
    now: T0,
    goal: "g2",
    items: ["A", "B"],
  }).state;
  s = next(s, m, { now: T0, fallbackTokensPerWeight: 10 }).state;
  assert.equal(getItem(s, "A").status, "in_progress");
  assert.equal(getItem(s, "B").status, "in_progress");
});

test("closeSprint reports an unknown committed id as unknown-item", () => {
  const { state } = twoItemSprint();
  const broken = { ...state, items: { ...state.items } };
  delete (broken.items as Record<string, unknown>)["A"];
  assert.throws(
    () => closeSprint(broken, "review", T0),
    (e: unknown) => e instanceof WorkflowError && e.code === "unknown-item",
  );
});

test("budget exhaustion with work in flight marks the sprint closing and lets the rest finish", () => {
  const { m, state } = twoItemSprint(100);
  let s = complete(state, m, hand("A"), acct("A", 120), T0).state;
  const it = s.iterations[0]!;
  assert.equal(it.endedAt, undefined);
  assert.equal(it.closing, true);
  assert.ok(s.events.some((e) => e.type === "sprint.closing"));
  assert.deepEqual(m.candidates(s), []);
  assert.equal(getItem(s, "B").status, "in_progress");
  s = complete(s, m, hand("B"), acct("B", 30), T0).state;
  const closed = s.iterations[0]!;
  assert.equal(closed.outcome, "completed");
  assert.equal(closed.closing, undefined);
  assert.equal(closed.spent.tokens, 150);
  assert.equal(s.events.at(-1)!.type, "sprint.closed");
  assert.equal(s.accounting.length, 2);
});

test("autoClose false keeps an exhausted sprint in closing until review closes it", () => {
  const m = scrum();
  let { state } = init({
    methodology: m,
    config: { ...config, sprintBudget: { turns: 1 }, autoClose: false },
    now: T0,
  });
  state = addItem(
    state,
    { id: "A", title: "a", weight: 1, acceptance: ["ok"] },
    "product-owner",
    T0,
  );
  state = m.ceremonies["plan"]!(state, {
    by: "scrum-master",
    now: T0,
    goal: "g",
    items: ["A"],
  }).state;
  state = next(state, m, { now: T0 }).state;
  const s1 = complete(state, m, hand("A"), acct("A", 10), T0).state;
  const it = s1.iterations[0]!;
  assert.equal(it.closing, true);
  assert.equal(it.endedAt, undefined);
  assert.ok(s1.events.some((e) => e.type === "sprint.closing"));
  assert.equal(next(s1, m, { now: T0 }).reason, "budget-exhausted");
  const s2 = m.ceremonies["review"]!(s1, { by: "human", now: T0, accepted: true }).state;
  assert.notEqual(s2.iterations[0]!.endedAt, undefined);
  assert.equal(s2.events.at(-1)!.type, "sprint.closed");
});
