import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addItem,
  clearBlocker,
  complete,
  getItem,
  init,
  next,
  openIteration,
} from "../src/index.ts";
import { scrum, scrumMetrics } from "../src/scrum/index.ts";
import type { Accounting, Handoff, WorkflowState } from "../src/index.ts";

const m = scrum();
const c = m.ceremonies;
const config = {
  sprintBudget: { tokens: 300_000 },
  productGoal: "ship the checkout",
  definitionOfDone: [{ kind: "evidence", evidenceKind: "test-output" }],
};
let clock = Date.parse("2026-10-19T00:00:00.000Z");
const tick = () => new Date((clock += 60_000)).toISOString();
const h = (item: string, role: string, over: Partial<Handoff> = {}): Handoff => ({
  item,
  role,
  produced: [{ kind: "test-output", ref: `ci/${item}` }],
  notes: `${item} done`,
  do_not: [],
  open_questions: [],
  ...over,
});
const acc = (item: string, role: string, tokens: number): Accounting => ({
  item,
  role,
  model: "small-worker",
  tokensIn: tokens * 0.6,
  tokensOut: tokens * 0.4,
  durationMs: 1000,
  startedAt: tick(),
  endedAt: tick(),
});

/** Drive every dispatched item through work and review until next() has nothing to do. */
function runUntilIdle(
  state: WorkflowState,
  onBrief: (id: string, role: string, status: string) => Partial<Handoff> | undefined,
): WorkflowState {
  for (let guard = 0; guard < 50; guard++) {
    const res = next(state, m, { now: tick(), fallbackTokensPerWeight: 100 });
    state = res.state;
    if (res.briefs.length === 0) return state;
    for (const b of res.briefs) {
      const over = onBrief(b.item.id, b.role.id, b.item.stage) ?? {};
      state = complete(
        state,
        m,
        h(b.item.id, b.role.id, over),
        acc(b.item.id, b.role.id, 300),
        tick(),
      ).state;
    }
  }
  throw new Error("did not settle");
}

