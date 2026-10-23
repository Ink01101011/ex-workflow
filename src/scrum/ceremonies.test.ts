import { test } from "node:test";
import assert from "node:assert/strict";
import { init } from "../methodology.ts";
import { addItem, getItem, moveItem } from "../items.ts";
import { next } from "../brief.ts";
import { complete } from "../complete.ts";
import { authorOf, decide } from "../gates.ts";
import { WorkflowError } from "../errors.ts";
import { resumeStageOf, scrum } from "./index.ts";
import { scrumStages } from "./stages.ts";
import { dailyReport } from "./ceremonies.ts";
import type { Accounting, Handoff, Stage, WorkflowState } from "../types.ts";

const T0 = "2026-10-19T00:00:00.000Z";
const T1 = "2026-10-19T01:00:00.000Z";
const config = {
  sprintBudget: { tokens: 1000 },
  productGoal: "ship v1",
  definitionOfDone: [{ kind: "evidence", evidenceKind: "test-output" }],
};
const code = (e: unknown) => (e instanceof WorkflowError ? e.code : String(e));
const codeOf = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return code(e);
  }
  return "none";
};
const m = scrum();
const c = m.ceremonies;

function backlog(): WorkflowState {
  let { state } = init({ methodology: m, config, now: T0 });
  state = addItem(
    state,
    { id: "A", title: "a", weight: 1, priority: 3, acceptance: ["ok"] },
    "product-owner",
    T0,
  );
  state = addItem(
    state,
    { id: "B", title: "b", weight: 2, priority: 2, acceptance: ["ok"] },
    "product-owner",
    T0,
  );
  state = addItem(
    state,
    { id: "C", title: "c", weight: 5, priority: 1, acceptance: ["ok"] },
    "product-owner",
    T0,
  );
  return state;
}
const h = (item: string, role = "developer", over: Partial<Handoff> = {}): Handoff => ({
  item,
  role,
  produced: [{ kind: "test-output", ref: "ci" }],
  notes: "",
  do_not: [],
  open_questions: [],
  ...over,
});
const a = (item: string, tokens: number, role = "developer"): Accounting => ({
  item,
  role,
  model: "haiku",
  tokensIn: tokens / 2,
  tokensOut: tokens / 2,
  durationMs: 10,
  startedAt: T0,
  endedAt: T0,
});

test("refine edits items and splits them; priority change needs order-backlog (rule in Task 13; here capability check)", () => {
  const s = backlog();
  const r = c["refine"]!(s, {
    by: "developer",
    now: T0,
    items: [{ id: "A", patch: { acceptance: ["ok", "fast"] } }],
    split: [
      {
        from: "C",
        into: [
          { id: "C1", title: "c1", weight: 2, acceptance: ["ok"] },
          { id: "C2", title: "c2", weight: 3, acceptance: ["ok"] },
        ],
      },
    ],
  });
  assert.deepEqual(getItem(r.state, "A").acceptance, ["ok", "fast"]);
  assert.equal(getItem(r.state, "C").status, "dropped");
  assert.equal(getItem(r.state, "C1").parent, "C");
  assert.equal(r.state.events.at(-1)!.type, "ceremony.refine");
  assert.throws(
    () =>
      c["refine"]!(s, {
        by: "scrum-master",
        now: T0,
        items: [{ id: "A", patch: { weight: 2 } }],
      }),
    (e) => code(e) === "missing-capability",
  );
});

test("plan auto commits by priority until the token budget is full", () => {
  const s = backlog();
  // fallback 20000 tokens/weight is far above a 1000-token budget, so seed history: 100 tokens per weight via accounting on a done item
  const seeded: WorkflowState = {
    ...s,
    items: {
      ...s.items,
      Z: {
        id: "Z",
        type: "task",
        title: "z",
        dependsOn: [],
        weight: 1,
        stage: "done",
        status: "done",
        acceptance: [],
        evidence: [],
        blockers: [],
        transitions: [],
      },
    },
    accounting: [a("Z", 100)],
  };
  const r = c["plan"]!(seeded, {
    by: "scrum-master",
    now: T0,
    goal: "finish A and B",
    items: "auto",
  });
  const it = r.state.iterations[0]!;
  assert.equal(it.id, "S1");
  assert.equal(it.goal, "finish A and B");
  assert.deepEqual(it.committed, ["A", "B", "C"]); // 100/weight → A=100, B=200, C=500 → total 800 ≤ 1000
  assert.equal(getItem(r.state, "A").stage, "sprint");
  assert.equal(getItem(r.state, "A").iteration, "S1");
  assert.equal(r.state.events.at(-1)!.type, "sprint.opened");
  const tight = c["plan"]!(
    { ...seeded, config: { ...config, sprintBudget: { tokens: 350 } } },
    { by: "scrum-master", now: T0, goal: "g", items: "auto" },
  );
  assert.deepEqual(tight.state.iterations[0]!.committed, ["A", "B"]);
});

