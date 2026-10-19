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
}

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
export interface Iteration {
  id: string;
  goal: string;
  budget: Budget;
  spent: Required<Budget>;
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
  | { kind: "agreement"; text: string } // a working agreement every future brief carries as an invariant
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

export interface Phase {
  id: string;
  name: string;
  deliverables: string[];
  gate: Gate;
  status: "pending" | "open" | "baselined" | "reopened";
}
export interface Baseline {
  phase: string;
  version: number;
  at: string;
  approvedBy: string[];
  itemSnapshot: Record<string, WorkItem>;
}

// ---- state -----------------------------------------------------------
export type MethodologyName = "scrum" | "kanban" | "waterfall";
export interface WorkflowState {
  version: 1;
  methodology: MethodologyName;
  config: unknown;
  items: Record<string, WorkItem>;
  stages: Stage[];
  roles: Record<string, Role>;
  iterations: Iteration[];
  phases?: Phase[];
  baseline?: Baseline;
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
export interface Rule {
  id: string;
  severity: "error" | "warning";
  check(state: WorkflowState, action: Action): Violation[];
}
export interface ApplyResult {
  state: WorkflowState;
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
export type Ceremony = (state: WorkflowState, input: CeremonyInput) => ApplyResult;

export interface PlannerOptions {
  schedulerMode: "level" | "throughput";
  /** Stage a todo item is pulled into when dispatched; omitted = stay in its current stage. */
  dispatchStage?: string;
  concurrencyCap?: number;
  fairnessPolicy?: "none" | "aging";
  maxDeferralRounds?: number;
  deadlineStrategy?: "earliest-first" | "latest-first";
  weightStrategy?: "higher-first" | "lower-first";
}

export interface Methodology<C = unknown> {
  name: MethodologyName;
  vocabulary: Record<CoreTerm, string>;
  validateConfig(config: unknown): C;
  defaultStages(config: C): Stage[];
  defaultRoles(config: C): Role[];
  requiredCapabilities: Capability[];
  exclusiveCapabilities: Capability[];
  plannerOptions(state: WorkflowState): PlannerOptions;
  candidates(state: WorkflowState): WorkItem[];
  invariants(state: WorkflowState, item: WorkItem): string[];
  ceremonies: Record<string, Ceremony>;
  rules: Rule[];
  metrics(state: WorkflowState): Record<string, number | number[] | Record<string, number>>;
  humanDefaults: { gates: "all" | "none" | string[] };
  /** Called after complete(); lets the methodology react (e.g. close a sprint when the budget is gone). */
  afterComplete?(state: WorkflowState, itemId: string, now: string): WorkflowState;
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
