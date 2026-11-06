// Type-level compatibility proof for the generic methodology name (design spec section 26,
// "Methodology names"). `pnpm typecheck` compiles this file: the assertions below fail the
// build, not only the test run, when a public type changes shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addEvidence,
  addItem,
  approversFor,
  assertPolicies,
  assignRole,
  authorOf,
  canDo,
  checkGate,
  estimateTokens,
  evaluatePolicies,
  getItem,
  isTerminalStage,
  lastDispatchBefore,
  lastEvent,
  nextStageOf,
  openIteration,
  openQuestions,
  requireCap,
  requireCapabilities,
  resourceCapsFor,
  rolesWith,
  separationLost,
  stageOf,
  toExNodes,
  appendEvent,
  applyAction,
  applyAgreement,
  changeConfig,
  clearBlocker,
  complete,
  coreRulesFor,
  correctAccounting,
  createState,
  decide,
  editItem,
  init,
  moveItem,
  next,
  plan,
  raiseBlocker,
  raisePending,
  registerRole,
  retireAgreement,
  retireRole,
  synthesizeBrief,
  validateAction,
  type Accounting,
  type AccountingPatch,
  type Action,
  type ApplyResult,
  type Brief,
  type BriefContext,
  type Ceremony,
  type Evidence,
  type Handoff,
  type InitInput,
  type ItemPatch,
  type ItemStatus,
  type Methodology,
  type MethodologyName,
  type NewItem,
  type NextResult,
  type PendingHuman,
  type PlanOptions,
  type PlanResult,
  type Policy,
  type Role,
  type Rule,
  type Stage,
  type Violation,
  type WorkItem,
  type WorkflowState,
} from "../src/index.ts";
import type { CreateStateInput } from "../src/core/state.ts";
import { scrum, canDo as scrumCanDo } from "../src/methodologies/scrum/index.ts";

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

// 1b. Parameters<typeof fn> / ReturnType<typeof fn> of every now-generic kernel function read the
// 1.1 shape: each keeps the 1.1 signature as its last overload (spec 26, "Generic name mechanics").
type S = WorkflowState;
type M = Methodology;
expectType<Equal<Parameters<typeof createState>, [input: CreateStateInput]>>(true);
expectType<Equal<ReturnType<typeof createState>, S>>(true);
expectType<Equal<Parameters<typeof init>, [input: InitInput<unknown>]>>(true);
expectType<Equal<ReturnType<typeof init>, ApplyResult>>(true);
expectType<
  Equal<
    Parameters<typeof applyAction>,
    [state: S, methodology: M, action: Action, reduce: (s: S) => S]
  >
>(true);
expectType<Equal<ReturnType<typeof applyAction>, ApplyResult>>(true);
expectType<Equal<Parameters<typeof validateAction>, [state: S, methodology: M, action: Action]>>(
  true,
);
expectType<Equal<ReturnType<typeof validateAction>, Violation[]>>(true);
expectType<
  Equal<
    Parameters<typeof changeConfig>,
    [state: S, methodology: M, patch: Record<string, unknown>, by: string, now?: string]
  >
>(true);
expectType<Equal<ReturnType<typeof changeConfig>, ApplyResult>>(true);
expectType<
  Equal<
    Parameters<typeof complete>,
    [state: S, methodology: M, handoff: Handoff, acc: Accounting, now?: string]
  >
>(true);
expectType<Equal<ReturnType<typeof complete>, ApplyResult>>(true);
expectType<Equal<Parameters<typeof next>, [state: S, methodology: M, opts?: PlanOptions]>>(true);
expectType<Equal<ReturnType<typeof next>, NextResult>>(true);
expectType<Equal<Parameters<typeof plan>, [state: S, methodology: M, opts?: PlanOptions]>>(true);
expectType<Equal<ReturnType<typeof plan>, PlanResult>>(true);
expectType<Equal<Parameters<typeof synthesizeBrief>, [state: S, methodology: M, item: WorkItem]>>(
  true,
);
expectType<Equal<ReturnType<typeof synthesizeBrief>, Brief>>(true);
expectType<
  Equal<
    Parameters<typeof decide>,
    [
      state: S,
      pendingId: string,
      decision: "approve" | "reject",
      by: string,
      note: string,
      now?: string,
      methodology?: M,
    ]
  >
