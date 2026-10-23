import { test } from "node:test";
import assert from "node:assert/strict";
import { createState } from "./state.ts";
import { addItem, clearBlocker, getItem } from "./items.ts";
import { next, synthesizeBrief } from "./brief.ts";
import { complete } from "./complete.ts";
import { authorOf, decide } from "./gates.ts";
import { WorkflowError } from "./errors.ts";
import type { Accounting, Handoff, Methodology, Role, Stage, WorkflowState } from "./types.ts";

const T0 = "2026-10-19T00:00:00.000Z";
const synthesizeBriefFor = (s: WorkflowState, id: string) => synthesizeBrief(s, m(), s.items[id]!);
const stages: Stage[] = [
  {
    id: "todo",
    name: "To do",
    entryPolicy: [],
    exitPolicy: [{ kind: "evidence", evidenceKind: "code" }],
  },
  {
    id: "review",
    name: "Review",
    entryPolicy: [],
    exitPolicy: [],
    review: true,
    gate: {
      id: "qa",
      requires: ["human"],
      evidence: [],
      onFail: { action: "return-to", stage: "todo" },
    },
  },
  { id: "done", name: "Done", entryPolicy: [], exitPolicy: [] },
];
const r = (id: string, caps: Role["capabilities"]): Role => ({
  id,
  name: id,
  modelTier: "small",
  capabilities: caps,
  canApprove: [],
  inputs: [],
  outputs: [],
  do_not: [],
});
const roles = [r("dev", ["deliver"]), r("qa", ["review"]), r("lead", ["escalate"])];
const m = (): Methodology => ({
  name: "kanban",
  vocabulary: {} as Methodology["vocabulary"],
  validateConfig: (c) => c,
  defaultStages: () => stages,
  defaultRoles: () => roles,
  requiredCapabilities: ["deliver"],
  exclusiveCapabilities: [],
  plannerOptions: () => ({ schedulerMode: "throughput" }),
  candidates: (s) =>
    Object.values(s.items).filter((i) => i.status === "todo" || i.status === "review"),
  invariants: () => [],
  ceremonies: {},
  rules: [],
  metrics: () => ({}),
  humanDefaults: { gates: "none" },
});
const handoff = (over: Partial<Handoff> = {}): Handoff => ({
  item: "A",
  role: "dev",
  produced: [{ kind: "code", ref: "src/a.ts" }],
  notes: "done",
  do_not: [],
  open_questions: [],
  ...over,
});
const acc = (over: Partial<Accounting> = {}): Accounting => ({
  item: "A",
  role: "dev",
  model: "haiku",
  tokensIn: 100,
  tokensOut: 50,
  durationMs: 1000,
  startedAt: T0,
  endedAt: T0,
  ...over,
});
const code = (e: unknown) => (e instanceof WorkflowError ? e.code : String(e));

function started() {
  let s = createState({
    methodology: "kanban",
    config: {},
    stages,
    roles,
    now: T0,
  });
  s = addItem(s, { id: "A", title: "a", weight: 1 }, "po", T0);
  s = {
    ...s,
    iterations: [
      {
        id: "S1",
        goal: "g",
        budget: { tokens: 100000 },
        spent: { tokens: 0, turns: 0, wallclockMs: 0 },
        startedAt: T0,
        committed: ["A"],
        carryover: [],
      },
    ],
  };
  return next(s, m(), { now: T0 }).state;
}

