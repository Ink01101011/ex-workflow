import { test } from "node:test";
import assert from "node:assert/strict";
import { init } from "../methodology.ts";
import { addItem } from "../items.ts";
import { next } from "../brief.ts";
import { complete } from "../complete.ts";
import { lastEvent } from "../state.ts";
import { WorkflowError } from "../errors.ts";
import { kanban } from "./index.ts";
import { opsReport, riskReport } from "./reports.ts";
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
const thrown = (fn: () => unknown): WorkflowError | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof WorkflowError ? e : undefined;
  }
};

/** A blocked in dev, F delivered (lead 6 min), G fixed-date overdue in dev, E an expedite still in options. */
function board(): WorkflowState {
  let s = init({ methodology: m, config: {}, now: T(0) }).state;
  s = addItem(s, { id: "A", title: "a", acceptance: ["ok"] }, "service-request-manager", T(1));
  s = addItem(
    s,
    { id: "F", title: "f", acceptance: ["ok"], classOfService: "fixed-date", deadline: T(20) },
    "service-request-manager",
    T(1),
  );
  s = addItem(
    s,
    { id: "G", title: "g", acceptance: ["ok"], classOfService: "fixed-date", deadline: T(9) },
    "service-request-manager",
    T(1),
  );
  s = addItem(
    s,
    { id: "E", title: "e", acceptance: ["ok"], classOfService: "expedite" },
    "service-request-manager",
    T(1),
  );
  s = c["replenishment"]!(s, {
    by: "service-request-manager",
    now: T(2),
    items: ["A", "F", "G"],
  }).state;
  s = next(s, m, { now: T(3) }).state;
  s = done(s, "A", T(5), { verdict: "blocked", notes: "waiting on api" });
  s = done(s, "F", T(6));
  s = next(s, m, { now: T(7) }).state;
  s = done(s, "F", T(8), { produced: [] });
  return s;
}

test("opsReport lists blockers, aging WIP against the column p85, and queue/active counts", () => {
  const r = opsReport(board(), T(10));
  assert.deepEqual(r.blockers, [
    { item: "A", blocker: "A-b1", owner: "worker", reason: "waiting on api", ageMs: 5 * MIN },
  ]);
  assert.deepEqual(r.agingWip, [
    { item: "A", column: "dev", status: "blocked", ageMs: 7 * MIN, p85Ms: 3 * MIN, overP85: true },
    {
      item: "G",
      column: "dev",
      status: "in_progress",
      ageMs: 7 * MIN,
      p85Ms: 3 * MIN,
      overP85: true,
    },
  ]);
  assert.deepEqual(r.active, { options: 0, ready: 0, dev: 2, review: 0, done: 0 });
  assert.deepEqual(r.queued, { options: 1, ready: 0, dev: 0, review: 0, done: 0 });
});

test("riskReport flags overdue fixed-date cards, stale blockers and active expedites", () => {
  const s = board();
  const r = riskReport(s, T(10), 1 * MIN);
  assert.deepEqual(r.fixedDate, [
    { item: "G", deadline: T(9), timeLeftMs: -1 * MIN, projectedRemainingMs: 0, atRisk: true },
  ]);
  assert.deepEqual(r.staleBlockers, [
    { item: "A", blocker: "A-b1", owner: "worker", ageMs: 5 * MIN },
  ]);
  assert.deepEqual(r.expediteActive, []);
  assert.deepEqual(riskReport(s, T(10), 10 * MIN).staleBlockers, []);
  const noHistory = init({ methodology: m, config: {}, now: T(0) }).state;
  assert.deepEqual(riskReport(noHistory, T(1), MIN), {
    fixedDate: [],
    staleBlockers: [],
    expediteActive: [],
  });
});

test("operations-review reassigns blockers and records the report", () => {
  const s = board();
  assert.equal(
    thrown(() => c["operations-review"]!(s, { by: "worker", now: T(10) }))?.code,
    "missing-capability",
  );
  assert.equal(
    thrown(() =>
      c["operations-review"]!(s, {
        by: "service-delivery-manager",
        now: T(10),
        assign: [{ item: "A", blocker: "nope", owner: "x" }],
      }),
    )?.code,
    "invalid-input",
  );
  assert.equal(
    thrown(() =>
      c["operations-review"]!(s, {
        by: "service-delivery-manager",
        now: T(10),
        assign: [{ item: "A", blocker: "A-b1", owner: "" }],
      }),
    )?.rule,
    "blocker-has-owner",
  );
  const r = c["operations-review"]!(s, {
    by: "service-delivery-manager",
    now: T(10),
    assign: [{ item: "A", blocker: "A-b1", owner: "service-delivery-manager" }],
  });
  assert.deepEqual(r.warnings, []);
  const evs = r.state.events.slice(-2);
  assert.equal(evs[0]!.type, "blocker.reassigned");
  assert.deepEqual(evs[0]!.payload, {
    id: "A",
    blocker: "A-b1",
    from: "worker",
    to: "service-delivery-manager",
  });
  assert.equal(evs[1]!.type, "cadence.operations-review");
  assert.deepEqual(evs[1]!.payload, opsReport(r.state, T(10)));
  assert.equal(r.state.items["A"]!.blockers[0]!.owner, "service-delivery-manager");
});

test("risk-review and strategy-review record their reports; strategy-review changes classes and maxExpedite", () => {
  const s = board();
  const risk = c["risk-review"]!(s, {
    by: "service-delivery-manager",
    now: T(10),
    staleAfterMs: MIN,
  });
  assert.deepEqual(lastEvent(risk.state)!.payload, riskReport(s, T(10), MIN));
  assert.equal(
    thrown(() =>
      c["risk-review"]!(s, { by: "service-delivery-manager", now: T(10), staleAfterMs: -1 }),
    )?.code,
    "invalid-input",
  );
  assert.equal(
    thrown(() => c["strategy-review"]!(s, { by: "worker", now: T(10) }))?.code,
    "missing-capability",
  );
  assert.equal(
    thrown(() =>
      c["strategy-review"]!(s, { by: "service-delivery-manager", now: T(10), maxExpedite: 0 }),
    )?.code,
    "config-invalid",
  );
  const r = c["strategy-review"]!(s, {
    by: "service-delivery-manager",
    now: T(10),
    maxExpedite: 2,
    classesOfService: { expedite: { wipBypass: 2 } },
  });
  const cfg = r.state.config as { maxExpedite: number; classesOfService: Record<string, unknown> };
  assert.equal(cfg.maxExpedite, 2);
  assert.deepEqual(cfg.classesOfService, { expedite: { wipBypass: 2 } });
  assert.deepEqual(lastEvent(r.state)!.payload, {
    mix: { expedite: 0, "fixed-date": 1, standard: 1, intangible: 0 },
    before: { classesOfService: {}, maxExpedite: 1 },
    after: { classesOfService: { expedite: { wipBypass: 2 } }, maxExpedite: 2 },
  });
  const cleared = c["strategy-review"]!(r.state, {
    by: "service-delivery-manager",
    now: T(11),
    classesOfService: { expedite: null },
  });
  assert.deepEqual((cleared.state.config as { classesOfService: unknown }).classesOfService, {});
});
