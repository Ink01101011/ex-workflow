import { test } from "node:test";
import assert from "node:assert/strict";
import { init } from "../methodology.ts";
import { addItem, editItem } from "../items.ts";
import { WorkflowError } from "../errors.ts";
import { scrum } from "./index.ts";
import { scrumRules } from "./rules.ts";
import type { Action, WorkflowState } from "../types.ts";

const T0 = "2026-10-19T00:00:00.000Z";
const T1 = "2026-10-19T01:00:00.000Z";
const config = { sprintBudget: { tokens: 1000 }, productGoal: "ship", definitionOfDone: [] };
const m = scrum();
const run = (s: WorkflowState, a: Action) =>
  scrumRules()
    .flatMap((r) => r.check(s, a))
    .map((v) => `${v.severity}:${v.rule}`);
const code = (e: unknown) => (e instanceof WorkflowError ? e.code : String(e));

function withBacklog(): WorkflowState {
  let { state } = init({ methodology: m, config, now: T0 });
  state = addItem(
    state,
    { id: "A", title: "a", weight: 1, acceptance: ["ok"] },
    "product-owner",
    T0,
  );
  state = addItem(
    state,
    { id: "B", title: "b", weight: 1, acceptance: ["ok"] },
    "product-owner",
    T0,
  );
  return state;
}

test("one-open-sprint and sprint-budget-fixed", () => {
  const s = m.ceremonies["plan"]!(withBacklog(), {
    by: "scrum-master",
    now: T0,
    goal: "g",
    items: ["A"],
  }).state;
  assert.deepEqual(
    run(s, { type: "ceremony.plan", by: "scrum-master", payload: { goal: "g2", items: ["B"] } }),
    ["error:one-open-sprint"],
  );
  assert.throws(
    () => m.ceremonies["plan"]!(s, { by: "scrum-master", now: T1, goal: "g2", items: ["B"] }),
    (e) => code(e) === "rule-violation",
  );
  const closed = m.ceremonies["review"]!(s, {
    by: "human",
    now: T1,
    accepted: true,
    goalMet: true,
  }).state;
  const retro = m.ceremonies["retro"]!(closed, { by: "scrum-master", now: T1, lessons: [] }).state;
  assert.deepEqual(
    run(retro, {
      type: "ceremony.plan",
      by: "scrum-master",
      payload: { goal: "g2", items: ["B"], budget: { tokens: 5000 } },
    }),
    ["error:sprint-budget-fixed"],
  );
  const budgetViolation = scrumRules()
    .flatMap((r) =>
      r.check(retro, {
        type: "ceremony.plan",
        by: "scrum-master",
        payload: { goal: "g2", items: ["B"], budget: { tokens: 5000 } },
      }),
    )
    .find((v) => v.rule === "sprint-budget-fixed")!;
  assert.match(budgetViolation.fix, /exwf config set/);
  assert.deepEqual(
    run(retro, {
      type: "ceremony.plan",
      by: "scrum-master",
      payload: { goal: "g2", items: ["B"], budget: { tokens: 1000 } },
    }),
    [],
  );
});

test("retro-before-plan is an error after a completed sprint and a warning after a cancelled one", () => {
  const s = m.ceremonies["plan"]!(withBacklog(), {
    by: "scrum-master",
    now: T0,
    goal: "g",
    items: ["A"],
  }).state;
  const completed = m.ceremonies["review"]!(s, {
    by: "human",
    now: T1,
    accepted: true,
    goalMet: false,
  }).state;
  assert.deepEqual(
    run(completed, {
      type: "ceremony.plan",
      by: "scrum-master",
      payload: { goal: "g2", items: ["B"] },
    }),
    ["error:retro-before-plan"],
  );
  const cancelled = m.ceremonies["cancel"]!(s, { by: "product-owner", now: T1, reason: "x" }).state;
  assert.deepEqual(
    run(cancelled, {
      type: "ceremony.plan",
      by: "scrum-master",
      payload: { goal: "g2", items: ["B"] },
    }),
    ["warning:retro-before-plan"],
  );
  const res = m.ceremonies["plan"]!(cancelled, {
    by: "scrum-master",
    now: T1,
    goal: "g2",
    items: ["B"],
  });
  assert.equal(res.warnings[0]?.rule, "retro-before-plan");
});

test("scope-protects-goal", () => {
  const s = m.ceremonies["plan"]!(withBacklog(), {
    by: "scrum-master",
    now: T0,
    goal: "g",
    items: ["A"],
  }).state;
  assert.deepEqual(
    run(s, {
      type: "ceremony.commit",
      by: "developer",
      payload: { items: ["B"], goalImpact: "none" },
    }),
    ["error:scope-protects-goal"],
  );
  assert.deepEqual(
    run(s, {
      type: "ceremony.commit",
      by: "product-owner",
      payload: { items: ["B"], goalImpact: "at-risk" },
    }),
    ["error:scope-protects-goal"],
  );
  assert.deepEqual(
    run(s, {
      type: "ceremony.commit",
      by: "product-owner",
      payload: { items: ["B"], goalImpact: "none" },
    }),
    [],
  );
  assert.deepEqual(
    run(s, { type: "ceremony.commit", by: "human", payload: { items: ["B"], goalImpact: "none" } }),
    [],
  );
  const never = { ...s, config: { ...(s.config as object), allowMidSprintAdd: "never" } };
  assert.deepEqual(
    run(never, {
      type: "ceremony.commit",
      by: "product-owner",
      payload: { items: ["B"], goalImpact: "none" },
    }),
    ["error:scope-protects-goal"],
  );
  const any = { ...s, config: { ...(s.config as object), allowMidSprintAdd: "any" } };
  assert.deepEqual(
    run(any, {
      type: "ceremony.commit",
      by: "developer",
      payload: { items: ["B"], goalImpact: "none" },
    }),
    [],
  );
});