test("plan validates goal, capability and backlog exit policy", () => {
  const s = backlog();
  assert.throws(
    () => c["plan"]!(s, { by: "scrum-master", now: T0, goal: "", items: ["A"] }),
    (e) => code(e) === "invalid-input",
  );
  assert.throws(
    () => c["plan"]!(s, { by: "developer", now: T0, goal: "g", items: ["A"] }),
    (e) => code(e) === "missing-capability",
  );
  const noEstimate = addItem(s, { id: "D", title: "d", acceptance: ["ok"] }, "product-owner", T0);
  assert.throws(
    () => c["plan"]!(noEstimate, { by: "scrum-master", now: T0, goal: "g", items: ["D"] }),
    (e) => code(e) === "policy-unmet",
  );
});

test("daily reports status, blockers, budget and forecast", () => {
  let s = c["plan"]!(backlog(), {
    by: "scrum-master",
    now: T0,
    goal: "g",
    items: ["A", "B"],
  }).state;
  s = next(s, m, { now: T0, fallbackTokensPerWeight: 10 }).state;
  s = complete(
    s,
    m,
    h("A", "developer", { verdict: "blocked", notes: "waiting" }),
    a("A", 100),
    T0,
  ).state;
  const rep = dailyReport(s);
  assert.equal(rep.sprint, "S1");
  assert.equal(rep.byStatus.blocked, 1);
  assert.equal(rep.byStatus.in_progress, 1);
  assert.equal(rep.blockers[0]!.item, "A");
  assert.equal(rep.spent.tokens, 100);
  assert.deepEqual(rep.remaining, { tokens: 900 });
  assert.equal(rep.remainingWeight, 3);
  assert.equal(rep.raisedLessons, 0);
  assert.equal(rep.velocity, null);
  assert.equal(rep.forecast, "unknown");
  const d = c["daily"]!(s, { by: "scrum-master", now: T1 });
  assert.equal(d.state.events.at(-1)!.type, "daily");
  assert.equal((d.state.events.at(-1)!.payload as { remainingWeight: number }).remainingWeight, 3);
});

test("review requires an approver, adds feedback to the backlog and closes the sprint", () => {
  let s = c["plan"]!(backlog(), { by: "scrum-master", now: T0, goal: "g", items: ["A"] }).state;
  s = next(s, m, { now: T0, fallbackTokensPerWeight: 10 }).state;
  s = complete(s, m, h("A"), a("A", 50), T0).state; // → review
  s = next(s, m, { now: T0, fallbackTokensPerWeight: 10 }).state; // reviewer dispatched (developer again is the only reviewer → assignRole must pick a different role)
  assert.throws(
    () => c["review"]!(s, { by: "scrum-master", now: T1, accepted: true, goalMet: true }),
    (e) => code(e) === "gate-unmet",
  );
  const r = c["review"]!(s, {
    by: "human",
    now: T1,
    accepted: true,
    goalMet: true,
    feedback: [{ id: "F1", title: "stakeholder ask", weight: 1, acceptance: ["ok"] }],
  });
  assert.equal(getItem(r.state, "F1").stage, "backlog");
  assert.equal(r.state.iterations[0]!.outcome, "completed");
  assert.ok(r.state.events.some((e) => e.type === "increment"));
  assert.equal(r.state.events.at(-1)!.type, "sprint.closed");
});