>(true);
expectType<Equal<ReturnType<typeof decide>, S>>(true);
expectType<
  Equal<
    Parameters<typeof raisePending>,
    [state: S, pending: Omit<PendingHuman, "id" | "raisedAt">, now?: string]
  >
>(true);
expectType<Equal<ReturnType<typeof raisePending>, S>>(true);
expectType<
  Equal<
    Parameters<typeof appendEvent>,
    [state: S, type: string, by: string, payload: unknown, now?: string]
  >
>(true);
expectType<Equal<ReturnType<typeof appendEvent>, S>>(true);
expectType<Equal<Parameters<typeof addItem>, [state: S, input: NewItem, by: string, now?: string]>>(
  true,
);
expectType<Equal<ReturnType<typeof addItem>, S>>(true);
expectType<
  Equal<
    Parameters<typeof editItem>,
    [state: S, id: string, patch: ItemPatch, by: string, now?: string]
  >
>(true);
expectType<Equal<ReturnType<typeof editItem>, S>>(true);
expectType<
  Equal<
    Parameters<typeof moveItem>,
    [state: S, id: string, to: { stage?: string; status: ItemStatus }, by: string, now?: string]
  >
>(true);
expectType<Equal<ReturnType<typeof moveItem>, S>>(true);
expectType<
  Equal<
    Parameters<typeof addEvidence>,
    [state: S, id: string, evidence: Omit<Evidence, "at">, now?: string]
  >
>(true);
expectType<Equal<ReturnType<typeof addEvidence>, S>>(true);
expectType<
  Equal<
    Parameters<typeof raiseBlocker>,
    [state: S, id: string, reason: string, owner: string, by: string, now?: string]
  >
>(true);
expectType<Equal<ReturnType<typeof raiseBlocker>, S>>(true);
expectType<
  Equal<
    Parameters<typeof clearBlocker>,
    [state: S, id: string, blockerId: string, by: string, now?: string, note?: string]
  >
>(true);
expectType<Equal<ReturnType<typeof clearBlocker>, S>>(true);
expectType<
  Equal<
    Parameters<typeof applyAgreement>,
    [state: S, change: { text: string; replaces?: string }, by: string, now: string]
  >
>(true);
expectType<Equal<ReturnType<typeof applyAgreement>, S>>(true);
expectType<
  Equal<Parameters<typeof retireAgreement>, [state: S, text: string, by: string, now: string]>
>(true);
expectType<Equal<ReturnType<typeof retireAgreement>, S>>(true);
expectType<
  Equal<
    Parameters<typeof correctAccounting>,
    [state: S, itemId: string, patch: AccountingPatch, by: string, now?: string, line?: number]
  >
>(true);
expectType<Equal<ReturnType<typeof correctAccounting>, S>>(true);
expectType<
  Equal<Parameters<typeof registerRole>, [state: S, role: Role, by: string, now?: string]>
>(true);
expectType<Equal<ReturnType<typeof registerRole>, S>>(true);
expectType<
  Equal<Parameters<typeof retireRole>, [state: S, roleId: string, by: string, now?: string]>
>(true);
expectType<Equal<ReturnType<typeof retireRole>, S>>(true);
expectType<Equal<Parameters<typeof coreRulesFor>, [methodology: Pick<M, "requiredCapabilities">]>>(
  true,
);
expectType<Equal<ReturnType<typeof coreRulesFor>, Rule[]>>(true);