test("complete validates item status, handoff and accounting", () => {
  const s = started();
  assert.throws(
    () => complete(s, m(), handoff({ item: "Z" }), acc(), T0),
    (e) => code(e) === "unknown-item",
  );
  assert.throws(
    () => complete(s, m(), handoff({ role: "qa" }), acc(), T0),
    (e) => code(e) === "handoff-invalid",
  );
  assert.throws(
    () => complete(s, m(), { ...handoff(), do_not: undefined as unknown as string[] }, acc(), T0),
    (e) => code(e) === "handoff-invalid",
  );
  assert.throws(
    () => complete(s, m(), handoff(), acc({ model: "" }), T0),
    (e) => code(e) === "accounting-invalid",
  );
  assert.throws(
    () => complete(s, m(), handoff(), acc({ tokensIn: -1 }), T0),
    (e) => code(e) === "accounting-invalid",
  );
  const fresh = createState({
    methodology: "kanban",
    config: {},
    stages,
    roles,
    now: T0,
  });
  const notStarted = addItem(fresh, { id: "A", title: "a" }, "po", T0);
  assert.throws(
    () => complete(notStarted, m(), handoff(), acc(), T0),
    (e) => code(e) === "invalid-transition",
  );
});

test("complete done: records accounting, evidence, spent, advances to review", () => {
  const { state: s } = complete(started(), m(), handoff(), acc(), T0);
  const a = getItem(s, "A");
  assert.equal(a.stage, "review");
  assert.equal(a.status, "review");
  assert.equal(a.role, undefined); // new stage = new assignment
  assert.deepEqual(
    a.evidence.map((e) => e.kind),
    ["code"],
  );
  assert.equal(s.accounting.length, 1);
  assert.deepEqual(s.iterations[0]!.spent, {
    tokens: 150,
    turns: 1,
    wallclockMs: 1000,
  });
  const ev = s.events.at(-1)!;
  assert.equal(ev.type, "item.completed");
  assert.equal((ev.payload as { model: string }).model, "haiku");
});

test("complete done fails when exit policy is unmet", () => {
  assert.throws(
    () => complete(started(), m(), handoff({ produced: [] }), acc(), T0),
    (e) => code(e) === "policy-unmet",
  );
});

test("review stage with a human gate goes to awaiting_human; approval finishes the item", () => {
  let s = complete(started(), m(), handoff(), acc(), T0).state;
  s = next(s, m(), { now: T0 }).state; // dispatch review to qa
  assert.equal(getItem(s, "A").role, "qa");
  s = complete(
    s,
    m(),
    handoff({ role: "qa", produced: [], notes: "lgtm" }),
    acc({ role: "qa" }),
    T0,
  ).state;
  assert.equal(getItem(s, "A").status, "awaiting_human");
  assert.equal(s.pending.length, 1);
});

test("verdict blocked raises a blocker; verdict escalate creates a question item", () => {
  const blocked = complete(
    started(),
    m(),
    handoff({ verdict: "blocked", notes: "API down" }),
    acc(),
    T0,
  ).state;
  assert.equal(getItem(blocked, "A").status, "blocked");
  assert.equal(getItem(blocked, "A").blockers[0]!.reason, "API down");
  const esc = complete(
    started(),
    m(),
    handoff({ verdict: "escalate", open_questions: ["which DB?"] }),
    acc(),
    T0,
  ).state;
  const q = getItem(esc, "A-q1");
  assert.equal(q.type, "question");
  assert.equal(q.title, "which DB?");
  assert.equal(q.role, "lead");
  assert.equal(q.parent, "A");
  assert.equal(q.stage, "todo");
  assert.equal(getItem(esc, "A").status, "todo");
  assert.deepEqual(getItem(esc, "A").dependsOn, ["A-q1"]);
  assert.equal(esc.events.filter((e) => e.type === "item.escalated").length, 1);
});

test("verdict rework returns the item to its pulled-from stage with notes required and evidence kept", () => {
  assert.throws(
    () => complete(started(), m(), handoff({ verdict: "rework", notes: "" }), acc(), T0),
    (e) => code(e) === "handoff-invalid",
  );
  const s = complete(
    started(),
    m(),
    handoff({ verdict: "rework", notes: "needs tests" }),
    acc(),
    T0,
  ).state;
  const a = getItem(s, "A");
  assert.equal(a.stage, "todo");
  assert.equal(a.status, "todo");
  assert.deepEqual(
    a.evidence.map((e) => e.kind),
    ["code"],
  );
  assert.equal(s.events.filter((e) => e.type === "item.rework").length, 1);
  const again = next(s, m(), { now: T0 }).state;
  assert.equal(getItem(again, "A").status, "in_progress");
});