test("retro appends lessons and may change the DoD for the next sprint", () => {
  let s = c["plan"]!(backlog(), { by: "scrum-master", now: T0, goal: "g", items: ["A"] }).state;
  assert.throws(
    () => c["retro"]!(s, { by: "scrum-master", now: T1, lessons: [] }),
    (e) => code(e) === "invalid-input",
  ); // sprint still open
  s = c["cancel"]!(s, { by: "product-owner", now: T1, reason: "goal obsolete" }).state;
  assert.equal(s.iterations[0]!.outcome, "cancelled");
  // a worker raised a lesson during the sprint; the retro adopts it as a working agreement, and dismisses another
  s = {
    ...s,
    lessons: [
      {
        id: "L1",
        at: T0,
        text: "spec never named the DB",
        scope: "spec",
        status: "raised",
        from: "developer",
        item: "A",
      },
      {
        id: "L2",
        at: T0,
        text: "flaky network in CI",
        scope: "review",
        status: "raised",
        from: "developer",
        item: "A",
      },
    ],
  };
  const r = c["retro"]!(s, {
    by: "scrum-master",
    now: T1,
    lessons: [
      { text: "estimate smaller", scope: "memory" },
      {
        text: "reviews must cover error paths",
        scope: "review",
        suggestedChange: {
          kind: "dod",
          policy: { kind: "custom", id: "error-paths", description: "error paths reviewed" },
        },
      },
    ],
    adopt: [
      {
        id: "L1",
        suggestedChange: { kind: "agreement", text: "name the DB in every acceptance criterion" },
      },
    ],
    dismiss: ["L2"],
    dodChanges: [{ kind: "evidence", evidenceKind: "test-output" }, { kind: "no-open-blockers" }],
  });
  assert.equal(r.state.lessons.length, 4);
  assert.equal(r.state.lessons.find((l) => l.id === "L1")!.status, "adopted");
  assert.equal(r.state.lessons.find((l) => l.id === "L2")!.status, "dismissed");
  assert.deepEqual(r.state.agreements, ["name the DB in every acceptance criterion"]);
  assert.equal((r.state.config as { definitionOfDone: unknown[] }).definitionOfDone.length, 2); // dodChanges replaced wholesale after the adopted dod policy
  assert.equal(r.state.stages.find((x) => x.id === "review")!.exitPolicy.length, 2);
  const payload = r.state.events.at(-1)!.payload as {
    adopted: string[];
    dismissed: string[];
    agreements: string[];
  };
  assert.deepEqual(payload.adopted, ["L3", "L4", "L1"]);
  assert.deepEqual(payload.dismissed, ["L2"]);
  assert.throws(
    () => c["retro"]!(s, { by: "scrum-master", now: T1, lessons: [], adopt: [{ id: "L9" }] }),
    (e) => code(e) === "invalid-input",
  );
  assert.throws(
    () => c["retro"]!(r.state, { by: "scrum-master", now: T1, lessons: [] }),
    (e) => code(e) === "invalid-input",
  ); // already retro'd
  assert.throws(
    () => c["cancel"]!(r.state, { by: "product-owner", now: T1, reason: "x" }),
    (e) => code(e) === "invalid-input",
  ); // nothing open
  assert.throws(
    () => c["cancel"]!(s, { by: "scrum-master", now: T1, reason: "x" }),
    (e) => code(e) === "missing-capability",
  );
});

test("commit and uncommit move items in and out of the open sprint", () => {
  let s = c["plan"]!(backlog(), { by: "scrum-master", now: T0, goal: "g", items: ["A"] }).state;
  s = c["commit"]!(s, { by: "product-owner", now: T1, items: ["B"], goalImpact: "none" }).state;
  assert.deepEqual(s.iterations[0]!.committed, ["A", "B"]);
  assert.equal(getItem(s, "B").stage, "sprint");
  s = c["uncommit"]!(s, { by: "product-owner", now: T1, items: ["B"], reason: "too big" }).state;
  assert.deepEqual(s.iterations[0]!.committed, ["A"]);
  assert.equal(getItem(s, "B").stage, "backlog");
  assert.equal(getItem(s, "B").iteration, undefined);
  assert.equal(getItem(s, "B").role, undefined);
  assert.throws(
    () => c["uncommit"]!(s, { by: "developer", now: T1, items: ["A"], reason: "x" }),
    (e) => code(e) === "missing-capability",
  );
});

test("commit rejects items already in the sprint or not in the backlog; uncommit rejects done items", () => {
  const s = c["plan"]!(backlog(), { by: "scrum-master", now: T0, goal: "g", items: ["A"] }).state;
  assert.throws(
    () => c["commit"]!(s, { by: "product-owner", now: T1, items: ["A"], goalImpact: "none" }),
    (e) => code(e) === "invalid-input",
  );
  const busy = {
    ...s,
    items: { ...s.items, B: { ...s.items["B"]!, status: "in_progress" as const } },
  };
  assert.throws(
    () => c["commit"]!(busy, { by: "product-owner", now: T1, items: ["B"], goalImpact: "none" }),
    (e) => code(e) === "invalid-input",
  );
  assert.throws(
    () => c["commit"]!(s, { by: "product-owner", now: T1, items: ["B", "B"], goalImpact: "none" }),
    (e) => code(e) === "invalid-input",
  );
  const fin = { ...s, items: { ...s.items, A: { ...s.items["A"]!, status: "done" as const } } };
  assert.throws(
    () => c["uncommit"]!(fin, { by: "product-owner", now: T1, items: ["A"], reason: "x" }),
    (e) => code(e) === "invalid-input",
  );
});

