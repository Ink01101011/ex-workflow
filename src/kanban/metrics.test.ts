import { test } from "node:test";
import assert from "node:assert/strict";
import { init } from "../methodology.ts";
import { addItem, clearBlocker, moveItem, raiseBlocker } from "../items.ts";
import { next } from "../brief.ts";
import { complete } from "../complete.ts";
import { kanban } from "./index.ts";
import { kanbanMetrics, percentile } from "./metrics.ts";
import type { Accounting, Handoff, WorkflowState } from "../types.ts";

const T = (min: number) =>
  new Date(Date.parse("2026-10-22T00:00:00.000Z") + min * 60_000).toISOString();
const MIN = 60_000;
const m = kanban();
const c = m.ceremonies;
const hand = (item: string, over: Partial<Handoff> = {}): Handoff => ({
  item,
  role: "worker",
  produced: [{ kind: "test-output", ref: `ci/${item}` }],
  notes: "ok",
  do_not: [],
  open_questions: [],
  ...over,
});
const acct = (item: string, at: string): Accounting => ({
  item,
  role: "worker",
  model: "small",
  tokensIn: 50,
  tokensOut: 50,
  durationMs: 1000,
  startedAt: at,
  endedAt: at,
});
const done = (s: WorkflowState, id: string, at: string, over: Partial<Handoff> = {}) =>
  complete(s, m, hand(id, over), acct(id, at), at).state;

const config = {
  classesOfService: {
    standard: { sle: { percentile: 85, targetMs: 10 * MIN } },
    "fixed-date": { sle: { percentile: 85, targetMs: 5 * MIN } },
  },
  throughputWindowMs: 10 * MIN,
};

/** Three cards: A delivered at T9, F at T14, B (blocked once) at T18. Returns the mid-flow state (after T10) and the final one. */
function week(): { mid: WorkflowState; end: WorkflowState } {
  let s = init({ methodology: m, config, now: T(0) }).state;
  s = addItem(s, { id: "A", title: "a", acceptance: ["ok"] }, "service-request-manager", T(1));
  s = addItem(s, { id: "B", title: "b", acceptance: ["ok"] }, "service-request-manager", T(1));
  s = addItem(
    s,
    { id: "F", title: "f", acceptance: ["ok"], classOfService: "fixed-date", deadline: T(30) },
    "service-request-manager",
    T(1),
  );
  s = c["replenishment"]!(s, {
    by: "service-request-manager",
    now: T(2),
    items: ["A", "B", "F"],
  }).state;
  s = next(s, m, { now: T(3) }).state; // A, B, F into dev
  s = done(s, "B", T(5), { verdict: "blocked", notes: "waiting" });
  s = done(s, "A", T(6)); // -> review
  s = next(s, m, { now: T(7) }).state; // A review in progress
  s = clearBlocker(s, "B", "B-b1", "human", T(8)); // B back to ready
  s = done(s, "A", T(9), { produced: [] }); // delivered
  s = next(s, m, { now: T(10) }).state; // B into dev
  const mid = s;
  s = done(s, "F", T(12));
  s = next(s, m, { now: T(13) }).state;
  s = done(s, "F", T(14), { produced: [] });
  s = done(s, "B", T(16));
  s = next(s, m, { now: T(17) }).state;
  s = done(s, "B", T(18), { produced: [] });
  return { mid, end: s };
}

test("percentile is nearest-rank", () => {
  assert.equal(percentile([], 85), 0);
  assert.equal(percentile([5], 50), 5);
  assert.equal(percentile([3, 1, 2], 50), 2);
  assert.equal(percentile([3, 1, 2], 85), 3);
  assert.equal(percentile([3, 1, 2], 0), 1);
});