test("two sprints end to end", () => {
  let s = init({ methodology: m, config, now: tick() }).state;
  s = addItem(
    s,
    { id: "CART", title: "cart API", weight: 3, priority: 5, acceptance: ["add/remove items"] },
    "product-owner",
    tick(),
  );
  s = addItem(
    s,
    {
      id: "PAY",
      title: "payment",
      weight: 5,
      priority: 4,
      acceptance: ["charge succeeds"],
      dependsOn: ["CART"],
    },
    "product-owner",
    tick(),
  );
  s = addItem(
    s,
    { id: "MAIL", title: "receipt mail", weight: 2, priority: 3, acceptance: ["mail sent"] },
    "product-owner",
    tick(),
  );
  s = addItem(
    s,
    { id: "DOCS", title: "api docs", weight: 1, priority: 1, acceptance: ["published"] },
    "product-owner",
    tick(),
  );

  // ---- Sprint 1
  s = c["plan"]!(s, {
    by: "scrum-master",
    now: tick(),
    goal: "customers can pay",
    items: "auto",
  }).state;
  assert.deepEqual(openIteration(s)!.committed, ["CART", "PAY", "MAIL", "DOCS"]);
  let escalated = false;
  let mailBlocked = false;
  let docsReworked = false;
  s = runUntilIdle(s, (id, _role, stage) => {
    if (id === "DOCS" && stage === "review" && !docsReworked) {
      docsReworked = true;
      return { verdict: "rework", notes: "add a curl example", produced: [] };
    }
    if (id === "MAIL" && stage === "in_progress" && !mailBlocked) {
      mailBlocked = true;
      return {
        verdict: "blocked",
        notes: "SMTP credentials missing",
        follow_ups: [
          {
            id: "SMTP-SETUP",
            title: "provision SMTP creds",
            weight: 1,
            acceptance: ["creds in vault"],
          },
        ],
      };
    }
    if (id === "PAY" && stage === "in_progress" && !escalated) {
      escalated = true;
      return { verdict: "escalate", open_questions: ["Stripe or Omise?"] };
    }
    if (id === "PAY-q1" && stage === "in_progress")
      return {
        produced: [{ kind: "decision", ref: "Omise" }],
        notes: "Omise",
        do_not: ["do not add Stripe SDK"],
        lessons: [{ text: "payment provider was not in the spec", scope: "spec" }],
      };
    return undefined;
  });
  assert.equal(getItem(s, "CART").status, "done");
  assert.equal(getItem(s, "DOCS").status, "done");
  assert.equal(s.events.filter((e) => e.type === "item.rework").length, 1); // DOCS went back once and came through
  assert.equal(getItem(s, "SMTP-SETUP").stage, "backlog"); // follow-up landed in the Product Backlog, not the sprint
  assert.equal(getItem(s, "SMTP-SETUP").iteration, undefined);
  assert.equal(getItem(s, "MAIL").status, "blocked");
  assert.equal(getItem(s, "PAY-q1").type, "question");
  assert.equal(getItem(s, "PAY-q1").role, "product-owner"); // first role with escalate
  assert.equal(getItem(s, "PAY-q1").status, "done");
  assert.equal(getItem(s, "PAY").status, "done"); // re-dispatched after the answer, with it as upstream
  assert.deepEqual(getItem(s, "PAY").dependsOn, ["CART", "PAY-q1"]);

  // someone fixes the SMTP credentials; MAIL is re-queued and finished
  s = clearBlocker(s, "MAIL", "MAIL-b1", "scrum-master", tick());
  assert.equal(getItem(s, "MAIL").stage, "sprint");
  s = runUntilIdle(s, () => undefined);
  assert.equal(getItem(s, "MAIL").status, "done");
  const daily = c["daily"]!(s, { by: "scrum-master", now: tick() }).state;
  assert.equal((daily.events.at(-1)!.payload as { remainingWeight: number }).remainingWeight, 0);
  s = c["review"]!(daily, {
    by: "human",
    now: tick(),
    accepted: true,
    goalMet: true,
    feedback: [{ id: "REFUND", title: "refunds", weight: 3, acceptance: ["refund works"] }],
  }).state;
  const s1 = s.iterations[0]!;
  assert.equal(s1.outcome, "completed");
  assert.deepEqual(s1.carryover, []);
  assert.ok(s1.spent.tokens > 0);

  // ---- Retro: adopt the lesson the worker raised, turn it into a working agreement and a backlog item; tighten the DoD
  assert.equal(s.lessons.filter((l) => l.status === "raised").length, 1);
  const raised = s.lessons[0]!;
  s = c["retro"]!(s, {
    by: "scrum-master",
    now: tick(),
    lessons: [{ text: "ask about payment provider before planning", scope: "memory" }],
    adopt: [
      {
        id: raised.id,
        suggestedChange: {
          kind: "agreement",
          text: "every integration story names its provider in acceptance",
        },
      },
    ],
    dodChanges: [{ kind: "evidence", evidenceKind: "test-output" }, { kind: "no-open-blockers" }],
  }).state;
  assert.equal(s.lessons.length, 2);
  assert.deepEqual(s.agreements, ["every integration story names its provider in acceptance"]);

  // ---- Sprint 2: REFUND
  s = c["plan"]!(s, { by: "scrum-master", now: tick(), goal: "refunds", items: ["REFUND"] }).state;
  // the agreement now reaches every brief
  const peek = next(s, m, { now: tick(), fallbackTokensPerWeight: 100 });
  assert.ok(
    peek.briefs[0]!.invariants.includes("every integration story names its provider in acceptance"),
  );
  s = peek.state;
  s = complete(s, m, h("REFUND", "developer"), acc("REFUND", "developer", 300), tick()).state;
  s = runUntilIdle(s, () => undefined);
  assert.equal(getItem(s, "REFUND").status, "done");
  s = c["review"]!(s, { by: "human", now: tick(), accepted: true, goalMet: true }).state;

  const mm = scrumMetrics(s);
  assert.deepEqual(mm.velocity, [11, 3]);
  assert.equal(mm.commitmentReliability, 1);
  assert.equal(mm.sprintGoalHitRate, 1);
  assert.ok(mm.costPerPoint > 0);
  // invariant: every metric is derivable from events alone
  assert.deepEqual(scrumMetrics({ ...s, items: {}, iterations: [], accounting: [] }), mm);
  // invariant: accounting always names the model
  assert.ok(s.accounting.every((a) => a.model === "small-worker"));
});