test("an escalation across a sprint boundary does not deadlock the parent", () => {
  const opts = { now: T0, fallbackTokensPerWeight: 10 };
  let s = c["plan"]!(backlog(), { by: "scrum-master", now: T0, goal: "g", items: ["A"] }).state;
  s = next(s, m, opts).state;
  s = complete(
    s,
    m,
    h("A", "developer", { verdict: "escalate", open_questions: ["which DB?"] }),
    a("A", 20),
    T0,
  ).state;
  assert.equal(getItem(s, "A-q1").iteration, "S1");
  s = c["review"]!(s, { by: "human", now: T1, accepted: false, goalMet: false }).state;
  const closed = s.events.at(-1)!.payload as { carryover: string[]; carriedQuestions: string[] };
  assert.deepEqual(closed.carryover, ["A"]);
  assert.deepEqual(closed.carriedQuestions, ["A-q1"]);
  assert.equal(getItem(s, "A-q1").stage, "backlog");
  assert.equal(getItem(s, "A-q1").iteration, undefined);
  s = c["retro"]!(s, { by: "scrum-master", now: T1, lessons: [] }).state;
  s = c["refine"]!(s, {
    by: "developer",
    now: T1,
    items: [{ id: "A", patch: { weight: 2 } }],
  }).state;
  s = c["plan"]!(s, { by: "scrum-master", now: T1, goal: "g2", items: ["A"] }).state;
  assert.equal(getItem(s, "A-q1").stage, "sprint");
  assert.equal(getItem(s, "A-q1").iteration, "S2");
  assert.deepEqual(s.iterations[1]!.committed, ["A"]);
  s = next(s, m, opts).state;
  assert.equal(getItem(s, "A-q1").status, "in_progress");
  assert.equal(getItem(s, "A").status, "todo");
  s = complete(
    s,
    m,
    h("A-q1", "product-owner", { produced: [], notes: "use sqlite" }),
    a("A-q1", 10, "product-owner"),
    T1,
  ).state;
  s = next(s, m, opts).state;
  assert.equal(getItem(s, "A").status, "in_progress");
});

test("commit brings the open questions of the committed items along", () => {
  const opts = { now: T0, fallbackTokensPerWeight: 10 };
  let s = c["plan"]!(backlog(), { by: "scrum-master", now: T0, goal: "g", items: ["A"] }).state;
  s = c["commit"]!(s, { by: "product-owner", now: T0, items: ["B"], goalImpact: "none" }).state;
  s = next(s, m, opts).state;
  s = complete(
    s,
    m,
    h("B", "developer", { verdict: "escalate", open_questions: ["why?"] }),
    a("B", 20),
    T0,
  ).state;
  s = c["uncommit"]!(s, { by: "product-owner", now: T0, items: ["B"], reason: "x" }).state;
  s = { ...s, items: { ...s.items, "B-q1": { ...s.items["B-q1"]!, stage: "backlog" } } };
  s = c["commit"]!(s, { by: "product-owner", now: T1, items: ["B"], goalImpact: "none" }).state;
  assert.equal(getItem(s, "B-q1").stage, "sprint");
  assert.equal(getItem(s, "B-q1").iteration, "S1");
  assert.deepEqual(s.iterations[0]!.committed, ["A", "B"]);
});

test("scrum-shaped rework: the reviewer's rework lands in the sprint and the developer stays the author", () => {
  const opts = { now: T0, fallbackTokensPerWeight: 10 };
  let s = c["plan"]!(backlog(), { by: "scrum-master", now: T0, goal: "g", items: ["A"] }).state;
  s = next(s, m, opts).state;
  s = complete(s, m, h("A"), a("A", 20), T0).state;
  assert.equal(getItem(s, "A").stage, "review");
  assert.equal(getItem(s, "A").status, "review");
  s = next(s, m, opts).state;
  assert.equal(getItem(s, "A").role, "developer"); // the only reviewer
  assert.equal(authorOf(s, getItem(s, "A")), "developer");
  s = complete(
    s,
    m,
    h("A", "developer", { verdict: "rework", notes: "add tests", produced: [] }),
    a("A", 20),
    T0,
  ).state;
  const item = getItem(s, "A");
  assert.equal(item.stage, "sprint");
  assert.equal(item.status, "todo");
  assert.equal(item.role, undefined);
  assert.equal(item.iteration, "S1");
});