test("lessons raised in a handoff are stored as raised, and adopted agreements appear in later briefs", () => {
  const s = complete(
    started(),
    m(),
    handoff({ lessons: [{ text: "spec never said which DB", scope: "spec" }] }),
    acc(),
    T0,
  ).state;
  assert.equal(s.lessons.length, 1);
  assert.deepEqual(s.lessons[0], {
    id: "L1",
    at: T0,
    text: "spec never said which DB",
    scope: "spec",
    status: "raised",
    from: "dev",
    item: "A",
  });
  assert.equal(s.events.filter((e) => e.type === "lesson.raised").length, 1);
  const withAgreement = {
    ...s,
    agreements: ["always name the DB in acceptance criteria"],
  };
  const s2 = addItem(withAgreement, { id: "B", title: "b", role: "dev" }, "po", T0);
  const b = synthesizeBriefFor(s2, "B");
  assert.ok(b.invariants.includes("always name the DB in acceptance criteria"));
});

test("follow_ups are added to the first stage with parent and tag, outside the iteration", () => {
  const s = complete(
    started(),
    m(),
    handoff({
      follow_ups: [{ id: "A-f1", title: "refactor later", weight: 1 }],
    }),
    acc(),
    T0,
  ).state;
  const f = getItem(s, "A-f1");
  assert.equal(f.stage, "todo");
  assert.equal(f.status, "todo");
  assert.equal(f.parent, "A");
  assert.deepEqual(f.tags, ["follow-up"]);
  assert.equal(f.iteration, undefined);
  assert.deepEqual(
    (
      s.events.find((e) => e.type === "item.completed")!.payload as {
        followUps: string[];
      }
    ).followUps,
    ["A-f1"],
  );
});

test("afterComplete hook runs", () => {
  let called = "";
  const mm: Methodology = {
    ...m(),
    afterComplete: (s, id) => {
      called = id;
      return s;
    },
  };
  complete(started(), mm, handoff(), acc(), T0);
  assert.equal(called, "A");
});

test("rework from the review stage returns to the author stage with role cleared and reviewer notes in the brief", () => {
  let s = complete(started(), m(), handoff(), acc(), T0).state;
  s = next(s, m(), { now: T0 }).state;
  s = complete(
    s,
    m(),
    handoff({
      role: "qa",
      produced: [],
      verdict: "rework",
      notes: "missing edge cases",
    }),
    acc({ role: "qa" }),
    T0,
  ).state;
  const a = getItem(s, "A");
  assert.equal(a.stage, "todo");
  assert.equal(a.status, "todo");
  assert.equal(a.role, undefined);
  assert.deepEqual(
    a.evidence.map((e) => e.kind),
    ["code"],
  );
  const again = next(s, m(), { now: T0 }).state;
  const prior = synthesizeBriefFor(again, "A").priorHandoffs;
  assert.equal(prior.at(-1)!.verdict, "rework");
  assert.equal(prior.at(-1)!.notes, "missing edge cases");
});

test("a question item completes straight to the last stage, skipping policies, and unblocks its parent", () => {
  let s = complete(
    started(),
    m(),
    handoff({ verdict: "escalate", open_questions: ["which DB?"] }),
    acc(),
    T0,
  ).state;
  s = next(s, m(), { now: T0 }).state;
  assert.equal(getItem(s, "A-q1").status, "in_progress");
  s = complete(
    s,
    m(),
    handoff({ item: "A-q1", role: "lead", produced: [], notes: "use sqlite" }),
    acc({ item: "A-q1", role: "lead" }),
    T0,
  ).state;
  assert.equal(getItem(s, "A-q1").status, "done");
  assert.equal(getItem(s, "A-q1").stage, "done");
  s = next(s, m(), { now: T0 }).state;
  assert.equal(getItem(s, "A").status, "in_progress");
});