// 1c. The read-only kernel functions take WorkflowState<string>, and repeat their 1.1 signature
// `(state: WorkflowState, ...)` as their last overload, so Parameters<typeof fn>[0] reads
// WorkflowState again (spec 26, "Reader overloads (U13)").
expectType<Equal<Parameters<typeof approversFor>[0], S>>(true);
expectType<Equal<Parameters<typeof assertPolicies>[0], S>>(true);
expectType<Equal<Parameters<typeof assignRole>[0], S>>(true);
expectType<Equal<Parameters<typeof authorOf>[0], S>>(true);
expectType<Equal<Parameters<typeof canDo>[0], S>>(true);
expectType<Equal<Parameters<typeof scrumCanDo>[0], S>>(true);
expectType<Equal<Parameters<typeof checkGate>[0], S>>(true);
expectType<Equal<Parameters<typeof estimateTokens>[0], S>>(true);
expectType<Equal<Parameters<typeof evaluatePolicies>[0], S>>(true);
expectType<Equal<Parameters<typeof getItem>[0], S>>(true);
expectType<Equal<Parameters<typeof isTerminalStage>[0], S>>(true);
expectType<Equal<Parameters<typeof lastDispatchBefore>[0], S>>(true);
expectType<Equal<Parameters<typeof lastEvent>[0], S>>(true);
expectType<Equal<Parameters<typeof nextStageOf>[0], S>>(true);
expectType<Equal<Parameters<typeof openIteration>[0], S>>(true);
expectType<Equal<Parameters<typeof openQuestions>[0], S>>(true);
expectType<Equal<Parameters<typeof requireCap>[0], S>>(true);
expectType<Equal<Parameters<typeof requireCapabilities>[0], S>>(true);
expectType<Equal<Parameters<typeof resourceCapsFor>[0], S>>(true);
expectType<Equal<Parameters<typeof rolesWith>[0], S>>(true);
expectType<Equal<Parameters<typeof separationLost>[0], S>>(true);
expectType<Equal<Parameters<typeof stageOf>[0], S>>(true);
expectType<Equal<Parameters<typeof toExNodes>[1], S>>(true);
// ...and a reader still accepts a custom-name state (the first, wider overload).
declare const triageState: WorkflowState<"triage">;
const readsCustom = (): unknown => [getItem(triageState, "x"), openIteration(triageState)];
void readsCustom;

// A wrapper typed through Parameters / ReturnType, as 1.1 consumers write it, still compiles.
type InitArg = Parameters<typeof init>[0];
function start(input: InitArg): WorkflowState {
  return init(input).state;
}
type CreateArg = Parameters<typeof createState>[0];
function make(input: CreateArg): WorkflowState {
  return createState(input);
}
function finish(...args: Parameters<typeof complete>): WorkflowState {
  return complete(...args).state;
}
const fromReturn: WorkflowState = null as unknown as ReturnType<typeof init>["state"];
void [start, make, finish, fromReturn];

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

// 1.3 (design spec section 27, #35): the escalation hook and Evidence.data are optional, so a 1.2
// Methodology literal without the hook (triage() above declares none) and 1.2 evidence still compile.
expectType<Equal<undefined extends Methodology["escalateGate"] ? true : false, true>>(true);
expectType<Equal<undefined extends Evidence["data"] ? true : false, true>>(true);
test("1.3: a 1.2 methodology without escalateGate still type-checks and has no hook", () => {
  const m12: Methodology<TriageConfig, "triage"> = triage();
  assert.equal(m12.escalateGate, undefined);
  const e12: Evidence = { kind: "k", ref: "r", by: "b", at: "2026-11-06T00:00:00.000Z" };
  assert.equal(e12.data, undefined);
});

// 1.3 (spec 27, #36): customPolicy, briefContext and Brief.context are optional, and the policy
// readers keep their 1.1 signature last, so Parameters<typeof fn> still reads three/four arguments.
expectType<Equal<undefined extends Methodology["customPolicy"] ? true : false, true>>(true);
expectType<Equal<undefined extends Methodology["briefContext"] ? true : false, true>>(true);
expectType<Equal<undefined extends Brief["context"] ? true : false, true>>(true);
expectType<Equal<BriefContext["stale"], string[]>>(true);
expectType<
  Equal<Parameters<typeof evaluatePolicies>, [state: S, item: WorkItem, policies: Policy[]]>
>(true);
expectType<
  Equal<
    Parameters<typeof assertPolicies>,
    [state: S, item: WorkItem, policies: Policy[], context: string]
  >
>(true);
test("1.3: a 1.2 methodology without customPolicy or briefContext has neither hook", () => {
  const m12: Methodology<TriageConfig, "triage"> = triage();
  assert.equal(m12.customPolicy, undefined);
  assert.equal(m12.briefContext, undefined);
});