test("retro rejects a lesson referenced twice and flags a DoD change", () => {
  let s = c["plan"]!(backlog(), { by: "scrum-master", now: T0, goal: "g", items: ["A"] }).state;
  s = c["cancel"]!(s, { by: "product-owner", now: T1, reason: "x" }).state;
  s = {
    ...s,
    lessons: [
      {
        id: "L1",
        at: T0,
        text: "t",
        scope: "spec",
        status: "raised",
        from: "developer",
        item: "A",
      },
    ],
  };
  assert.throws(
    () =>
      c["retro"]!(s, {
        by: "scrum-master",
        now: T1,
        lessons: [],
        adopt: [{ id: "L1" }],
        dismiss: ["L1"],
      }),
    (e) => code(e) === "invalid-input",
  );
  assert.throws(
    () =>
      c["retro"]!(s, {
        by: "scrum-master",
        now: T1,
        lessons: [],
        adopt: [{ id: "L1" }, { id: "L1" }],
      }),
    (e) => code(e) === "invalid-input",
  );
  const plain = c["retro"]!(s, { by: "scrum-master", now: T1, lessons: [], adopt: [{ id: "L1" }] });
  assert.equal((plain.state.events.at(-1)!.payload as { dodChanged: boolean }).dodChanged, false);
  const changed = c["retro"]!(s, {
    by: "scrum-master",
    now: T1,
    lessons: [],
    dodChanges: [{ kind: "no-open-blockers" }],
    allowWeaken: true,
  });
  assert.equal((changed.state.events.at(-1)!.payload as { dodChanged: boolean }).dodChanged, true);
  assert.deepEqual(changed.state.stages.find((x) => x.id === "review")!.exitPolicy, [
    { kind: "no-open-blockers" },
  ]);
});

test("#10 an item carried over from the review stage re-enters at review on the next plan, without a re-estimate", () => {
  let s = c["plan"]!(backlog(), { by: "scrum-master", now: T0, goal: "g", items: ["A"] }).state;
  s = next(s, m, { now: T0, fallbackTokensPerWeight: 10 }).state;
  s = complete(s, m, h("A"), a("A", 50), T0).state; // A in review/review
  s = c["review"]!(s, { by: "human", now: T1, accepted: false, goalMet: false }).state;
  assert.deepEqual(s.iterations[0]!.carryover, ["A"]);
  s = c["retro"]!(s, { by: "scrum-master", now: T1, lessons: [] }).state;
  const r = c["plan"]!(s, { by: "scrum-master", now: T1, goal: "g2", items: ["A"] });
  assert.equal(r.state.items["A"]!.stage, "review");
  assert.equal(r.state.items["A"]!.status, "review");
  assert.deepEqual((r.state.events.at(-1)!.payload as { resumed: string[] }).resumed, ["A"]);
  const n = next(r.state, m, { now: T1, fallbackTokensPerWeight: 10 });
  assert.equal(n.briefs[0]!.item.id, "A");
  assert.equal(n.briefs[0]!.item.stage, "review");
  assert.equal(n.briefs[0]!.priorHandoffs.length, 1);
});

test("#10 commit resumes a carried-over review item at review and reports it as resumed", () => {
  let s = c["plan"]!(backlog(), { by: "scrum-master", now: T0, goal: "g", items: ["A"] }).state;
  s = next(s, m, { now: T0, fallbackTokensPerWeight: 10 }).state;
  s = complete(s, m, h("A"), a("A", 50), T0).state;
  s = c["review"]!(s, { by: "human", now: T1, accepted: false, goalMet: false }).state;
  s = c["retro"]!(s, { by: "scrum-master", now: T1, lessons: [] }).state;
  s = c["plan"]!(s, { by: "scrum-master", now: T1, goal: "g2", items: ["B"] }).state;
  const r = c["commit"]!(s, { by: "product-owner", now: T1, items: ["A"], goalImpact: "none" });
  assert.equal(r.state.items["A"]!.stage, "review");
  assert.equal(r.state.items["A"]!.status, "review");
  assert.deepEqual((r.state.events.at(-1)!.payload as { resumed: string[] }).resumed, ["A"]);
});

