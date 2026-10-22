import { test } from "node:test";
import assert from "node:assert/strict";
import { init } from "../methodology.ts";
import { addItem, getItem } from "../items.ts";
import { next } from "../brief.ts";
import { complete } from "../complete.ts";
import { DEFAULT_COLUMNS } from "./config.ts";
import { kanban } from "./index.ts";
import type { Accounting, ClassOfService, Handoff, WorkflowState } from "../types.ts";

const T = (min: number) =>
  new Date(Date.parse("2026-10-22T00:00:00.000Z") + min * 60_000).toISOString();
const m = kanban();
const SRM = "service-request-manager";

const hand = (item: string, role: string, over: Partial<Handoff> = {}): Handoff => ({
  item,
  role,
  produced: [{ kind: "test-output", ref: `ci/${item}` }],
  notes: "ok",
  do_not: [],
  open_questions: [],
  ...over,
});
const acct = (item: string, role: string, at: string): Accounting => ({
  item,
  role,
  model: "small",
  tokensIn: 1,
  tokensOut: 1,
  durationMs: 1,
  startedAt: at,
  endedAt: at,
});

/** A board with dev WIP limit 1 and a one-minute clock: every action advances the clock. */
class Board {
  s: WorkflowState;
  t = 0;
  /** ids dispatched into dev, one array per next() call */
  calls: string[][] = [];
  constructor(fairness?: { aging: boolean }, devLimit = 1) {
    const columns = DEFAULT_COLUMNS.map((c) => (c.id === "dev" ? { ...c, wipLimit: devLimit } : c));
    this.s = init({
      methodology: m,
      config: fairness ? { columns, fairness } : { columns },
      now: T(0),
    }).state;
  }
  tick(): string {
    return T(++this.t);
  }
  replenish(
    id: string,
    cos: ClassOfService = "standard",
    extra: { priority?: number; deadline?: string } = {},
  ): void {
    this.s = addItem(
      this.s,
      { id, title: id, acceptance: ["ok"], classOfService: cos, ...extra },
      SRM,
      this.tick(),
    );
    this.s = m.ceremonies["replenishment"]!(this.s, {
      by: SRM,
      now: this.tick(),
      items: [id],
    }).state;
  }
  /** One next() call; finishes whatever it dispatched so the dev slot is free again. */
  round(): string[] {
    const r = next(this.s, m, { now: this.tick() });
    this.s = r.state;
    const dev = r.briefs.filter((b) => b.item.stage === "dev").map((b) => b.item.id);
    for (const b of r.briefs) {
      const role = getItem(this.s, b.item.id).role!;
      this.s = complete(
        this.s,
        m,
        hand(b.item.id, role, b.item.stage === "dev" ? {} : { produced: [] }),
        acct(b.item.id, role, T(this.t)),
        T(this.t),
      ).state;
    }
    this.calls.push(dev);
    return dev;
  }
}

test("1: an expedite card is dispatched before every non-expedite card, whatever their priority", () => {
  const b = new Board();
  b.replenish("S1", "standard", { priority: 1000 });
  b.replenish("F1", "fixed-date", { priority: 1000, deadline: T(1) });
  b.replenish("E1", "expedite", { priority: -50 });
  for (let i = 1; i <= 3; i++) {
    b.replenish(`N${i}`, "standard", { priority: 1000 });
    b.round();
  }
  assert.deepEqual(b.calls.flat().slice(0, 3), ["E1", "F1", "S1"]);
});

test("2: a fixed-date card beats every standard card; earliest deadline first", () => {
  const b = new Board();
  b.replenish("F-late", "fixed-date", { deadline: T(900) });
  b.replenish("F-early", "fixed-date", { deadline: T(500) });
  b.replenish("F-mid", "fixed-date", { deadline: T(700), priority: -100 });
  for (let i = 1; i <= 4; i++) {
    b.replenish(`N${i}`, "standard", { priority: 1_000_000 });
    b.round();
  }
  assert.deepEqual(b.calls.flat(), ["F-early", "F-mid", "F-late", "N1"]);
});

test("3: standard cards order by their own priority, then oldest in the column; aging promotes stepwise", () => {
  const b = new Board();
  b.replenish("A", "standard", { priority: 1 });
  b.replenish("B", "standard", { priority: 5 });
  b.replenish("C", "standard", { priority: 5 });
  for (let i = 1; i <= 3; i++) {
    b.replenish(`N${i}`, "standard");
    b.round();
  }
  assert.deepEqual(b.calls.flat(), ["B", "C", "A"]);
  // a fresh high-priority card beats an older low-priority one deferred fewer than 5 times; at 5 the older card wins
  const aging = new Board();
  aging.replenish("OLD", "standard", { priority: 1 });
  for (let i = 1; i <= 6; i++) {
    aging.replenish(`X${i}`, "standard", { priority: 9 });
    aging.round();
  }
  assert.deepEqual(aging.calls.flat(), ["X1", "X2", "X3", "X4", "X5", "OLD"]);
  // with aging off nothing but priority and column age matters
  const off = new Board({ aging: false });
  off.replenish("A", "standard", { priority: 1 });
  off.replenish("B", "standard", { priority: 5 });
  off.replenish("C", "standard", { priority: 5 });
  for (const [i, p] of [9, 7, 6].entries()) {
    off.replenish(`N${i}`, "standard", { priority: p });
    off.round();
  }
  assert.deepEqual(off.calls.flat(), ["N0", "N1", "N2"]);
});

test("4: an intangible card is dispatched after maxDeferralRounds deferrals with aging, and last without", () => {
  const b = new Board();
  b.replenish("I", "intangible");
  for (let i = 1; i <= 8; i++) {
    b.replenish(`N${i}`, "standard");
    b.round();
  }
  const at = b.calls.findIndex((c) => c.includes("I")) + 1; // 1-based next() call index
  assert.equal(at, 6); // deferred by calls 1-5, dispatched on the sixth
  assert.deepEqual(b.calls.slice(0, 5), [["N1"], ["N2"], ["N3"], ["N4"], ["N5"]]);
  assert.equal(b.calls[5]![0], "I");

  const off = new Board({ aging: false });
  off.replenish("I", "intangible");
  for (let i = 1; i <= 8; i++) {
    off.replenish(`N${i}`, "standard");
    off.round();
  }
  assert.ok(off.calls.every((c) => !c.includes("I")));
  assert.deepEqual(off.round(), ["I"]); // only when nothing else is ready
});

test("5: a question item is dispatched before everything, including expedites", () => {
  const b = new Board();
  b.replenish("P", "standard");
  b.round(); // P goes to dev and is completed into review, so use a second parent that escalates
  b.replenish("P2", "standard");
  b.replenish("E1", "expedite");
  b.replenish("F1", "fixed-date", { deadline: T(1) });
  const r = next(b.s, m, { now: b.tick() });
  b.s = r.state;
  assert.deepEqual(
    r.briefs.filter((x) => x.item.stage === "dev").map((x) => x.item.id),
    ["E1"],
  ); // sanity: with no question the expedite wins the single slot
  b.s = complete(
    b.s,
    m,
    hand("E1", "worker", { verdict: "escalate", open_questions: ["which DB?"] }),
    acct("E1", "worker", T(b.t)),
    T(b.t),
  ).state;
  assert.equal(getItem(b.s, "E1-q1").type, "question");
  const dev = b.round();
  assert.deepEqual(dev, ["E1-q1"]);
  assert.deepEqual(b.round(), ["E1"]);
});
