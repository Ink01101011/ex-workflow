import type { InvestigationState } from "./records/investigation.ts";
import type { ExperimentationState } from "./records/experimentation.ts";

// ---- items ------------------------------------------------------------
export type ItemType =
  | "epic"
  | "story"
  | "task"
  | "bug"
  | "change-request"
  | "deliverable"
  | "question";
export type ItemStatus =
  | "todo"
  | "in_progress"
  | "blocked"
  | "review"
  | "awaiting_human"
  | "done"
  | "dropped";
export type ClassOfService = "expedite" | "fixed-date" | "standard" | "intangible";

export interface Evidence {
  kind: string;
  ref: string;
  by: string;
  at: string;
  /** Structured content a policy reads (e.g. a risk level); the policy that owns the kind validates it. */
  data?: Record<string, unknown>;
}
export interface Blocker {
  id: string;
  reason: string;
  owner: string;
  raisedAt: string;
  clearedAt?: string;
}
export interface Transition {
  from: { stage: string; status: ItemStatus };
  to: { stage: string; status: ItemStatus };
  at: string;
  by: string;
}

/** Change-request: what the change touches and what it costs (waterfall change control). */
export interface ImpactAnalysis {
  summary: string;
  /** phase ids to reopen when the change is approved (each must be baselined or open) */
  reopen: string[];
  /** estimated rework weight (story points / size) */
  weight: number;
}

export interface WorkItem {
  id: string;
  type: ItemType;
  title: string;
  description?: string;
  dependsOn: string[];
  priority?: number;
  weight?: number;
  deadline?: string;
  classOfService?: ClassOfService;
  stage: string;
  status: ItemStatus;
  role?: string;
  parent?: string;
  acceptance: string[];
  evidence: Evidence[];
  blockers: Blocker[];
  transitions: Transition[];
  iteration?: string;
  traces?: string[];
  tags?: string[];
  /** bug / change-request: ids of items whose finished work this invalidates */
  affects?: string[];
  /** waterfall: Phase.id this item belongs to; questions and follow-ups inherit their parent's */
  phase?: string;
  /** change-request: impact analysis required before the change control board decides */
  impactAnalysis?: ImpactAnalysis;
}

/** Fields `editItem` / `exwf edit` may change. */
export type ItemPatch = Partial<
  Omit<WorkItem, "id" | "stage" | "status" | "transitions" | "evidence" | "blockers">
>;

/** Fields a caller supplies to addItem; the rest are defaulted. */
export type NewItem = Pick<WorkItem, "id" | "title"> &
  Partial<
    Omit<WorkItem, "id" | "title" | "stage" | "status" | "evidence" | "blockers" | "transitions">
  > & { stage?: string };

// ---- stages, policies, gates -----------------------------------------
export type Policy =
  | { kind: "evidence"; evidenceKind: string }
  | { kind: "acceptance-written" }
  | { kind: "estimate-present" }
  | { kind: "no-open-blockers" }
  | { kind: "dependencies-done" }
  | { kind: "custom"; id: string; description: string };

export type GateRequirement = "human" | { capability: string };
export interface Gate {
  id: string;
  requires: GateRequirement[];
  evidence: string[];
  onFail: { action: "block" } | { action: "return-to"; stage: string };
}

/**
 * What a methodology's `escalateGate` hook adds to a static gate (design spec section 27, #35).
 * Core only appends these to the gate (`widenGate`); it never removes or replaces a requirement.
 */
export interface GateEscalation {
  requires: GateRequirement[];
  evidence: string[];
  /** Why the gate was widened; recorded in the `gate.resolved` event (e.g. the risk level and its assessment). */
  reason: Record<string, string | null>;
}

export interface Stage {
  id: string;
  name: string;
  wipLimit?: number;
  entryPolicy: Policy[];
  exitPolicy: Policy[];
  gate?: Gate;
  commitmentPoint?: boolean;
  deliveryPoint?: boolean;
  /** Items entering this stage wait for a reviewer (status "review") instead of "todo". */
  review?: boolean;
}