function carried(stage: string, status: "blocked" | "awaiting_human"): WorkflowState {
  let s = c["plan"]!(backlog(), { by: "scrum-master", now: T0, goal: "g", items: ["A"] }).state;
  s = next(s, m, { now: T0, fallbackTokensPerWeight: 10 }).state;
  if (stage === "review") s = complete(s, m, h("A"), a("A", 50), T0).state;
  s = moveItem(s, "A", { status }, "system", T0);
  s = c["review"]!(s, { by: "human", now: T1, accepted: false, goalMet: false }).state;
  return c["retro"]!(s, { by: "scrum-master", now: T1, lessons: [] }).state;
}

for (const status of ["blocked", "awaiting_human"] as const) {
  test(`B22 a ${status} carryover left in the review stage resumes at review on plan and on commit`, () => {
    const s = carried("review", status);
    assert.equal(getItem(s, "A").status, "todo");
    const p = c["plan"]!(s, { by: "scrum-master", now: T1, goal: "g2", items: ["A"] });
    assert.equal(p.state.items["A"]!.stage, "review");
    assert.equal(p.state.items["A"]!.status, "review");
    assert.deepEqual((p.state.events.at(-1)!.payload as { resumed: string[] }).resumed, ["A"]);
    let s2 = c["plan"]!(s, { by: "scrum-master", now: T1, goal: "g2", items: ["B"] }).state;
    s2 = c["commit"]!(s2, { by: "product-owner", now: T1, items: ["A"], goalImpact: "none" }).state;
    assert.equal(s2.items["A"]!.stage, "review");
    assert.equal(s2.items["A"]!.status, "review");
    assert.deepEqual((s2.events.at(-1)!.payload as { resumed: string[] }).resumed, ["A"]);
  });
}

test("B22 a blocked carryover left in the sprint stage still restarts at the sprint start", () => {
  let s = carried("sprint", "blocked");
  s = c["refine"]!(s, { by: "product-owner", now: T1, reestimate: ["A"] }).state;
  const p = c["plan"]!(s, { by: "scrum-master", now: T1, goal: "g2", items: ["A"] });
  assert.equal(p.state.items["A"]!.stage, "sprint");
  assert.equal(p.state.items["A"]!.status, "todo");
  assert.deepEqual((p.state.events.at(-1)!.payload as { resumed: string[] }).resumed, []);
});

function qaCarried(): WorkflowState {
  const [backlogStage, sprint, inProgress, review, done] = scrumStages(config as never);
  const stages: Stage[] = [
    backlogStage!,
    sprint!,
    {
      ...inProgress!,
      gate: { id: "h", requires: ["human"], evidence: [], onFail: { action: "block" as const } },
    },
    { id: "qa", name: "QA", entryPolicy: [], exitPolicy: [] },
    review!,
    done!,
  ];
  let { state } = init({ methodology: m, config, stages, now: T0 });
  state = addItem(
    state,
    { id: "A", title: "a", weight: 1, priority: 3, acceptance: ["ok"] },
    "product-owner",
    T0,
  );
  let s = c["plan"]!(state, { by: "scrum-master", now: T0, goal: "g", items: ["A"] }).state;
  s = next(s, m, { now: T0, fallbackTokensPerWeight: 10 }).state;
  s = complete(s, m, h("A", "developer", { verdict: "needs-review" }), a("A", 50), T0).state;
  s = decide(s, s.pending[0]!.id, "approve", "human", "", T0);
  assert.equal(getItem(s, "A").stage, "qa");
  assert.equal(getItem(s, "A").status, "review");
  s = c["review"]!(s, { by: "human", now: T1, accepted: false, goalMet: false }).state;
  return c["retro"]!(s, { by: "scrum-master", now: T1, lessons: [] }).state;
}

test("B22 a review-status carryover left in a non-review stage resumes there without a reestimate", () => {
  const s = qaCarried();
  const p = c["plan"]!(s, { by: "scrum-master", now: T1, goal: "g2", items: ["A"] });
  assert.equal(p.state.items["A"]!.stage, "qa");
  assert.equal(p.state.items["A"]!.status, "review");
  assert.deepEqual((p.state.events.at(-1)!.payload as { resumed: string[] }).resumed, ["A"]);
});

test("B22 resumeStageOf without state recognises only a review status", () => {
  const s = qaCarried();
  assert.equal(resumeStageOf(getItem(s, "A")), "qa");
  const t = getItem(s, "A").transitions.at(-1)!;
  const other = {
    ...getItem(s, "A"),
    transitions: [{ ...t, from: { ...t.from, status: "blocked" as const } }],
  };
  assert.equal(resumeStageOf(other), undefined);
});