test("flow metrics after one week", () => {
  const { mid, end } = week();
  const mm = kanbanMetrics(end);
  assert.deepEqual(mm.leadTimeMs, [7 * MIN, 12 * MIN, 16 * MIN]);
  assert.equal(mm.leadTimeP50, 12 * MIN);
  assert.equal(mm.leadTimeP85, 16 * MIN);
  assert.deepEqual(mm.cycleTimeMsByColumn, {
    options: 1 * MIN,
    ready: 1.25 * MIN,
    dev: 5.75 * MIN,
    review: 420_000 / 3,
  }); // means of exact minute counts
  assert.deepEqual(mm.throughput, [1, 2]);
  assert.deepEqual(mm.wipByColumn, { options: 0, ready: 0, dev: 0, review: 0, done: 0 });
  assert.ok(Math.abs(mm.flowEfficiency - 24 / 35) < 1e-9);
  assert.deepEqual(mm.agingWipMs, {});
  assert.deepEqual(mm.cumulativeFlow, {
    "2026-10-22:options": 3,
    "2026-10-22:ready": 3,
    "2026-10-22:dev": 3,
    "2026-10-22:review": 3,
    "2026-10-22:done": 3,
  });
  assert.deepEqual(mm.sleCompliance, { standard: 0.5, "fixed-date": 0 });
  assert.equal(mm.blockerTimeMs, 3 * MIN);
  assert.equal(mm.meanBlockerTimeMs, 3 * MIN);
  const half = kanbanMetrics(mid);
  assert.deepEqual(half.leadTimeMs, [7 * MIN]);
  assert.deepEqual(half.wipByColumn, { options: 0, ready: 0, dev: 2, review: 0, done: 0 });
  assert.deepEqual(half.agingWipMs, { F: 7 * MIN, B: 0 });
  assert.deepEqual(half.throughput, [1]);
});

test("metrics read only events, stages and config", () => {
  const { end } = week();
  assert.deepEqual(
    kanbanMetrics(end),
    kanbanMetrics({ ...end, items: {}, iterations: [], accounting: [] }),
  );
  assert.deepEqual(m.metrics(end), { ...kanbanMetrics(end) });
  const fresh = init({ methodology: m, config, now: T(0) }).state;
  const zero = kanbanMetrics(fresh);
  assert.deepEqual(zero.leadTimeMs, []);
  assert.deepEqual(zero.throughput, []);
  assert.equal(zero.flowEfficiency, 0);
  assert.deepEqual(zero.sleCompliance, {});
  assert.deepEqual(zero.wipByColumn, { options: 0, ready: 0, dev: 0, review: 0, done: 0 });
});

test("question items are neither commitments nor deliveries", () => {
  const { end } = week();
  const before = kanbanMetrics(end);
  let s = addItem(
    end,
    { id: "Q", title: "q", type: "question", stage: "ready" },
    "service-request-manager",
    T(19),
  );
  s = moveItem(s, "Q", { stage: "done", status: "done" }, "human", T(19));
  const after = kanbanMetrics(s);
  assert.deepEqual(after.leadTimeMs, before.leadTimeMs);
  assert.deepEqual(after.throughput, before.throughput);
  assert.deepEqual(after.sleCompliance, before.sleCompliance);
  assert.equal(after.flowEfficiency, before.flowEfficiency);
  assert.deepEqual(after.wipByColumn, before.wipByColumn);
  assert.equal(
    after.cumulativeFlow["2026-10-22:done"],
    before.cumulativeFlow["2026-10-22:done"]! + 1,
  );
});

test("cumulative flow spans UTC days", () => {
  const d1 = "2026-10-22T23:50:00.000Z";
  const d2 = "2026-10-23T00:10:00.000Z";
  let s = init({ methodology: m, config, now: d1 }).state;
  s = addItem(s, { id: "A", title: "a", acceptance: ["ok"] }, "service-request-manager", d1);
  s = addItem(s, { id: "B", title: "b", acceptance: ["ok"] }, "service-request-manager", d1);
  s = c["replenishment"]!(s, {
    by: "service-request-manager",
    now: "2026-10-22T23:55:00.000Z",
    items: ["A", "B"],
  }).state;
  s = next(s, m, { now: d2 }).state;
  assert.deepEqual(kanbanMetrics(s).cumulativeFlow, {
    "2026-10-22:options": 2,
    "2026-10-22:ready": 2,
    "2026-10-22:dev": 0,
    "2026-10-22:review": 0,
    "2026-10-22:done": 0,
    "2026-10-23:options": 2,
    "2026-10-23:ready": 2,
    "2026-10-23:dev": 2,
    "2026-10-23:review": 0,
    "2026-10-23:done": 0,
  }); // both cards are pulled into dev by the single next() call
});

test("an open blocker is measured to the last event", () => {
  const { mid } = week();
  let s = raiseBlocker(mid, "F", "waiting", "human", "human", T(12)); // never cleared
  s = addItem(s, { id: "Z", title: "z" }, "service-request-manager", T(17)); // last event
  const mm = kanbanMetrics(s);
  // B: T5 -> T8 (3 min, cleared) + F: T12 -> T17 (5 min, open, measured to last event)
  assert.equal(mm.blockerTimeMs, 8 * MIN);
  assert.equal(mm.meanBlockerTimeMs, 4 * MIN);
});
