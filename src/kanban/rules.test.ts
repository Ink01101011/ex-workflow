import { test } from "node:test";
import assert from "node:assert/strict";
import { init } from "../methodology.ts";
import { addItem, moveItem, raiseBlocker } from "../items.ts";
import { WorkflowError } from "../errors.ts";
import { kanban, kanbanStages, validateKanbanConfig } from "./index.ts";
import { kanbanRules } from "./rules.ts";
import type { Action, WorkflowState } from "../types.ts";

const T0 = "2026-10-22T00:00:00.000Z";
const m = kanban();
const run = (s: WorkflowState, a: Action) =>
  kanbanRules()
    .flatMap((r) => r.check(s, a))
    .map((v) => `${v.severity}:${v.rule}`);
const stagesOf = (columns: unknown[]) => kanbanStages(validateKanbanConfig({ columns }));
const P = [{ kind: "acceptance-written" as const }];

function withOptions(): WorkflowState {
  let { state } = init({ methodology: m, config: {}, now: T0 });
  state = addItem(state, { id: "O1", title: "o1", acceptance: ["ok"] }, "human", T0);
  state = addItem(state, { id: "Q1", title: "q1", acceptance: ["ok"] }, "human", T0);
  state = addItem(state, { id: "Q2", title: "q2", acceptance: ["ok"] }, "human", T0);
  state = addItem(state, { id: "Q3", title: "q3", acceptance: ["ok"] }, "human", T0);
  state = addItem(
    state,
    { id: "F", title: "f", acceptance: ["ok"], classOfService: "fixed-date" },
    "human",
    T0,
  );
  state = addItem(
    state,
    { id: "E2", title: "e2", acceptance: ["ok"], classOfService: "expedite" },
    "human",
    T0,
  );
  return state;
}

const bad = (columns: unknown[], rule: string, re: RegExp) =>
  assert.throws(
    () => init({ methodology: m, config: {}, stages: stagesOf(columns), now: T0 }),
    (e: unknown) =>
      e instanceof WorkflowError &&
      e.code === "rule-violation" &&
      e.rule === rule &&
      re.test(e.message),
  );

test("init enforces explicit policies and exactly one commitment and delivery point", () => {
  bad(
    [
      { id: "options", policies: [] },
      { id: "ready", policies: P, commitmentPoint: true },
      { id: "done", policies: [], deliveryPoint: true },
    ],
    "policy-explicit",
    /column "options" has no explicit policy/,
  );
  bad(
    [
      { id: "options", policies: P },
      { id: "ready", policies: P, commitmentPoint: true },
      { id: "dev", policies: P, commitmentPoint: true },
      { id: "done", policies: [], deliveryPoint: true },
    ],
    "commitment-point-once",
    /2 columns are marked commitmentPoint/,
  );
  bad(
    [
      { id: "options", policies: P },
      { id: "ready", policies: P, commitmentPoint: true },
      { id: "done", policies: [], deliveryPoint: true },
      { id: "after", policies: P },
    ],
    "commitment-point-once",
    /not the last column/,
  );
  bad(
    [
      { id: "options", policies: P, commitmentPoint: true },
      { id: "dev", policies: P },
      { id: "done", policies: [], deliveryPoint: true },
    ],
    "commitment-point-once",
    /is the first column/,
  );
  bad(
    [
      { id: "options", policies: P },
      { id: "ready", policies: P },
      { id: "done", policies: [], deliveryPoint: true },
    ],
    "commitment-point-once",
    /0 columns are marked commitmentPoint/,
  );
  assert.deepEqual(run(withOptions(), { type: "init", by: "system" }), []);
});

test("replenishment: WIP, pull-not-push, one expedite, fixed-date deadline", () => {
  let s = withOptions();
  s = addItem(
    s,
    { id: "E1", title: "e1", acceptance: ["ok"], classOfService: "expedite" },
    "human",
    T0,
  );
  s = moveItem(s, "E1", { stage: "ready", status: "todo" }, "human", T0);
  s = addItem(s, { id: "D", title: "d", acceptance: ["ok"] }, "human", T0);
  s = moveItem(s, "D", { stage: "dev", status: "todo" }, "human", T0);
  const rep = (items: string[], column?: string) =>
    run(s, {
      type: "ceremony.replenishment",
      by: "human",
      payload: column ? { items, column } : { items },
    });
  assert.deepEqual(rep(["O1"]), []);
  assert.deepEqual(rep(["F"]), ["error:fixed-date-needs-deadline"]);
  assert.deepEqual(rep(["E2"]), ["error:one-expedite"]);
  assert.deepEqual(rep(["D"]), ["error:pull-not-push"]);
  assert.deepEqual(rep(["O1"], "dev"), ["error:pull-not-push"]);
  assert.deepEqual(rep(["O1", "Q1", "Q2"]), []); // ready holds E1: 1 + 3 = 4 = limit
  assert.deepEqual(rep(["O1", "Q1", "Q2", "Q3"]), ["error:wip-respected"]);
  assert.deepEqual(rep(["Q1", "Q2", "Q3", "E2"]), ["error:one-expedite"]); // bypass lifts WIP to 5; the second expedite is the problem
  const v = kanbanRules().flatMap((r) =>
    r.check(s, {
      type: "ceremony.replenishment",
      by: "human",
      payload: { items: ["O1", "Q1", "Q2", "Q3"] },
    }),
  );
  assert.match(v[0]!.fix, /pull at most 3 card\(s\) now/);
  const wide = { ...s, config: { ...validateKanbanConfig(s.config), maxExpedite: 2 } };
  assert.deepEqual(
    run(wide, { type: "ceremony.replenishment", by: "human", payload: { items: ["E2"] } }),
    [],
  );
});

test("service-delivery-review: policies stay explicit, lowering WIP below active work warns", () => {
  let s = withOptions();
  s = addItem(s, { id: "D", title: "d", acceptance: ["ok"] }, "human", T0);
  s = moveItem(s, "D", { stage: "dev", status: "in_progress" }, "human", T0);
  const sdr = (payload: Record<string, unknown>) =>
    run(s, { type: "ceremony.service-delivery-review", by: "human", payload });
  assert.deepEqual(sdr({ policies: { dev: [] } }), ["error:policy-explicit"]);
  assert.deepEqual(sdr({ wip: { dev: 0 } }), ["warning:wip-respected"]);
  assert.deepEqual(sdr({ wip: { dev: 1, ready: null }, policies: { done: [] } }), []);
});

test("blocker-has-owner warns on every cadence and errors on an ownerless assignment", () => {
  let s = withOptions();
  s = raiseBlocker(s, "O1", "stuck", "", "human", T0);
  assert.deepEqual(run(s, { type: "ceremony.risk-review", by: "human" }), [
    "warning:blocker-has-owner",
  ]);
  assert.deepEqual(
    run(s, {
      type: "ceremony.operations-review",
      by: "human",
      payload: { assign: [{ item: "O1", blocker: "O1-b1", owner: " " }] },
    }),
    ["error:blocker-has-owner", "warning:blocker-has-owner"],
  );
  assert.deepEqual(run(s, { type: "item.add", by: "human" }), []);
});