test("B22 a blocked-in-review item uncommitted by a human restarts at the sprint start", () => {
  let s = c["plan"]!(backlog(), { by: "scrum-master", now: T0, goal: "g", items: ["B"] }).state;
  s = next(s, m, { now: T0, fallbackTokensPerWeight: 10 }).state;
  s = complete(s, m, h("B"), a("B", 50), T0).state;
  s = moveItem(s, "B", { status: "blocked" }, "system", T0);
  s = c["uncommit"]!(s, { by: "product-owner", now: T0, items: ["B"], reason: "x" }).state;
  s = c["review"]!(s, { by: "human", now: T1, accepted: false, goalMet: false }).state;
  s = c["retro"]!(s, { by: "scrum-master", now: T1, lessons: [] }).state;
  s = c["plan"]!(s, { by: "scrum-master", now: T1, goal: "g2", items: ["A"] }).state;
  s = c["commit"]!(s, { by: "product-owner", now: T1, items: ["B"], goalImpact: "none" }).state;
  assert.equal(s.items["B"]!.stage, "sprint");
  assert.equal(s.items["B"]!.status, "todo");
  assert.deepEqual((s.events.at(-1)!.payload as { resumed: string[] }).resumed, []);
});

test("#11 refine reestimate confirms a weight and satisfies carryover-reestimated", () => {
  let s = c["plan"]!(backlog(), { by: "scrum-master", now: T0, goal: "g", items: ["B"] }).state;
  s = c["cancel"]!(s, { by: "product-owner", now: T1, reason: "x" }).state;
  s = c["retro"]!(s, { by: "scrum-master", now: T1, lessons: [] }).state;
  assert.equal(
    codeOf(() =>
      c["refine"]!(s, {
        by: "product-owner",
        now: T1,
        items: [{ id: "B", patch: { weight: 2 } }],
      }),
    ),
    "no-op",
  );
  const r = c["refine"]!(s, { by: "product-owner", now: T1, reestimate: ["B"] });
  assert.equal(r.state.events.at(-2)!.type, "item.reestimated");
  assert.deepEqual(r.state.events.at(-2)!.payload, { id: "B", weight: 2 });
  assert.doesNotThrow(() =>
    c["plan"]!(r.state, { by: "scrum-master", now: T1, goal: "g2", items: ["B"] }),
  );
  assert.equal(
    codeOf(() => c["refine"]!(s, { by: "product-owner", now: T1, reestimate: ["Z"] })),
    "unknown-item",
  );
  const noWeight = addItem(s, { id: "N", title: "n", acceptance: ["ok"] }, "product-owner", T1);
  assert.equal(
    codeOf(() => c["refine"]!(noWeight, { by: "product-owner", now: T1, reestimate: ["N"] })),
    "invalid-input",
  );
  for (const bad of ["B", 7, { id: "B" }, [1]])
    assert.equal(
      codeOf(() => c["refine"]!(s, { by: "product-owner", now: T1, reestimate: bad })),
      "invalid-input",
      `reestimate ${JSON.stringify(bad)} is refused`,
    );
});

test("#18 plan auto skips incomplete and oversized candidates and reports them", () => {
  let { state: s } = init({
    methodology: m,
    config: { ...config, sprintBudget: { tokens: 30000 }, fallbackTokensPerWeight: 20000 },
    now: T0,
  });
  s = addItem(s, { id: "P1", title: "p1", weight: 1, priority: 3 }, "product-owner", T0);
  s = addItem(
    s,
    { id: "P2", title: "p2", weight: 1, priority: 2, acceptance: ["ok"] },
    "product-owner",
    T0,
  );
  s = addItem(
    s,
    { id: "P3", title: "p3", weight: 50, priority: 1, acceptance: ["ok"] },
    "product-owner",
    T0,
  );
  const r = c["plan"]!(s, { by: "scrum-master", now: T0, goal: "g", items: "auto" });
  const p = r.state.events.at(-1)!.payload as {
    committed: string[];
    skipped: Array<{ id: string; reason: string }>;
  };
  assert.deepEqual(p.committed, ["P2"]);
  assert.deepEqual(
    p.skipped.map((x) => [x.id, x.reason]),
    [
      ["P1", "policy"],
      ["P3", "budget"],
    ],
  );
  assert.equal(
    codeOf(() => c["plan"]!(s, { by: "scrum-master", now: T0, goal: "g", items: ["P1"] })),
    "policy-unmet",
  );
});