// ---- iterations & budget ---------------------------------------------
export interface Budget {
  tokens?: number;
  turns?: number;
  wallclockMs?: number;
}
export interface Spent {
  tokens: number;
  turns: number;
  wallclockMs: number;
}
export interface Iteration {
  id: string;
  goal: string;
  budget: Budget;
  spent: Spent;
  startedAt: string;
  endedAt?: string;
  committed: string[];
  carryover: string[];
  outcome?: "completed" | "cancelled";
  /** Budget is exhausted; in-flight items may finish, nothing new is dispatched. */
  closing?: boolean;
}

// ---- roles -----------------------------------------------------------
export type ModelTier = "small" | "medium" | "large";
export type Capability =
  | "order-backlog"
  | "define-acceptance"
  | "facilitate"
  | "deliver"
  | "review"
  | "verify"
  | "approve-gate"
  | "manage-flow"
  | "control-change"
  | "escalate";

export interface Role {
  id: string;
  name: string;
  modelTier: ModelTier;
  resourceClass?: string;
  maxConcurrent?: number;
  capabilities: Capability[];
  canApprove: string[];
  inputs: string[];
  outputs: string[];
  do_not: string[];
  constraints?: string[];
}

// ---- handoff, accounting, events ------------------------------------
export type Verdict = "done" | "blocked" | "needs-review" | "rework" | "escalate";
export interface Handoff {
  item: string;
  role: string;
  produced: Array<{ kind: string; ref: string }>;
  notes: string;
  do_not: string[];
  open_questions: string[];
  verdict?: Verdict;
  /** new work discovered while doing this item; lands in the FIRST stage (backlog), never in the iteration */
  follow_ups?: NewItem[];
  /** raised by the worker the moment it happens, e.g. "spec was vague here" */
  lessons?: Array<{ text: string; scope: Lesson["scope"] }>;
}

export interface Accounting {
  item: string;
  role: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  startedAt: string;
  endedAt: string;
  /** The tokens are a placeholder the host will correct with correctAccounting, not the host's usage figures. */
  estimate?: boolean;
}

export interface Event {
  seq: number;
  at: string;
  type: string;
  by: string;
  payload: unknown;
}

export interface PendingHuman {
  id: string;
  kind: "gate" | "decision";
  item?: string;
  gate?: string;
  question: string;
  raisedAt: string;
}

export type LessonChange =
  | { kind: "agreement"; text: string; replaces?: string } // a working agreement every future brief carries as an invariant; replaces retires an earlier one
  | { kind: "dod"; policy: Policy } // tighten the Definition of Done
  | { kind: "backlog"; item: NewItem } // work for the backlog
  | { kind: "skill"; note: string }; // for the host: change a role prompt / memory
export interface Lesson {
  id: string; // L<n>
  at: string;
  text: string;
  scope: "policy" | "skill" | "memory" | "spec" | "review";
  status: "raised" | "adopted" | "dismissed";
  from?: string; // role that raised it
  item?: string; // item it was raised on
  suggestedChange?: LessonChange;
}

/** A deliverable recorded on a phase (gateReview input or engine-generated). */
export interface Produced {
  kind: string;
  ref: string;
  by: string;
  at: string;
}
export interface Phase {
  id: string;
  name: string;
  deliverables: string[];
  gate: Gate;
  status: "pending" | "open" | "baselined" | "reopened";
  /** planned budget; spent is tracked on the Iteration kickoff opens for the phase */
  budget?: Budget;
  /** phase-level deliverables (item evidence counts too) */
  produced?: Produced[];
}
export interface Baseline {
  phase: string;
  version: number;
  at: string;
  approvedBy: string[];
  itemSnapshot: Record<string, WorkItem>;
}

// ---- state -----------------------------------------------------------
export type MethodologyName =
  | "scrum"
  | "kanban"
  | "waterfall"
  | "investigation"
  | "experimentation";
/**
 * `state.ext`: extension records keyed by their owner. The two built-in records are typed, so the
 * state schema validates them; any other key holds any JSON value (design spec section 26).
 */
export interface WorkflowExt {
  investigation?: InvestigationState;
  experimentation?: ExperimentationState;
  [key: string]: unknown;
}

/**
 * Workflow state. `N` is the methodology name: the default `MethodologyName` (the five
 * built-ins) keeps every 1.1 consumer's type check unchanged; a custom methodology types its
 * state as `WorkflowState<"its-name">` (design spec section 26).
 */