const gateRoles = [
  r("dev", ["deliver"]),
  {
    ...r("qa", ["review", "approve-gate" as Role["capabilities"][number]]),
    canApprove: ["qa"],
  },
];
function gated(evidence: string[], mid = false) {
  const st: Stage[] = [
    { id: "todo", name: "To do", entryPolicy: [], exitPolicy: [] },
    ...(mid ? [{ id: "qa-stage", name: "QA", entryPolicy: [], exitPolicy: [] }] : []),
    {
      id: "review",
      name: "Review",
      entryPolicy: [],
      exitPolicy: [],
      review: true,
      ...(mid
        ? {}
        : {
            gate: {
              id: "qa",
              requires: [{ capability: "approve-gate" }],
              evidence,
              onFail: { action: "block" as const },
            },
          }),
    },
    { id: "done", name: "Done", entryPolicy: [], exitPolicy: [] },
  ];
  let s = createState({
    methodology: "kanban",
    config: {},
    stages: st,
    roles: gateRoles,
    now: T0,
  });
  s = addItem(s, { id: "A", title: "a" }, "po", T0);
  return next(s, m(), { now: T0 }).state;
}

test("gate pass by capability finishes the item and emits gate.passed", () => {
  let s = complete(gated([]), m(), handoff({ produced: [] }), acc(), T0).state;
  s = next(s, m(), { now: T0 }).state;
  s = complete(s, m(), handoff({ role: "qa", produced: [] }), acc({ role: "qa" }), T0).state;
  assert.equal(getItem(s, "A").status, "done");
  assert.ok(s.events.some((e) => e.type === "gate.passed"));
});

test("gate-unmet throws and leaves the caller's state untouched", () => {
  let s = complete(gated(["sign-off"]), m(), handoff({ produced: [] }), acc(), T0).state;
  s = next(s, m(), { now: T0 }).state;
  const before = structuredClone(s);
  assert.throws(
    () => complete(s, m(), handoff({ role: "qa", produced: [] }), acc({ role: "qa" }), T0),
    (e) => code(e) === "gate-unmet",
  );
  assert.deepEqual(s, before);
  assert.equal(getItem(s, "A").stage, "review");
  assert.equal(getItem(s, "A").status, "in_progress");
});

test("needs-review forces review status even when the next stage is not called review", () => {
  const s = complete(
    gated([], true),
    m(),
    handoff({ produced: [], verdict: "needs-review" }),
    acc(),
    T0,
  ).state;
  assert.equal(getItem(s, "A").stage, "qa-stage");
  assert.equal(getItem(s, "A").status, "review");
});

test("two rework cycles: the item stays in the author stage and the author is still dev", () => {
  let s = complete(started(), m(), handoff(), acc(), T0).state;
  s = next(s, m(), { now: T0 }).state;
  s = complete(
    s,
    m(),
    handoff({
      role: "qa",
      produced: [],
      verdict: "rework",
      notes: "round one",
    }),
    acc({ role: "qa" }),
    T0,
  ).state;
  s = next(s, m(), { now: T0 }).state;
  assert.equal(getItem(s, "A").role, "dev");
  assert.equal(authorOf(s, getItem(s, "A")), "dev");
  s = complete(s, m(), handoff({ verdict: "rework", notes: "round two" }), acc(), T0).state;
  assert.equal(getItem(s, "A").stage, "todo");
  assert.equal(getItem(s, "A").status, "todo");
});

function atHumanGate(
  onFail: Stage["gate"] extends infer G ? (G extends { onFail: infer F } ? F : never) : never,
) {
  const st = stages.map((x) => (x.id === "review" ? { ...x, gate: { ...x.gate!, onFail } } : x));
  let s = createState({
    methodology: "kanban",
    config: {},
    stages: st,
    roles,
    now: T0,
  });
  s = addItem(s, { id: "A", title: "a", weight: 1 }, "po", T0);
  s = next(s, m(), { now: T0 }).state;
  s = complete(s, m(), handoff(), acc(), T0).state;
  s = next(s, m(), { now: T0 }).state;
  return complete(s, m(), handoff({ role: "qa", produced: [] }), acc({ role: "qa" }), T0).state;
}