test("po-orders-backlog", () => {
  const s = withBacklog();
  assert.deepEqual(
    run(s, {
      type: "ceremony.refine",
      by: "developer",
      payload: { items: [{ id: "A", patch: { priority: 9 } }] },
    }),
    ["error:po-orders-backlog"],
  );
  assert.deepEqual(
    run(s, {
      type: "ceremony.refine",
      by: "developer",
      payload: { items: [{ id: "A", patch: { weight: 2 } }] },
    }),
    [],
  );
  assert.deepEqual(
    run(s, {
      type: "ceremony.refine",
      by: "product-owner",
      payload: { items: [{ id: "A", patch: { priority: 9 } }] },
    }),
    [],
  );
});

test("dod-not-weakened", () => {
  const s = m.ceremonies["plan"]!(withBacklog(), {
    by: "scrum-master",
    now: T0,
    goal: "g",
    items: ["A"],
  }).state;
  assert.deepEqual(
    run(s, {
      type: "ceremony.retro",
      by: "scrum-master",
      payload: { lessons: [], dodChanges: [] },
    }),
    ["error:dod-not-weakened"],
  );
  assert.deepEqual(
    run(s, { type: "ceremony.retro", by: "scrum-master", payload: { lessons: [] } }),
    [],
  );
});

const withDod = (state: WorkflowState): WorkflowState => ({
  ...state,
  config: {
    ...(state.config as object),
    definitionOfDone: [{ kind: "evidence", evidenceKind: "test-output" }],
  },
});
const retroAction = (payload: Record<string, unknown>): Action => ({
  type: "ceremony.retro",
  by: "scrum-master",
  payload,
});

test("dod-not-weakened between sprints", () => {
  let s = m.ceremonies["plan"]!(withBacklog(), {
    by: "scrum-master",
    now: T0,
    goal: "g",
    items: ["A"],
  }).state;
  s = withDod(m.ceremonies["cancel"]!(s, { by: "product-owner", now: T1, reason: "x" }).state);
  const vs = scrumRules().flatMap((r) =>
    r.check(s, retroAction({ dodChanges: [{ kind: "acceptance-written" }] })),
  );
  assert.equal(vs.length, 1);
  assert.match(vs[0]!.message, /evidence test-output/);
  assert.match(vs[0]!.fix, /allowWeaken/);
  assert.deepEqual(
    run(s, retroAction({ dodChanges: [{ kind: "acceptance-written" }], allowWeaken: true })),
    [],
  );
  assert.deepEqual(
    run(
      s,
      retroAction({
        dodChanges: [
          { kind: "evidence", evidenceKind: "test-output" },
          { kind: "acceptance-written" },
        ],
      }),
    ),
    [],
  );
  // the same policies written with their keys in another order are not a removal
  assert.deepEqual(
    run(
      s,
      retroAction({
        dodChanges: [{ evidenceKind: "test-output", kind: "evidence" }],
      }),
    ),
    [],
  );
});

test("carryover-reestimated", () => {
  let s = m.ceremonies["plan"]!(withBacklog(), {
    by: "scrum-master",
    now: T0,
    goal: "g",
    items: ["A"],
  }).state;
  s = m.ceremonies["cancel"]!(s, { by: "product-owner", now: T1, reason: "x" }).state; // A carried over
  s = m.ceremonies["retro"]!(s, { by: "scrum-master", now: T1, lessons: [] }).state;
  assert.deepEqual(
    run(s, { type: "ceremony.plan", by: "scrum-master", payload: { goal: "g2", items: ["A"] } }),
    ["error:carryover-reestimated"],
  );
  const re = editItem(s, "A", { weight: 2 }, "developer", T1);
  assert.deepEqual(
    run(re, { type: "ceremony.plan", by: "scrum-master", payload: { goal: "g2", items: ["A"] } }),
    [],
  );
});

test("sprint-closing refuses commit into a closing sprint; uncommit stays allowed (B07)", () => {
  let s = m.ceremonies["plan"]!(withBacklog(), {
    by: "scrum-master",
    now: T0,
    goal: "g",
    items: ["A"],
  }).state;
  const commit: Action = {
    type: "ceremony.commit",
    by: "product-owner",
    payload: { items: ["B"], goalImpact: "none" },
  };
  assert.deepEqual(run(s, commit), []);
  s = { ...s, iterations: s.iterations.map((i) => ({ ...i, closing: true })) };
  assert.deepEqual(run(s, commit), ["error:sprint-closing"]);
  assert.deepEqual(
    run(s, { type: "ceremony.uncommit", by: "product-owner", payload: { items: ["A"] } }),
    [],
  );
  assert.throws(
    () =>
      m.ceremonies["commit"]!(s, {
        by: "product-owner",
        now: T1,
        items: ["B"],
        goalImpact: "none",
      }),
    (e: unknown) =>
      e instanceof WorkflowError && e.code === "rule-violation" && /review or cancel/.test(e.fix),
  );
});