export interface WorkflowState<N extends string = MethodologyName> {
  version: 1;
  methodology: N;
  config: unknown;
  /**
   * Standalone investigation lifecycle, created by its intake ceremony.
   * Since 1.2 a read-only mirror of `ext.investigation`, kept for SDK code that reads this
   * field (in memory only: the file adapter stores `ext.investigation` and restores this mirror on load):
   * once `ext.investigation` exists, a write here is ignored. Read it with
   * `readExt(state, "investigation")` and write it with `writeExt`. It does not make a 1.2 state
   * loadable by 1.1.x, whose schema rejects `ext`. Removed in 2.0.
   * @deprecated
   */
  investigation?: InvestigationState;
  /**
   * Standalone isolated candidate experiment, created by its freeze ceremony.
   * Since 1.2 a read-only mirror of `ext.experimentation`, kept for SDK code that reads this
   * field (in memory only: the file adapter stores `ext.experimentation` and restores this mirror on load):
   * once `ext.experimentation` exists, a write here is ignored. Read it with
   * `readExt(state, "experimentation")` and write it with `writeExt`. It does not make a 1.2 state
   * loadable by 1.1.x, whose schema rejects `ext`. Removed in 2.0.
   * @deprecated
   */
  experimentation?: ExperimentationState;
  /**
   * Extension records keyed by their owner (a methodology name or a common piece id). Read and
   * write it only through `readExt` / `writeExt`. Absent in states written before 1.2.
   */
  ext?: WorkflowExt;
  items: Record<string, WorkItem>;
  stages: Stage[];
  roles: Record<string, Role>;
  iterations: Iteration[];
  phases?: Phase[];
  baseline?: Baseline;
  /** waterfall: every baseline ever taken, oldest first; `baseline` is the last one */
  baselines?: Baseline[];
  events: Event[];
  accounting: Accounting[];
  pending: PendingHuman[];
  lessons: Lesson[];
  /** adopted working agreements; synthesizeBrief appends them to invariants */
  agreements: string[];
}

// ---- actions, rules, methodology -------------------------------------
export interface Action {
  type: string;
  by: string;
  payload?: unknown;
}
export interface Violation {
  rule: string;
  severity: "error" | "warning";
  item?: string;
  message: string;
  fix: string;
}
export interface Rule<N extends string = MethodologyName> {
  id: string;
  severity: "error" | "warning";
  check(state: WorkflowState<N>, action: Action): Violation[];
}
export interface ApplyResult<N extends string = MethodologyName> {
  state: WorkflowState<N>;
  warnings: Violation[];
}

export interface Brief {
  item: WorkItem;
  role: Role;
  modelTier: ModelTier;
  invariants: string[];
  do_not: string[];
  acceptance: string[];
  upstream: Array<{ item: string; produced: Handoff["produced"]; notes: string }>;
  /** earlier completions of THIS item (rework feedback) */
  priorHandoffs: Array<{
    role: string;
    verdict: Verdict;
    notes: string;
    produced: Handoff["produced"];
    at: string;
  }>;
  /** open bug/change-request items whose `affects` touches this item or its dependsOn */
  relatedBugs: Array<{ id: string; title: string; affects: string[] }>;
  budgetRemaining: Budget;
  gateAhead?: Gate;
  /** for a question item: the escalating item's last handoff */
  parent?: {
    item: string;
    role: string;
    notes: string;
    produced: Handoff["produced"];
    open_questions: string[];
    do_not: string[];
  };
}

export type CoreTerm =
  | "backlog"
  | "item"
  | "stage"
  | "iteration"
  | "increment"
  | "ceremony"
  | "gate";
export type CeremonyInput = { by: string; now?: string } & Record<string, unknown>;
export type Ceremony<N extends string = MethodologyName> = (
  state: WorkflowState<N>,
  input: CeremonyInput,
) => ApplyResult<N>;

