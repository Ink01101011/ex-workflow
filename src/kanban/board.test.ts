import { test } from "node:test";
import assert from "node:assert/strict";
import { init } from "../methodology.ts";
import { addItem, clearBlocker, moveItem } from "../items.ts";
import { next } from "../brief.ts";
import { complete } from "../complete.ts";
import { appendEvent } from "../state.ts";
import { kanban } from "./index.ts";
import { replay } from "./replay.ts";
import { board, cadencesDue } from "./board.ts";
import type { Accounting, Handoff, WorkflowState } from "../types.ts";

const T = (min: number) =>
  new Date(Date.parse("2026-10-22T00:00:00.000Z") + min * 60_000).toISOString();
const m = kanban();
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

/** A delivered, B blocked once and re-pulled, C just added; commitment recorded by hand (the ceremony is Task 5). Not exported: importing a test file re-registers its tests. */
function flow(): WorkflowState {
  let s = init({
    methodology: m,
    config: { cadences: { replenishment: { everyTurns: 2 } } },
    now: T(0),
  }).state;
  s = addItem(s, { id: "A", title: "a", acceptance: ["ok"] }, "human", T(1));
  s = addItem(s, { id: "B", title: "b", acceptance: ["ok"] }, "human", T(1));
  s = moveItem(s, "A", { stage: "ready", status: "todo" }, "human", T(2));
  s = moveItem(s, "B", { stage: "ready", status: "todo" }, "human", T(2));
  s = appendEvent(
    s,
    "cadence.replenishment",
    "human",
    {
      column: "ready",
      items: [
        { id: "A", classOfService: "fixed-date", deadline: T(100) },
        { id: "B", classOfService: "standard", deadline: null },
      ],
    },
    T(2),
  );
  s = next(s, m, { now: T(3) }).state;
  s = complete(
    s,
    m,
    hand("B", { verdict: "blocked", notes: "waiting on api" }),
    acct("B", T(5)),
    T(5),
  ).state;
  s = clearBlocker(s, "B", "B-b1", "human", T(8));
  s = complete(s, m, hand("A"), acct("A", T(10)), T(10)).state;
  s = next(s, m, { now: T(11) }).state;
  s = complete(s, m, hand("A", { produced: [] }), acct("A", T(15)), T(15)).state;
  s = addItem(s, { id: "C", title: "c" }, "human", T(16));
  return s;
}

test("replay reconstructs stays, commitment, delivery, active and blocked time from events", () => {
  const r = replay(flow().events, "ready", "done");
  const a = r.items.get("A")!;
  assert.equal(a.committedAt, T(2));
  assert.equal(a.deliveredAt, T(15));
  assert.equal(a.type, "task");
  assert.equal(a.classOfService, "fixed-date");
  assert.equal(a.deadline, T(100));
  assert.deepEqual(
    a.stays.map((x) => [x.stage, x.enteredAt, x.leftAt ?? null]),
    [
      ["options", T(1), T(2)],
      ["ready", T(2), T(3)],
      ["dev", T(3), T(10)],
      ["review", T(10), T(15)],
      ["done", T(15), null],
    ],
  );
  assert.equal(a.activeMs, 11 * 60_000);
  assert.equal(a.status, "done");
  const b = r.items.get("B")!;
  assert.equal(b.committedAt, T(2));
  assert.equal(b.deliveredAt, undefined);
  assert.equal(b.classOfService, "standard");
  assert.deepEqual(
    b.stays.map((x) => x.stage),
    ["options", "ready", "dev", "ready", "dev"],
  );
  assert.equal(b.activeMs, 2 * 60_000);
  assert.equal(b.blockedMs, 3 * 60_000);
  assert.deepEqual(b.since, { status: "in_progress", at: T(11) });
  assert.deepEqual(r.blockers, [{ item: "B", blocker: "B-b1", raisedAt: T(5), clearedAt: T(8) }]);
  assert.equal(r.lastAt, T(16));
});

test("board reports active, queued, over-limit and card ages per column", () => {
  const cols = board(flow(), T(20));
  assert.deepEqual(
    cols.map((c) => c.id),
    ["options", "ready", "dev", "review", "done"],
  );
  const by = Object.fromEntries(cols.map((c) => [c.id, c]));
  assert.deepEqual(
    by["options"]!.cards.map((c) => [c.id, c.ageMs]),
    [["C", 4 * 60_000]],
  );
  assert.equal(by["ready"]!.commitmentPoint, true);
  assert.deepEqual(by["ready"]!.cards, []);
  assert.equal(by["dev"]!.wipLimit, 3);
  assert.equal(by["dev"]!.active, 1);
  assert.equal(by["dev"]!.queued, 0);
  assert.equal(by["dev"]!.overLimit, false);
  assert.deepEqual(
    by["dev"]!.cards.map((c) => [c.id, c.status, c.role, c.ageMs, c.blocked]),
    [["B", "in_progress", "worker", 9 * 60_000, false]],
  );
  assert.equal(by["done"]!.deliveryPoint, true);
  assert.deepEqual(
    by["done"]!.cards.map((c) => [c.id, c.status, c.ageMs]),
    [["A", "done", 5 * 60_000]],
  );
  const over = { ...flow() };
  over.stages = over.stages.map((st) => (st.id === "dev" ? { ...st, wipLimit: 0 } : st));
  assert.equal(board(over, T(20)).find((c) => c.id === "dev")!.overLimit, true);
});

test("cadencesDue counts completions since the last cadence event", () => {
  let s = flow();
  const due = cadencesDue(s);
  assert.equal(due.length, 6);
  const rep = due.find((d) => d.cadence === "replenishment")!;
  assert.deepEqual(rep, {
    cadence: "replenishment",
    everyTurns: 2,
    lastAt: T(2),
    turnsSince: 3,
    due: true,
  });
  const risk = due.find((d) => d.cadence === "risk-review")!;
  assert.deepEqual(risk, {
    cadence: "risk-review",
    everyTurns: null,
    lastAt: null,
    turnsSince: 3,
    due: false,
  });
  s = appendEvent(s, "cadence.replenishment", "human", { column: "ready", items: [] }, T(17));
  assert.deepEqual(
    cadencesDue(s).find((d) => d.cadence === "replenishment"),
    { cadence: "replenishment", everyTurns: 2, lastAt: T(17), turnsSince: 0, due: false },
  );
  assert.deepEqual(m.report!(s), { cadencesDue: cadencesDue(s) });
});