test("a rejected human gate (onFail block) can be cleared and the item is dispatched again", () => {
  let s = atHumanGate({ action: "block" });
  assert.equal(getItem(s, "A").status, "awaiting_human");
  s = decide(s, "p1", "reject", "human", "not yet", T0);
  assert.equal(getItem(s, "A").status, "blocked");
  s = clearBlocker(s, "A", "A-b1", "human", T0);
  const a = getItem(s, "A");
  assert.equal(a.stage, "review");
  assert.equal(a.status, "review");
  assert.equal(a.role, undefined);
  s = next(s, m(), { now: T0 }).state;
  assert.equal(getItem(s, "A").status, "in_progress");
  assert.equal(getItem(s, "A").role, "qa");
});

test("decide return-to clears the role; only human or a qualifying role may decide", () => {
  const s = atHumanGate({ action: "return-to", stage: "todo" });
  assert.throws(
    () => decide(s, "p1", "approve", "qa", "", T0),
    (e) => code(e) === "gate-unmet",
  );
  assert.throws(
    () => decide(s, "p1", "approve", "nobody", "", T0),
    (e) => code(e) === "gate-unmet",
  );
  assert.throws(
    () => decide(s, "p1", "maybe" as unknown as "approve", "human", "", T0),
    (e) => code(e) === "invalid-input",
  );
  const back = decide(s, "p1", "reject", "human", "redo", T0);
  assert.equal(getItem(back, "A").stage, "todo");
  assert.equal(getItem(back, "A").role, undefined);
  const done = decide(s, "p1", "approve", "human", "", T0);
  assert.equal(getItem(done, "A").status, "done");
});

test("complete rejects an unknown verdict and malformed produced, lessons and follow_ups", () => {
  const s = started();
  const bad = (over: object) =>
    assert.throws(
      () => complete(s, m(), handoff(over as Partial<Handoff>), acc(), T0),
      (e) => code(e) === "handoff-invalid",
    );
  bad({ verdict: "approved" });
  bad({ produced: [{ kind: "code" }] });
  bad({ produced: ["code"] });
  bad({ lessons: [{ text: "t", scope: "nope" }] });
  bad({ lessons: [{ scope: "spec" }] });
  bad({ follow_ups: [{ title: "no id" }] });
  bad({ follow_ups: ["F1"] });
  try {
    complete(s, m(), handoff({ verdict: "approved" as unknown as "done" }), acc(), T0);
  } catch (e) {
    assert.match((e as WorkflowError).fix, /needs-review/);
  }
});

test("escalate without an escalate role is missing-capability", () => {
  const noLead = roles.filter((x) => x.id !== "lead");
  let s = createState({
    methodology: "kanban",
    config: {},
    stages,
    roles: noLead,
    now: T0,
  });
  s = addItem(s, { id: "A", title: "a", weight: 1 }, "po", T0);
  s = next(s, m(), { now: T0 }).state;
  assert.throws(
    () => complete(s, m(), handoff({ verdict: "escalate", open_questions: ["?"] }), acc(), T0),
    (e) => code(e) === "missing-capability",
  );
});

test("a completion with 0 tokens is refused unless it is a declared estimate", () => {
  const s = started();
  const zero = acc({ tokensIn: 0, tokensOut: 0 });
  assert.throws(
    () => complete(s, m(), handoff(), zero, T0),
    (e: unknown) =>
      code(e) === "accounting-invalid" &&
      /--estimate|estimate: true/.test((e as WorkflowError).fix),
  );
  const res = complete(s, m(), handoff(), { ...zero, estimate: true }, T0);
  assert.equal(res.state.accounting.at(-1)!.estimate, true);
});