test("#20 retro dodChanges that drops a Definition of Done policy is a rule violation", () => {
  let s = c["plan"]!(backlog(), { by: "scrum-master", now: T0, goal: "g", items: ["A"] }).state;
  s = c["cancel"]!(s, { by: "product-owner", now: T1, reason: "x" }).state;
  assert.throws(
    () =>
      c["retro"]!(s, {
        by: "scrum-master",
        now: T1,
        lessons: [],
        dodChanges: [{ kind: "acceptance-written" }],
      }),
    (e) =>
      e instanceof WorkflowError && e.code === "rule-violation" && e.rule === "dod-not-weakened",
  );
});

test("#12 #13 retro replaces and retires agreements, and attributes lessons to the raising role", () => {
  let s = c["plan"]!(backlog(), { by: "scrum-master", now: T0, goal: "g", items: ["A"] }).state;
  s = c["cancel"]!(s, { by: "product-owner", now: T0, reason: "x" }).state;
  s = c["retro"]!(s, {
    by: "scrum-master",
    now: T0,
    lessons: [
      {
        text: "reviews drift",
        scope: "policy",
        suggestedChange: { kind: "agreement", text: "review in a fresh worker" },
      },
    ],
  }).state;
  s = c["plan"]!(s, { by: "scrum-master", now: T0, goal: "g2", items: ["B"] }).state;
  s = c["cancel"]!(s, { by: "product-owner", now: T1, reason: "x" }).state;
  const T3 = "2026-10-19T03:00:00.000Z";
  const r = c["retro"]!(s, {
    by: "scrum-master",
    now: T3,
    lessons: [
      {
        text: "reviews need the file list",
        scope: "review",
        from: "developer",
        item: "A",
        suggestedChange: {
          kind: "agreement",
          text: "review in a fresh worker with the file list",
          replaces: "review in a fresh worker",
        },
      },
      {
        text: "ok",
        scope: "memory",
        suggestedChange: { kind: "agreement", text: "temporary" },
      },
    ],
    retire: ["temporary"],
  });
  assert.deepEqual(r.state.agreements, ["review in a fresh worker with the file list"]);
  const retired = r.state.events
    .filter((e) => e.type === "agreement.retired")
    .map((e) => e.payload);
  assert.deepEqual(retired, [
    { text: "review in a fresh worker", replacedBy: "review in a fresh worker with the file list" },
    { text: "temporary", replacedBy: null },
  ]);
  const l = r.state.lessons.find((x) => x.text === "reviews need the file list")!;
  assert.equal(l.from, "developer");
  assert.equal(l.item, "A");
  assert.equal(r.state.lessons.find((x) => x.text === "ok")!.from, "scrum-master");
  assert.equal(r.state.lessons.find((x) => x.text === "ok")!.item, undefined);
  assert.deepEqual((r.state.events.at(-1)!.payload as { retired: string[] }).retired, [
    "temporary",
  ]);
  const base = { by: "scrum-master", now: T3 };
  assert.equal(
    codeOf(() =>
      c["retro"]!(s, { ...base, lessons: [{ text: "x", scope: "policy", from: "nobody" }] }),
    ),
    "invalid-input",
  );
  assert.equal(
    codeOf(() =>
      c["retro"]!(s, { ...base, lessons: [{ text: "x", scope: "policy", item: "ZZ" }] }),
    ),
    "unknown-item",
  );
  assert.equal(
    codeOf(() => c["retro"]!(s, { ...base, retire: ["never agreed"] })),
    "invalid-input",
  );
  assert.equal(
    codeOf(() => c["retro"]!(s, { ...base, retire: "temporary" })),
    "invalid-input",
  );
  assert.equal(
    codeOf(() =>
      c["retro"]!(s, { ...base, retire: ["review in a fresh worker", "review in a fresh worker"] }),
    ),
    "invalid-input",
  );
  assert.equal(
    codeOf(() => c["retro"]!(s, { ...base, lessons: [{ text: "x", scope: "policy", from: 3 }] })),
    "invalid-input",
  );
});

test("plan auto applies tokens and turns together (B20)", () => {
  const s = {
    ...backlog(),
    config: { ...config, sprintBudget: { tokens: 100000, turns: 1 } },
  };
  const r = c["plan"]!(s, { by: "scrum-master", now: T0, goal: "g", items: "auto" });
  assert.equal(r.state.iterations[0]!.committed.length, 1);
  const skipped = (
    r.state.events.find((e) => e.type === "sprint.opened")!.payload as {
      skipped: Array<{ reason: string; detail: string }>;
    }
  ).skipped;
  assert.equal(skipped.length, 2);
  assert.ok(skipped.every((x) => x.reason === "budget" && x.detail === "turns budget full"));
});
