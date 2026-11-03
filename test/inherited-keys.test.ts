// U11 O1/O9: ids that are Object.prototype member names. assertId refuses them since 1.2, but a
// state written by an earlier release may carry them, so every lookup keyed by an id must use own
// properties. Each state below is built with a placeholder id and renamed, as an old file would be.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addItem, appendEvent, init, validateAction } from "../src/index.ts";
import { moveItem } from "../src/core/items/move.ts";
import {
  DEFAULT_COLUMNS,
  kanban,
  kanbanMetrics,
  opsReport,
} from "../src/methodologies/kanban/index.ts";
import { dailyReport, scrum } from "../src/methodologies/scrum/index.ts";
import { waterfall, waterfallMetrics } from "../src/methodologies/waterfall/index.ts";
import type { WorkflowState } from "../src/index.ts";

const T0 = "2026-10-19T00:00:00.000Z";
const at = (n: number) => new Date(Date.parse(T0) + n * 60_000).toISOString();
const rename = (s: WorkflowState, from: string, to: string): WorkflowState =>
  JSON.parse(JSON.stringify(s).replaceAll(`"${from}"`, `"${to}"`)) as WorkflowState;
const numbers = (r: Record<string, unknown>) =>
  Object.entries(r).every(([, v]) => typeof v === "number" || v === null);

test("kanban metrics and the operations report survive a column id named toString", () => {
  const m = kanban();
  const columns = DEFAULT_COLUMNS.map((c) => (c.id === "dev" ? { ...c, id: "zzcol" } : c));
  let s = init({ methodology: m, config: { columns }, now: T0 }).state;
  s = addItem(s, { id: "A", title: "a", weight: 1 }, "human", T0);
  s = moveItem(s, "A", { stage: "ready", status: "todo" }, "human", at(1));
  s = moveItem(s, "A", { stage: "zzcol", status: "in_progress" }, "human", at(2));
  s = moveItem(s, "A", { stage: "review", status: "review" }, "human", at(3));
  s = addItem(s, { id: "B", title: "b", weight: 1 }, "human", at(4));
  s = moveItem(s, "B", { stage: "ready", status: "todo" }, "human", at(5));
  s = moveItem(s, "B", { stage: "zzcol", status: "in_progress" }, "human", at(6));
  s = rename(s, "zzcol", "toString");
  const metrics = kanbanMetrics(s);
  assert.ok(metrics);
  assert.deepEqual(m.metrics(s), metrics);
  const ops = opsReport(s, at(10));
  assert.equal(ops.active["toString"], 1);
  assert.ok(numbers(ops.active) && numbers(ops.queued));
  const b = ops.agingWip.find((x) => x.item === "B");
  assert.equal(b?.p85Ms, 60_000, "the completed stay of A in the toString column counts");
});

test("kanban replenishment rule ignores an item id that only exists on Object.prototype", () => {
  const m = kanban();
  const s = init({ methodology: m, config: {}, now: T0 }).state;
  const violations = validateAction(s, m, {
    type: "ceremony.replenishment",
    by: "human",
    payload: { items: ["toString"] },
  });
  assert.ok(
    violations.every((v) => !/undefined/.test(v.message)),
    JSON.stringify(violations),
  );
});

test("waterfall metrics count no phase that only exists on Object.prototype", () => {
  let s = init({ methodology: waterfall(), config: {}, now: T0 }).state;
  s = appendEvent(
    s,
    "item.added",
    "human",
    { id: "Z", type: "task", phase: "toString", parent: null },
    T0,
  );
  s = appendEvent(s, "item.completed", "human", { id: "Z", tokens: 5 }, T0);
  s = appendEvent(s, "phase.opened", "human", { phase: "valueOf", budget: { tokens: 9 } }, T0);
  const w = waterfallMetrics(s);
  for (const key of [
    "phaseCompletion",
    "budgetPlanned",
    "budgetSpent",
    "defectsPerPhase",
  ] as const) {
    assert.equal(Object.hasOwn(w[key], "toString") || Object.hasOwn(w[key], "valueOf"), false, key);
    assert.ok(numbers(w[key]), key);
  }
});

test("scrum daily report skips a committed id that only exists on Object.prototype", () => {
  const m = scrum();
  const config = { sprintBudget: { tokens: 1000 }, productGoal: "g", definitionOfDone: [] };
  let s = init({ methodology: m, config, now: T0 }).state;
  s = addItem(s, { id: "A", title: "a", weight: 1, acceptance: ["ok"] }, "product-owner", T0);
  s = m.ceremonies["plan"]!(s, { by: "scrum-master", now: at(1), goal: "g", items: ["A"] }).state;
  const it = s.iterations.at(-1)!;
  s = {
    ...s,
    iterations: [...s.iterations.slice(0, -1), { ...it, committed: [...it.committed, "toString"] }],
  };
  const r = dailyReport(s);
  assert.equal(r.remainingWeight, 1);
  assert.ok(numbers(r.byStatus));
});
