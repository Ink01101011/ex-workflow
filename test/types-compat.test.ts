// Type-level compatibility proof for the generic methodology name (design spec section 26,
// "Methodology names"). `pnpm typecheck` compiles this file: the assertions below fail the
// build, not only the test run, when a public type changes shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addItem,
  appendEvent,
  applyAction,
  complete,
  init,
  next,
  type ApplyResult,
  type Ceremony,
  type Methodology,
  type MethodologyName,
  type Role,
  type Rule,
  type Stage,
  type WorkflowState,
} from "../src/index.ts";
import { scrum } from "../src/methodologies/scrum/index.ts";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expectType = <T extends true>(value: T): T => value;

// 1. The default instantiations are exactly the 1.1 types.
expectType<Equal<WorkflowState["methodology"], MethodologyName>>(true);
expectType<Equal<WorkflowState, WorkflowState<MethodologyName>>>(true);
expectType<Equal<Methodology["name"], MethodologyName>>(true);
expectType<Equal<Methodology<{ a: 1 }>, Methodology<{ a: 1 }, MethodologyName>>>(true);
expectType<Equal<ApplyResult["state"], WorkflowState>>(true);
expectType<Equal<Parameters<Ceremony>[0], WorkflowState>>(true);
expectType<Equal<Parameters<Rule["check"]>[0], WorkflowState>>(true);
expectType<
  Equal<MethodologyName, "scrum" | "kanban" | "waterfall" | "investigation" | "experimentation">
>(true);
// a built-in factory keeps its 1.1 type and its state keeps the built-in name
expectType<Equal<ReturnType<typeof scrum>["name"], MethodologyName>>(true);

// 2. An exhaustive switch over the five names with a never default still compiles.
function label(state: WorkflowState): string {
  switch (state.methodology) {
    case "scrum":
      return "S";
    case "kanban":
      return "K";
    case "waterfall":
      return "W";
    case "investigation":
      return "I";
    case "experimentation":
      return "E";
    default: {
      const unreachable: never = state.methodology;
      return unreachable;
    }
  }
}

// 3. A custom methodology is typed through the generic name parameter.
interface TriageConfig {
  queue: string;
}
const STAGES: Stage[] = [
  { id: "inbox", name: "Inbox", entryPolicy: [], exitPolicy: [] },
  { id: "done", name: "Done", entryPolicy: [], exitPolicy: [], deliveryPoint: true },
];
const ROLES: Role[] = [
  {
    id: "lead",
    name: "Lead",
    modelTier: "small",
    capabilities: ["order-backlog", "define-acceptance", "deliver", "review"],
    canApprove: [],
    inputs: [],
    outputs: [],
    do_not: [],
  },
];
const file: Ceremony<"triage"> = (state, input) =>
  applyAction(state, triage(), { type: "ceremony.file", by: input.by }, (s) =>
    appendEvent(
      addItem(
        s,
        { id: String(input["id"]), title: "filed", acceptance: ["triaged"] },
        input.by,
        input.now,
      ),
      "triage.filed",
      input.by,
      { id: input["id"] },
      input.now,
    ),
  );
function triage(): Methodology<TriageConfig, "triage"> {
  return {
    name: "triage",
    vocabulary: {
      backlog: "Inbox",
      item: "Ticket",
      stage: "Lane",
      iteration: "Shift",
      increment: "Resolved",
      ceremony: "Ritual",
      gate: "Check",
    },
    validateConfig: (c) => c as TriageConfig,
    defaultStages: () => STAGES,
    defaultRoles: () => ROLES,
    requiredCapabilities: ["deliver"],
    exclusiveCapabilities: [],
    plannerOptions: () => ({ schedulerMode: "level", dispatchStage: "inbox" }),
    candidates: (s) => Object.values(s.items).filter((i) => i.status === "todo"),
    invariants: (s) => [`Queue: ${(s.config as TriageConfig).queue}`],
    ceremonies: { file },
    rules: [],
    metrics: (s) => ({ tickets: Object.keys(s.items).length }),
    humanDefaults: { gates: "none" },
  };
}

test("generic name: the default instantiation keeps the exhaustive built-in switch", () => {
  const s = init({
    methodology: scrum(),
    config: { sprintBudget: { tokens: 1000 }, productGoal: "ship", definitionOfDone: [] },
    now: "2026-11-03T00:00:00.000Z",
  }).state;
  expectType<Equal<typeof s, WorkflowState>>(true);
  assert.equal(label(s), "S");
});

test("generic name: a custom Methodology<Cfg, 'triage'> initialises and runs next/complete", () => {
  const now = "2026-11-03T00:00:00.000Z";
  const m = triage();
  let state: WorkflowState<"triage"> = init({
    methodology: m,
    config: { queue: "support" },
    now,
  }).state;
  expectType<Equal<typeof state.methodology, "triage">>(true);
  assert.equal(state.methodology, "triage");
  state = m.ceremonies["file"]!(state, { by: "lead", id: "t1", now }).state;
  const n = next(state, m, { now });
  expectType<Equal<(typeof n)["state"]["methodology"], "triage">>(true);
  assert.equal(n.briefs.length, 1);
  assert.equal(n.briefs[0]!.item.id, "t1");
  const done = complete(
    n.state,
    m,
    {
      item: "t1",
      role: n.briefs[0]!.role.id,
      produced: [{ kind: "note", ref: "r1" }],
      notes: "triaged",
      do_not: [],
      open_questions: [],
    },
    {
      item: "t1",
      role: n.briefs[0]!.role.id,
      model: "m",
      tokensIn: 1,
      tokensOut: 1,
      durationMs: 1,
      startedAt: now,
      endedAt: now,
    },
    now,
  );
  expectType<Equal<(typeof done)["state"]["methodology"], "triage">>(true);
  assert.equal(done.state.methodology, "triage");
  assert.equal(done.state.items["t1"]!.stage, "done");
  assert.deepEqual(m.metrics(done.state), { tickets: 1 });
});