export interface PlannerOptions {
  schedulerMode: "level" | "throughput";
  /** Stage a todo item is pulled into when dispatched; a function decides per item; omitted/undefined = stay in its current stage. */
  dispatchStage?: string | ((item: WorkItem) => string | undefined);
  concurrencyCap?: number;
  fairnessPolicy?: "none" | "aging";
  maxDeferralRounds?: number;
  deadlineStrategy?: "earliest-first" | "latest-first";
  weightStrategy?: "higher-first" | "lower-first";
  /** Priority the planner orders by; defaults to item.priority. */
  priorityOf?(item: WorkItem): number | undefined;
  /** Orders items of equal priority (after deadline/weight strategies); e.g. class of service, then age. */
  tieBreaker?(a: WorkItem, b: WorkItem): number;
  /** Statuses that occupy a stage's wipLimit slot; default ["in_progress"]. */
  wipCounts?: ItemStatus[];
  /** Per-item replacement for the target stage's wipLimit (e.g. an expedite bypass); undefined = no limit. */
  wipLimitOf?(stage: Stage, item: WorkItem): number | undefined;
  /** Role id to dispatch a todo item to (e.g. the phase's deliverer); undefined = default (item.role, then reviewer/deliverer by capability). */
  roleFor?(item: WorkItem): string | undefined;
  /** Tokens reserved for work already in flight, deducted from the iteration remainder. */
  reservedTokens?: number;
  /** How estimateTokens prices a candidate; default "per-weight". */
  estimateMode?: "per-weight" | "per-call";
  /** Tokens per weight unit when no accounting history exists; default 20000. PlanOptions.fallbackTokensPerWeight wins. */
  fallbackTokensPerWeight?: number;
}

/**
 * A methodology. `N` is its name: the default `MethodologyName` is the five built-ins; a custom
 * methodology declares `Methodology<MyConfig, "my-name">` (design spec section 26).
 */
export interface Methodology<C = unknown, N extends string = MethodologyName> {
  name: N;
  vocabulary: Record<CoreTerm, string>;
  validateConfig(config: unknown): C;
  defaultStages(config: C): Stage[];
  defaultRoles(config: C): Role[];
  requiredCapabilities: Capability[];
  exclusiveCapabilities: Capability[];
  plannerOptions(state: WorkflowState<N>): PlannerOptions;
  candidates(state: WorkflowState<N>): WorkItem[];
  invariants(state: WorkflowState<N>, item: WorkItem): string[];
  ceremonies: Record<string, Ceremony<N>>;
  rules: Rule<N>[];
  metrics(state: WorkflowState<N>): Record<string, number | number[] | Record<string, number>>;
  humanDefaults: { gates: "all" | "none" | string[] };
  /** Called after complete(); lets the methodology react (e.g. close a sprint when the budget is gone). */
  afterComplete?(state: WorkflowState<N>, itemId: string, now: string): WorkflowState<N>;
  /** Config keys that cannot change after init (changeConfig refuses them). */
  lockedConfigKeys?: string[];
  /** Called by changeConfig after the new config is stored; keeps derived state (e.g. stage policies) in step. */
  afterConfigChange?(state: WorkflowState<N>, now: string): WorkflowState<N>;
  /** Methodology-specific status for hosts (e.g. cadences due); printed by `exwf status`. */
  report?(state: WorkflowState<N>): Record<string, unknown>;
  /** Called by decide() after a pending entry is resolved; lets the methodology act on it (e.g. baseline a phase gate, apply a change-request decision). */
  afterDecide?(
    state: WorkflowState<N>,
    entry: PendingHuman,
    decision: "approve" | "reject",
    by: string,
    note: string,
    now: string,
  ): WorkflowState<N>;
  /**
   * Called by complete() before a gated completion is checked; what it returns is appended to the
   * static gate (escalation only) and the widened gate is recorded as `gate.resolved`.
   */
  escalateGate?(state: WorkflowState<N>, item: WorkItem, gate: Gate): GateEscalation | undefined;
}

// ---- errors ----------------------------------------------------------
export type ErrorCode =
  | "unknown-item"
  | "duplicate-item"
  | "unknown-role"
  | "duplicate-role"
  | "unknown-stage"
  | "missing-capability"
  | "exclusive-capability"
  | "role-has-open-items"
  | "invalid-transition"
  | "policy-unmet"
  | "gate-unmet"
  /** reserved: never thrown; kept for type compatibility */
  | "conflict-of-interest"
  | "handoff-invalid"
  | "accounting-invalid"
  | "rule-violation"
  | "planner-error"
  | "no-op"
  | "unknown-pending"
  | "unknown-ceremony"
  | "state-version"
  | "config-invalid"
  | "budget-exhausted"
  | "invalid-input";
