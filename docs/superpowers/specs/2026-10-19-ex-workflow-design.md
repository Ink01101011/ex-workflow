# ex-workflow — design spec

Date: 2026-10-19
Status: approved in brainstorm, awaiting written review
Owner: Supakit (Ink01101011)
Scope: the `ex-workflow` npm package (L0 engine) that the workflowAI skills
(L1), generated agent adapters (L2) and a future MCP server (L3) all wrap.

---

## 1. Context

workflowAI is a family of AI-team orchestration products: three
methodology orchestrators (ScrumAI, KanbanAI, WaterfallAI) that act as the
scrum master / flow manager / project manager over a team of role agents
(product owner, architect, implementer, reviewer, QA, …). Roles are sold
individually and in bundles (methodology packs, domain team packs).

Distribution is worldwide and channel-agnostic. The canonical sellable
unit is a SKILL.md skill folder (the agentskills open standard). Channels
are build targets:

| Channel | Format | Money |
|---|---|---|
| Agensi (agensi.io) | zipped skill folder: `SKILL.md` + `scripts/` + `reference/`; 8-point security scan; bundles; one-time or subscription; 70/30 | paid |
| npm | package + `npx … add` installer that copies skills into the host agent's skills dir | free |
| Claude Code plugin marketplace | plugin dir + `marketplace.json`, `agents/*.md` generated from role manifests | free |
| skills.sh (`npx skills add`) | skill folder | free |

Agensi sells **only skills**: no MCP servers, no agent definitions. Buyers
run ~19 different agents (Claude Code, Cursor, Codex CLI, Gemini CLI,
Copilot, …). Therefore everything must be portable from day one, and
anything Claude-Code-specific is a generated adapter, never source.

Open-core: engine + 3 orchestrators + basic roles are free (npm/GitHub);
advanced roles, domain packs and templates are paid (Agensi, later an own
store).

### Layers

```
L3  MCP server (pro)        daemon, hook enforcement, dashboard, team mode
L2  agent adapters          Claude Code agents/*.md, future Cursor/Codex formats   (generated)
L1  skills                  SKILL.md + scripts/wf.js (bundled L0)                   (sold)
L0  ex-workflow             this spec: state, policy, planner, accounting          (npm, free)
```

All layers read and write the same `.workflow/` files in the buyer's
repo, so a skill-only user upgrades to MCP without migration.

### Why a separate package

- It is the real open-core artefact: usable without any skill.
- L1 and L3 provably share one implementation.
- It joins the `ex-*` family (`ex-flow`, `ex-search`, `exsorted`); every
  sold skill is a showcase for `ex-flow`.

---

## 2. Goals and non-goals

### Goals

1. One engine, three methodologies, modelled as completely as the
   canonical texts describe them (Scrum Guide 2020; the Kanban Method's
   six practices, cadences, classes of service and flow metrics; classic
   phase-gate Waterfall with change control and traceability).
2. The program decides, the LLM executes. Which item may move, who may
   approve, whether a stage may start: engine, not prompt.
3. Roles are data. Methodologies reference capabilities, never role names.
4. Pure, serialisable state. Every operation is `(state, action) -> state`
   or `(state) -> view`. No I/O in core.
5. Zero runtime dependencies beyond `ex-flow` and `exsorted` (both MIT,
   both the owner's). Runs on Node on macOS, Linux and Windows.
6. Errors resolve: every violation names the exact rule, the exact item,
   and a concrete fix.

### Non-goals (v1.0)

- CLI beyond a thin `exwf` wrapper (section 13).
- Any storage other than JSON files via the adapter in section 12.
- UI, dashboard, MCP wrapper, hooks: L3.
- The skills themselves, role prompts, channel build pipeline: workflowAI
  repo.
- Custom ceremonies (custom code). Custom roles, stages and policies are
  in scope (data).
- Hybrids (Scrumban, Kanban-inside-a-phase). The core is composable
  enough; shipping them is a later minor.

---

## 3. Package shape

```
ex-workflow            core: types, state, reducers, planner, registry, accounting, errors
ex-workflow/scrum      Scrum methodology module
ex-workflow/kanban     Kanban methodology module
ex-workflow/waterfall  Waterfall methodology module
ex-workflow/cli        thin command wrapper (node, file adapter)
ex-workflow/types      type-only entry
ex-workflow/schema     JSON Schema for state, role manifest, policy (generated from types)
```

- TypeScript, ESM + CJS, `exports` map with `types` first, same build
  setup as `ex-flow`.
- Repo: `github.com/Ink01101011/ex-workflow`, MIT.
- `dependencies`: `ex-flow`, `exsorted`. Nothing else at runtime.
- No React entry. ex-flow's `./react` is never imported.
- Size budget: core + one methodology ≤ 40 KB minified before gzip; the
  L1 bundle (`scripts/wf.js`, esbuild of core + 3 modules + cli + ex-flow +
  exsorted) ≤ 120 KB. Budgets are measured at first release and then
  ratcheted; they are never raised without a measurement showing the
  bytes are required behaviour.

---

## 4. Core model

All ids are strings. All times are ISO-8601 strings. Everything below is
JSON-serialisable; `state.version` is the schema version.

```ts
type ItemType = "epic" | "story" | "task" | "bug" | "change-request" | "deliverable" | "question";
type ItemStatus = "todo" | "in_progress" | "blocked" | "review" | "awaiting_human" | "done" | "dropped";
type ClassOfService = "expedite" | "fixed-date" | "standard" | "intangible";

interface WorkItem {
  id: string;
  type: ItemType;
  title: string;
  description?: string;
  dependsOn: string[];
  priority?: number;           // higher first (ex-flow default)
  weight?: number;             // story points / size
  deadline?: string;           // ISO; fixed-date CoS requires it
  classOfService?: ClassOfService;
  stage: string;               // Stage.id
  status: ItemStatus;
  role?: string;               // Role.id currently responsible
  parent?: string;             // epic -> story -> task
  acceptance: string[];
  evidence: Evidence[];
  blockers: Blocker[];
  transitions: Transition[];   // every stage/status change with time
  iteration?: string;          // Iteration.id when committed
  traces?: string[];           // waterfall: requirement <-> design <-> test ids
  tags?: string[];
}

interface Evidence { kind: string; ref: string; by: string; at: string }
interface Blocker  { id: string; reason: string; owner: string; raisedAt: string; clearedAt?: string }
interface Transition { from: { stage: string; status: ItemStatus }; to: { stage: string; status: ItemStatus }; at: string; by: string }

interface Stage {
  id: string;
  name: string;
  wipLimit?: number;
  entryPolicy: Policy[];       // Definition of Ready
  exitPolicy: Policy[];        // Definition of Done
  gate?: Gate;                 // checked before an item may LEAVE this stage
  commitmentPoint?: boolean;   // kanban: lead time clock starts here
  deliveryPoint?: boolean;     // kanban: lead time clock stops here
}

type Policy =
  | { kind: "evidence"; evidenceKind: string }
  | { kind: "acceptance-written" }
  | { kind: "estimate-present" }
  | { kind: "no-open-blockers" }
  | { kind: "dependencies-done" }
  | { kind: "custom"; id: string; description: string };   // evaluated by the host, recorded as evidence

interface Gate {
  id: string;
  requires: Array<"human" | { capability: string }>;
  evidence: string[];          // evidence kinds that must be present
  onFail: { action: "block" } | { action: "return-to"; stage: string };
}

interface Iteration {
  id: string;
  goal: string;
  budget: Budget;
  spent: Budget;
  startedAt: string;
  endedAt?: string;
  committed: string[];         // item ids
  carryover: string[];         // ids carried in from the previous iteration
  outcome?: "completed" | "cancelled";
}

interface Budget { tokens?: number; turns?: number; wallclockMs?: number }

interface Role {
  id: string;
  name: string;
  modelTier: "small" | "medium" | "large";
  resourceClass?: string;      // ex-flow resourceClass; defaults to id
  maxConcurrent?: number;      // -> ex-flow resourceCaps[resourceClass]
  capabilities: string[];
  canApprove: string[];        // gate ids
  inputs: string[];
  outputs: string[];
  do_not: string[];
  constraints?: string[];
}

interface Handoff {
  item: string;
  role: string;
  produced: Array<{ kind: string; ref: string }>;
  notes: string;
  do_not: string[];            // REQUIRED, may be empty array but must exist
  open_questions: string[];
  verdict?: "done" | "blocked" | "needs-review" | "escalate";
}

interface Accounting {
  item: string;
  role: string;
  model: string;               // the model actually used; never guessed
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  startedAt: string;
  endedAt: string;
}

interface Event { seq: number; at: string; type: string; by: string; payload: unknown }

interface Phase { id: string; name: string; deliverables: string[]; gate: Gate; status: "pending" | "open" | "baselined" | "reopened" }
interface Baseline { phase: string; version: number; at: string; approvedBy: string[]; itemSnapshot: Record<string, WorkItem> }
interface PendingHuman { id: string; kind: "gate" | "decision"; item?: string; gate?: string; question: string; raisedAt: string }
interface Lesson { at: string; text: string; scope: "policy" | "skill" | "memory"; suggestedChange?: string }
type CoreTerm = "backlog" | "item" | "stage" | "iteration" | "increment" | "ceremony" | "gate";

interface WorkflowState {
  version: 1;
  methodology: "scrum" | "kanban" | "waterfall";
  config: unknown;             // methodology config (validated by its schema)
  items: Record<string, WorkItem>;
  stages: Stage[];
  roles: Record<string, Role>;
  iterations: Iteration[];     // empty for kanban/waterfall
  phases?: Phase[];            // waterfall
  baseline?: Baseline;         // waterfall
  events: Event[];             // append-only; metrics derive from this
  accounting: Accounting[];
  pending: PendingHuman[];     // gates/decisions waiting on a person
  lessons: Lesson[];           // retro output, for the host to persist into memory
}
```

`events` is the source of truth for every metric. Reducers may cache
derived fields on items (`transitions`) for convenience, but
`metrics(state)` must be reproducible from `events` alone, and a test
asserts it.

---

## 5. Planner: ex-flow integration

`ex-flow` is a pure DAG planner. `ex-workflow` owns state and calls it on
every `next()`:

1. Select candidate items: `status in (todo, review)` and not `done`,
   `dropped`, `blocked`, `awaiting_human`, plus methodology filtering
   (scrum: committed to the open sprint; waterfall: current phase).
2. Map each to `ExNode`: `id`, `dependsOn` (filtered to candidates; done
   dependencies drop out), `priority`, `weight`, `deadline` (epoch ms),
   `resourceClass` = the role's `resourceClass`, `data` = the item.
3. Options come from the methodology module: `schedulerMode`,
   `concurrencyCap` (WIP), `resourceCaps` (from `Role.maxConcurrent`),
   `fairnessPolicy`, `deadlineStrategy`, `weightStrategy`, `tieBreaker`
   (class of service in Kanban).
4. `resolveExecutionDetails()` → first batch is the dispatch set, trimmed
   by remaining budget; metrics are recorded as an event
   (`planner.resolved` with `rounds`, `deferredNodes`, `constraintHits`).
5. Each dispatched item becomes a `Brief`.

ex-flow errors (`ExFlowRuntimeError`, e.g. cycle, duplicate id) are
wrapped into `WorkflowError` with the offending ids and a fix.

Re-planning is per call. No scheduler state lives inside ex-flow.

---

## 6. Roles, capabilities, registry

Roles are data (`Role` above). The same manifest shape appears in a role
skill's SKILL.md frontmatter (under `role:`) and in
`.workflow/roles/*.json`. Built-in roles per methodology are presets of
the same shape with no special privileges.

### Capability vocabulary (core)

| Capability | Meaning |
|---|---|
| `order-backlog` | may reorder / prioritise the backlog |
| `define-acceptance` | may write or change acceptance criteria |
| `facilitate` | may run ceremonies, open/close iterations |
| `deliver` | may take items into `in_progress` and produce increments |
| `review` | may move items to/from `review` and record review evidence |
| `verify` | may record test evidence |
| `approve-gate` | may approve gates listed in `canApprove` |
| `manage-flow` | kanban: may set WIP, policies, classes of service |
| `control-change` | waterfall: may accept/reject change requests, rebaseline |
| `escalate` | may raise `question` items to a human |

Methodologies add their own capabilities only through this list; new
ones require a core minor.

### Rules

- A methodology declares `requiredCapabilities` and optional
  `exclusiveCapabilities`. `init` fails (resolving error) if any required
  capability has no role, or an exclusive one has more than one.
- Conflict of interest: a role may not approve a gate for an item whose
  last `in_progress` transition was by the same role. Violation is an
  error with the alternative approvers listed.
- A single role holding every capability is a **warning**
  (`separation-lost`), not an error: solo operators are legitimate.
- Roles may be added/removed at runtime via `registerRole` /
  `retireRole`; retiring a role holding open items is an error listing
  the items.

---

## 7. Methodology module interface

```ts
interface Methodology<C> {
  name: "scrum" | "kanban" | "waterfall";
  configSchema: JSONSchema;                         // validates WorkflowState.config
  vocabulary: Record<CoreTerm, string>;             // "backlog" -> "Product Backlog" | "Options" | "Requirements Baseline"
  defaultStages(config: C): Stage[];
  defaultRoles(config: C): Role[];
  requiredCapabilities: string[];
  exclusiveCapabilities: string[];
  plannerOptions(state): ExFlowOptions;
  candidates(state): WorkItem[];
  ceremonies: Record<string, Ceremony>;             // (state, input) -> state, each with its own input schema
  rules: Rule[];                                    // (state, action) -> Violation[]
  metrics(state): Record<string, number | number[] | Record<string, number>>;
  humanDefaults: { gates: "all" | "none" | string[] };
}

interface Rule { id: string; severity: "error" | "warning"; check(state, action): Violation[] }
interface Violation { rule: string; severity; item?: string; message: string; fix: string }
```

The core applies an action by: validate against core rules → validate
against methodology rules → reduce → append events. Any `error`
violation aborts the whole action; `warning` violations are returned
alongside the new state.

---

## 8. Scrum module (`ex-workflow/scrum`)

Source: Scrum Guide 2020.

### Config

```ts
interface ScrumConfig {
  sprintBudget: Budget;                   // time-box; tokens and/or turns, optional wallclock
  productGoal: string;
  definitionOfDone: Policy[];             // applied as exitPolicy of the last stage
  refinementSharePct?: number;            // default 10: budget reserved for refinement per sprint
  allowMidSprintAdd?: "never" | "po-only" | "any";   // default "po-only"
}
```

### Roles (presets)

| Role | capabilities | modelTier |
|---|---|---|
| `product-owner` | order-backlog, define-acceptance, escalate | large |
| `scrum-master` | facilitate, escalate | large |
| `developer` | deliver, review, verify | small |

`exclusiveCapabilities: ["order-backlog"]`. `requiredCapabilities`:
order-backlog, facilitate, deliver.

### Artifacts and commitments

- Product Backlog: all items with no `iteration`, ordered by `priority`
  then insertion. Commitment: `productGoal`.
- Sprint Backlog: items committed to the open iteration. Commitment:
  `Iteration.goal`.
- Increment: items `done` in the sprint. Commitment: Definition of Done
  (`definitionOfDone` is the exit policy of the terminal stage and cannot
  be weakened mid-sprint).

### Stages (default)

`backlog → sprint → in_progress → review → done`. `in_progress` carries
no WIP limit by default (Scrum does not prescribe one); config may set
one.

### Ceremonies

| Ceremony | Input | Effect | Rules |
|---|---|---|---|
| `refine` | item edits (acceptance, weight, split) | updates backlog items, no iteration change | needs `define-acceptance` or `deliver`; spends against refinement share |
| `plan` | `goal`, ordered candidate ids or `auto` | opens an `Iteration`; `auto` walks `fullSequence` from the planner until `sprintBudget` is full; carries over unfinished items from the previous sprint (must be re-estimated first) | needs `facilitate`; one open sprint at a time; goal required; every committed item needs acceptance + estimate |
| `daily` | none | emits a `daily` event with: items per status, blockers with owners, budget spent/remaining, forecast (velocity-based) | any role; the host reports it |
| `review` | increment acknowledgement, optional new backlog items from stakeholders | records `increment` event; stakeholder additions go to Product Backlog, never into the sprint | gate `sprint-review` defaults to human |
| `retro` | `lessons[]`, optional policy changes | appends `Lesson`s; allowed to change `definitionOfDone` for the **next** sprint only | needs `facilitate`; required before the next `plan` |
| `cancel` | reason | ends the sprint with `outcome: cancelled`, returns items to backlog | needs `order-backlog` (PO only) |

### Rules

- `sprint-budget-fixed`: the open sprint's budget cannot be increased.
  Overrun ends the sprint automatically with the remaining items as
  carryover.
- `scope-protects-goal`: adding an item mid-sprint requires
  `allowMidSprintAdd` and a declared `goalImpact: "none"`; removing an
  item requires `order-backlog`.
- `po-orders-backlog`: priority changes require `order-backlog`.
- `dod-not-weakened`: removing a DoD policy mid-sprint is an error.
- `carryover-reestimated`: a carried item needs a new `weight` before
  commitment.
- `retro-before-plan`: a new sprint cannot open until the previous
  sprint's retro event exists (warning if the previous sprint was
  cancelled).
- `one-open-sprint`.

### Metrics

velocity (weight done per sprint, last N), burndown (remaining weight per
`daily`), commitment reliability (committed vs done), sprint goal hit
rate, carryover ratio, budget utilisation, cost per point (from
accounting).

---

## 9. Kanban module (`ex-workflow/kanban`)

Source: the Kanban Method (Anderson): six general practices, cadences,
classes of service, flow metrics.

### Config

```ts
interface KanbanConfig {
  columns: Array<{ id: string; name: string; wipLimit?: number; policies: Policy[]; commitmentPoint?: boolean; deliveryPoint?: boolean }>;
  classesOfService: Partial<Record<ClassOfService, { wipBypass?: number; sle?: { percentile: number; targetMs: number } }>>;
  fairness?: { aging: boolean; maxDeferralRounds?: number };     // default aging on
  cadences?: Partial<Record<KanbanCadence, { everyTurns?: number }>>;
}
type KanbanCadence = "replenishment" | "delivery-planning" | "service-delivery-review" | "operations-review" | "risk-review" | "strategy-review";
```

### Roles (presets)

| Role | capabilities |
|---|---|
| `service-request-manager` | order-backlog, define-acceptance, manage-flow, escalate |
| `service-delivery-manager` | facilitate, manage-flow, escalate |
| `worker` | deliver, review, verify |

`requiredCapabilities`: manage-flow, deliver. No exclusive capabilities.

### Practices → engine

| Practice | Engine |
|---|---|
| Visualise | `columns` are stages; `board(state)` view returns items per column with age |
| Limit WIP | `wipLimit` per column enforced by rule `wip-respected`; `expedite` may bypass by `wipBypass` (default 1) |
| Manage flow | planner `schedulerMode: "throughput"`, `concurrencyCap` = WIP of the pull column, `fairnessPolicy: "aging"`; pull happens only when a slot frees |
| Explicit policies | every column must have ≥1 policy (`policy-explicit` error at init) |
| Feedback loops | cadences are ceremonies, each emits a structured event; `everyTurns` lets the orchestrator know when one is due |
| Improve collaboratively | `service-delivery-review` may change WIP limits and policies; change is an event with before/after |

### Classes of service

| Class | Planner | Rules |
|---|---|---|
| `expedite` | `priority` forced to max; tieBreaker first | at most 1 expedite in progress (configurable); bypasses WIP by `wipBypass` |
| `fixed-date` | `deadlineStrategy: "earliest-first"` | `deadline` required; warning when projected cycle time at the SLE percentile exceeds time to deadline |
| `standard` | default FIFO by aging | — |
| `intangible` | lowest priority, aging still applies so they are not starved | — |

### Ceremonies (cadences)

`replenishment` (pull options into the commitment point),
`delivery-planning` (select items for the delivery point),
`service-delivery-review` (adjust WIP/policies/SLE),
`operations-review` (blockers, aging WIP),
`risk-review` (fixed-date risk, blockers older than N),
`strategy-review` (classes of service mix). Each is a reducer emitting a
typed event; none is required for `next()` to work.

### Rules

`wip-respected`, `pull-not-push` (an item enters a column only when the
planner dispatches it or a human pulls it), `policy-explicit`,
`blocker-has-owner`, `one-expedite`, `fixed-date-needs-deadline`,
`commitment-point-once` (exactly one commitment and one delivery point).

### Metrics

lead time (commitment→delivery), cycle time per column, throughput per
window, WIP per column, flow efficiency (active/total), aging WIP
(current items vs their column's percentile), cumulative flow (per
`daily`-equivalent snapshot), SLE compliance per class, blocker time.

---

## 10. Waterfall module (`ex-workflow/waterfall`)

Source: classic sequential phase-gate (Royce 1970 as practised:
requirements → design → implementation → verification → deployment →
maintenance) with formal change control and traceability.

### Config

```ts
interface WaterfallConfig {
  phases: Array<{ id: string; name: string; deliverables: string[]; gate: Gate }>;   // ordered
  changeControl: { requiresImpactAnalysis: boolean; approvers: Array<"human" | { capability: string }> };
  traceability: { from: string; to: string[] }  // phase ids
  humanGates: "all" | string[];                         // default "all"
}
```

Default phases and deliverables:

| Phase | Deliverables (evidence kinds) |
|---|---|
| `requirements` | `srs` |
| `design` | `design-doc`, `interface-spec` |
| `implementation` | `code-baseline` |
| `verification` | `test-report`, `traceability-matrix` |
| `deployment` | `release-notes`, `deployment-record` |
| `maintenance` | `change-log` |

### Roles (presets)

`project-manager` (facilitate, control-change, approve-gate, escalate),
`business-analyst` (define-acceptance), `architect` (deliver in design),
`developer` (deliver), `qa` (verify, review), `release-manager`
(deliver in deployment). `requiredCapabilities`: facilitate,
control-change, approve-gate, deliver, verify.

### Phases, baselines, change control

- All items in a phase move together. The planner runs
  `schedulerMode: "level"` inside the phase; a phase is complete when all
  its items are `done` and all `deliverables` exist as evidence.
- Passing a gate **baselines** the phase: its items and deliverables are
  frozen (`Baseline { phase, at, approvedBy, itemSnapshot }`).
- Editing a baselined item is an error whose fix is "open a
  change-request". A `change-request` item carries `impactAnalysis`
  (affected items, phases to reopen, estimated weight) and goes through
  `changeControl.approvers`. Approval reopens exactly the listed phases
  and creates a new baseline version; rejection records the reason.
- Backtracking without an approved CR is impossible by construction:
  the only reducer that reopens a phase is `approveChange`.

### Traceability

Every item of `traceability.from` type must `traces` to at least one
item of each `to` type before the verification gate; the
`traceability-matrix` evidence is generated by the engine
(`traceabilityMatrix(state)`) and attached automatically when complete.
Missing links are listed per requirement in the gate error.

### Ceremonies

`kickoff` (opens the next phase, verifies entry policies and that the
previous gate is baselined), `gateReview` (collects evidence, requires
approvals, baselines), `changeControlBoard` (decides pending
change-requests), `phaseRetrospective` (lessons, optional; does not alter
the current baseline).

### Rules

`phase-sequential`, `gate-before-next-phase`, `baseline-immutable`,
`change-needs-impact-analysis`, `requirement-traced`,
`deliverables-present`, `approver-not-author`.

### Metrics

phase completion %, schedule variance (budget planned vs spent per
phase), requirement coverage (traced / total), defects found per phase,
change-request count and approval rate, rework weight (items reopened by
CR).

---

## 11. Cross-cutting behaviour

### Budget as time

Iterations and phases carry a `Budget`. `complete()` adds the handoff's
accounting to `spent`. `next()` returns an empty dispatch set with reason
`budget-exhausted` when the remaining budget cannot cover the smallest
candidate (estimate: median tokens per weight from accounting, falling
back to config `defaultTokensPerWeight`).

### Brief synthesis

`next()` returns `Brief[]`:

```ts
interface Brief {
  item: WorkItem;
  role: Role;
  modelTier: Role["modelTier"];
  invariants: string[];       // methodology rules relevant to this item, in words
  do_not: string[];           // role.do_not + handoffs' do_not from upstream items
  acceptance: string[];
  upstream: Array<{ item: string; produced: Handoff["produced"]; notes: string }>;
  budgetRemaining: Budget;
  gateAhead?: Gate;
}
```

Everything the worker must know is inside the brief. The brief never
points at a file the worker is expected to go read for its constraints.

### Handoff and accounting

`complete(itemId, handoff, accounting)` is the only way out of
`in_progress`. `handoff.do_not` must exist. `accounting.model` is
required and is whatever the host actually used. Completion order is
free (unlike shiftwork's ordered clock-out) because the event log, not a
cursor, is the record; dependencies are enforced by the planner instead.

### Human gates

A gate with `"human"` in `requires` moves the item to `awaiting_human`
and appends to `state.pending`. `decide(pendingId, approve | reject,
by, note)` resolves it. The host (skill/MCP) is responsible for asking
the person; the engine only exposes `pending`.

### Escalation

A handoff with `verdict: "escalate"` creates a `question` item that
`dependsOn` nothing and blocks the original item. `question` items are
dispatched to a role with `escalate`; by default they do **not** stop
`next()` for unrelated items (the owner's standing rule: spawn a thinker,
keep cycling). The host may configure `escalation: "pause"` to stop.

### Lessons

Retro-type ceremonies append `Lesson { at, text, scope: "policy" |
"skill" | "memory", suggestedChange? }`. The engine stores them; the
host persists them to its memory system and may apply `policy` lessons
via the ceremony that allows it.

### Errors

Every thrown error is `WorkflowError { code, message, fix, items?,
rule? }`. Codes are a closed union exported from `ex-workflow/types`.
Nothing is silently ignored: an action that does nothing is an error
(`no-op`), a missing role is an error naming the capability and the
candidates. Messages are plain English; the L1 skill may translate.

---

## 12. Storage adapter

Core is pure. `ex-workflow/cli` and L1 use the file adapter:

```
.workflow/
  state.json          WorkflowState (single file, atomic write via temp + rename)
  roles/*.json        extra Role manifests merged at load
  briefs/<item>.json  last brief per item (for the worker to re-read after a crash)
  handoffs/<item>-<seq>.json
```

`load()` validates against the JSON Schema and refuses to run on a
version it does not know, naming the migration to run. Windows paths and
atomic rename are tested in CI (windows-latest runner).

---

## 13. CLI (`exwf`)

Thin. Each command maps to one core function and prints JSON (`--json`)
or a compact human table.

```
exwf init <scrum|kanban|waterfall> [--config file]
exwf add <item.json>            exwf edit <id> <patch.json>
exwf next [--max n]             -> briefs
exwf complete <id> <handoff.json> --tokens-in --tokens-out --duration-ms --model
exwf ceremony <name> [input.json]
exwf decide <pendingId> approve|reject --by --note
exwf board | status | metrics | pending | lessons
exwf validate                   -> rule violations without applying anything
exwf role add <manifest.json> | role list
```

Exit code 0 ok, 1 violation (JSON `Violation[]` on stdout), 2 usage.

---

## 14. Testing strategy

- Unit: every reducer and rule, table-driven, per methodology.
- Property: `metrics(state)` equals `metrics(replay(state.events))`.
- Property: planner never dispatches an item whose dependency is not
  `done`, never exceeds WIP or `resourceCaps`.
- Scenario fixtures: one full sprint, one kanban week with an expedite,
  one waterfall project with a change request; each asserts the event
  sequence and final metrics.
- Schema: generated JSON Schema validates every fixture; a fixture that
  violates a rule fails `validate`.
- Cross-platform CI: ubuntu, macos, windows. Size budget check in CI.

---

## 15. Relationship to the workflowAI repo

workflowAI (this repo) consumes `ex-workflow`:

- `skills/orchestrators/{scrum-master,kanban-flow,waterfall-pm}/` each
  ships `policy.json` (a methodology config) and `scripts/wf.js` (esbuild
  bundle of `ex-workflow/cli` + the three modules + ex-flow + exsorted).
- `skills/roles/*/SKILL.md` frontmatter carries a `role:` block that is a
  `Role` manifest; the build copies it into `reference/role.json`.
- `channels/claude-plugin` generates `agents/*.md` from role manifests.
- The orchestrator skill's loop is: `wf next` → dispatch each brief
  (subagent if the host can spawn, inline otherwise) → `wf complete` →
  repeat; ceremonies when `status` says one is due.

Spec for the skills and the channel build is a separate document.

---

## 16. Decisions log

| Decision | Choice | Why |
|---|---|---|
| Engine location | separate npm package `ex-workflow` | open-core artefact; L1 and L3 share it; ex-* family |
| v1.0 scope | all three methodologies | owner's call; core designed against all three from day one |
| Planner | ex-flow, kept pure; state in ex-workflow | existing, tested, owner's library |
| Roles | data with capabilities; methodologies reference capabilities only | domain packs and third-party roles |
| Completion ordering | free, event-log based | planner enforces dependencies; ordered clock-out was a shiftwork limitation |
| Escalation | non-blocking by default | owner's standing rule |
| Human gates | Waterfall all, Scrum sprint-review, Kanban none | matches each method's governance |
| Runtime | Node, zero deps beyond ex-flow/exsorted | present wherever agent CLIs run; Windows required |

## 17. Phase 1 implementation addenda (2026-10-19)

Decisions taken during implementation and the final whole-branch review; they refine sections 4, 6, 8, 11, 12 and 13 above.

| Topic | Decision |
|---|---|
| Rework | `Verdict` gains `rework`; the item returns to the stage of the last dispatch made from a stage strictly BEFORE its current one (`lastDispatchBefore(state, item)`), role cleared, evidence kept; the reviewer's notes reach the author through `Brief.priorHandoffs`. |
| Authorship | `authorOf(state, item)` is the role of the last dispatch made from an earlier stage (stage order, not equality), so a reviewer dispatched inside a gated stage is never the author and a rework round trip cannot resurface a stale dispatch. |
| Escalation | A `question` item (max priority) is created in the parent's pulled-from stage with the parent's `iteration`; the parent is re-queued with the question in `dependsOn`; answered questions bypass exit policies and gates; `closeSprint` carries open questions with their parents and `plan`/`commit` re-attach them. |
| Follow-ups and lessons | `Handoff.follow_ups` land in the first stage, never the iteration; `Handoff.lessons` are stored `raised`; the retro adopts/dismisses them and applies `LessonChange`s (`agreement` → `state.agreements`, present in every later brief's invariants; `dod`; `backlog`; `skill` for the host). |
| Bugs | `WorkItem.affects` names finished work a bug/change-request invalidates; `Brief.relatedBugs` surfaces open bugs touching an item or its dependencies. Done items are never reopened. |
| Stage advance | One shared `advanceItem` (items.ts) used by `complete` and `decide`; entering a non-terminal stage clears `role`; the review routing uses a `Stage.review` flag, never a stage id. |
| Blockers and gates | Gate rejection with `onFail: block` raises a real, clearable blocker; clearing a blocker on an `in_progress` item re-queues it in its pulled-from stage; clearing after `awaiting_human` restores `review`/`todo` per the stage flag. `decide` requires `human` or a role that satisfies the gate; the decision value is validated. |
| Sprint close | Carryover excludes `done` and `dropped`, clears blockers and pending entries of carried items with a "sprint closed" reason, strips `iteration` and `role`. Budget exhaustion with work still in progress sets `Iteration.closing` (no new dispatch) and closes on the last completion. |
| Ids | `assertId` in core: `^[A-Za-z0-9][A-Za-z0-9._-]*$`, no `..`, no prototype names; adapter asserts written paths stay under `.workflow/`; object lookups use `Object.hasOwn`. |
| Metrics | `costPerPoint` = Σ spent.tokens / Σ doneWeight over non-cancelled closed sprints. |
| Packaging | tsup `splitting: true` and a `check:dist` guard so core/scrum/cli share one `WorkflowError`; per-condition `types` for ESM and CJS; the file adapter is its own subpath `ex-workflow/adapters` (not in the core barrel); the executable is `src/cli/bin.ts`, separate from the `./cli` library entry. |
| Concurrency | The CLI serialises writers per `.workflow/` with `state.lock` (`open wx`, retry, stale after 60 s); one writer at a time. |
| Size | Budget is measured as `core+scrum` by bundling `scripts/measure-entry.ts`; target 40 KB; `size-budget.json` ratchets down only. |
| Tests | `scripts/run-tests.mjs` collects `*.test.ts` so Node 18/20 run the suite. |
| Out of Phase 1 | `ex-workflow/schema` JSON Schema and on-load schema validation; Kanban and Waterfall modules; `archive`; custom ceremonies as data. |

## 18. Phase 2 implementation addenda (Kanban)

Decisions taken while implementing §9; they refine §5, §7 and §9.

| Topic | Decision |
|---|---|
| Planner hooks | `PlannerOptions` gained `dispatchStage` as a per-item function, `priorityOf`, `tieBreaker`, `wipCounts`, `wipLimitOf`. Kanban uses them for: pull from the commitment column into the next column; expedite = max priority, intangible = min priority; tie-break by class rank then column age (FIFO by aging); blocked and awaiting_human cards hold WIP slots; expedite bypass = `wipLimit + wipBypass`. |
| WIP semantics | A column's `wipLimit` bounds its active cards (`in_progress`, `blocked`, `awaiting_human`). The engine's `complete()` advances a finished card into the next column's queue even when that column is at its limit; the queue is visible as `queued` in `board()` and in operations-review, and nothing new is pulled into a full column. The commitment column's queue is bounded at replenishment by `wip-respected` over all open cards. |
| Pull | Cards enter the board only through `replenishment` (Options → commitment column); the planner pulls everything after that. `pull-not-push` rejects any other entry through the cadence; direct `addItem` into a later column is unsupported. |
| Policies | A column's `policies` are its exit policies (checked when a card leaves); the delivery column may have none (`policy-explicit` exempts it). |
| Classes of service | Captured at commitment in the `cadence.replenishment` payload (class, deadline) so metrics per class derive from events; a card never replenished counts as `standard`. |
| One expedite | `candidates()` admits at most `maxExpedite − active expedites` expedite cards per `next()` call (oldest first); `one-expedite` refuses replenishing a second expedite while one is on the board. |
| Questions | Escalation questions are born in the column the parent was pulled from (the commitment column for cards pulled into the first work column; the review column for cards pulled in review) and are dispatched before everything, including expedites, but are excluded from lead time, throughput and SLE metrics. |
| Cadences | Each cadence is a ceremony emitting `cadence.<name>` with a structured payload; `cadencesDue(state)` counts `item.completed` events since the last one against `config.cadences.<name>.everyTurns`; `Methodology.report` surfaces it through `exwf status`. `service-delivery-review` keeps `state.stages` and `config.columns` / `config.classesOfService` in sync and records before/after. |
| Metrics clock | Open measurements (aging WIP, open blockers) are taken at the last event's time so `metrics(state)` stays a pure function of events. Cumulative flow counts distinct items that entered a column by the end of each day that has an event. |
| Blocker events | `blocker.raised` and `blocker.cleared` carry `transition: { from, to } \| null` (the status change they made, if any) so the event log alone reconstructs blocked time and re-queues; the Kanban replay applies it like an `item.transition` and never re-derives `clearBlocker`'s routing. |
| Class ordering | The planner priority is a class band times 1e15 plus an in-band offset. Bands: question 5, expedite 4, fixed-date 3, standard 2, intangible 1. Fixed-date: `1e10 - floor(deadline seconds)`, so the earliest deadline goes first. Other classes: `item.priority` clamped to +-1e9, plus, when `fairness.aging` is on, 4e9 per full window of `fairness.maxDeferralRounds` deferrals (default 5): `floor(deferrals / maxDeferralRounds) * 4e9`, so priority stays primary inside a window and a passed-over card is promoted one step per window. A deferral is a `planner.resolved` event after the card entered its column. Aging promotion: an intangible card deferred `maxDeferralRounds` times is scored in the standard band, so it overtakes fresh standard cards; with `aging: false` it goes only when nothing else is ready. Exact ties fall to class rank, column age, then id. |
| Commitment policies | The commitment column's `policies` stay its exit policy and are also mapped onto the next column's entry policy, so the planner refuses a pull that violates them. `plan()` and `next()` report every ready card they did not pull in `skipped: { id, reason: "entry-policy" \| "wip" \| "resource-cap" \| "budget", detail }[]`, also in the `planner.resolved` payload and the CLI `next` output; a pass that only skipped on an entry policy has `reason: "policy-blocked"`. `service-delivery-review` keeps the entry policy in sync. `question` cards are exempt from entry policies, as they are from exit policies and gates. |
| WIP bypass | `wipBypass` is the total number of extra slots a column grants while any expedite is active, not one per expedite. |
| Blocker re-queue | `clearBlocker` returns a card to the column it was pulled from with its column age reset (Phase 1 routing, accepted). |
| Out of Phase 2 | Waterfall module (shipped in Phase 3, see §19); `ex-workflow/schema`; queue limits per column; wall-clock cadence scheduling. |

## 19. Phase 3 implementation addenda (Waterfall)

Decisions taken while implementing §10; they refine §4, §5, §7, §10 and §11.

| Topic | Decision |
|---|---|
| Phase membership | `WorkItem.phase` names the phase; questions, follow-ups and any item with a `parent` inherit the parent's phase. Items never move between phases (`phase-sequential`); `change-request` and `question` items need none. The `item.added` payload carries `phase` and `parent` so metrics replay membership from events. |
| Stages | All phases share `work → review → done` (review by a role with `review`, never the author). The phase, not the stage, is governed: `candidates()` returns only the open phase's items. |
| Phase as iteration | `kickoff` opens an `Iteration` named `<phase>#<n>` with the phase's configured `budget`, so §11 budget-as-time, `Brief.budgetRemaining` and `budget-exhausted` apply unchanged; the gate closes it (`completed`), a suspension cancels it. `afterComplete` adds late-added items to it. With no accounting history the planner's estimate is 20000 tokens per weight unit; hosts pass `fallbackTokensPerWeight` for small phase budgets. |
| Deliverables | A deliverable is present when an item of the phase carries evidence of that kind or `Phase.produced` lists it (`gateReview` input `deliverables`, or engine-generated). `deliverables-present` also requires every item of the phase to be `done`. |
| Traceability | Keyed by **phase ids** (`traceability: { from, to }`), not `ItemType` (the core union has no requirement/design/test types; phase membership already classifies items). Links are read in both directions (`traces` on either item), so a frozen requirement is never edited to add a trace. Checked at each `to` phase's gate; the matrix deliverable is generated at the last `to` phase and recorded as `traceability.computed` plus a `phase.deliverable`. |
| Human gates | `humanGates` (default `"all"`) prepends `"human"` to the phase gate's `requires`. `gateReview` by an approver raises `PendingHuman { kind: "gate", gate }` without an item; the human's `decide` runs `Methodology.afterDecide`, which baselines (`approvedBy: [reviewer, "human"]`) or records `phase.gate-failed` and leaves the phase open. |
| Baselines | `state.baselines` keeps every baseline (per-phase `version` = count of earlier baselines of that phase + 1); `state.baseline` is the latest. `baseline-immutable` refuses `item.edit` / `item.add` on a baselined phase; the rule runs when the action goes through `applyAction` or the CLI (`exwf add` / `exwf edit` do). |
| Change control | `WorkItem.impactAnalysis { summary, reopen, weight }` with the existing `affects` for the touched items. `changeControlBoard` is the board's decision; when `changeControl.approvers` includes `"human"` it is a recommendation (`change.recommended`) and the human's `decide` decides. Approval reopens exactly the baselined phases listed (a listed open phase is left open; a listed pending phase is an error), **suspends** a later open phase (status `reopened`, iteration cancelled) so the earlier phase is reworked first, moves the change-request to `done` and emits `change.decided`; rejection drops it. Only this path reopens a phase. |
| Roles per phase | `phases[].deliverBy` names the delivering role (presets: requirements → business-analyst, design → architect, deployment → release-manager); the planner hook `PlannerOptions.roleFor` applies it to `todo` items. `business-analyst` holds `deliver` in addition to `define-acceptance`. A custom phase's default `name` is its id title-cased. |
| Authorship | `approver-not-author` refuses a gate review by a role that authored any item of the phase and a change decision by the role that raised the change-request. |
| Retrospective | `phaseRetrospective` records lessons (new ones `adopted`), adopts/dismisses raised ones and applies `agreement` changes; `dod`, `backlog` and `skill` changes are stored for the host and never alter a baseline. |
| Metrics | From events only: completion per phase (non-dropped items other than questions and change-requests), planned vs spent tokens per phase (`phase.opened` budget, `item.completed` tokens), requirement coverage from the latest `traceability.computed`, bugs per phase, change-request counts and approval rate, rework weight and phases reopened from `change.decided`. |
| Module layout | `src/waterfall/ceremonies.ts` holds kickoff, gateReview, changeControlBoard and `afterDecide`; the change reducers live in `change.ts` and the retrospective in `retro.ts`. |
| Out of Phase 3 | `ex-workflow/schema` and on-load schema validation; the L1 `scripts/wf.js` bundle (workflowAI repo); wall-clock phase scheduling; partial baselines. |

## 20. Phase 4 implementation addenda (`ex-workflow/schema`)

Decisions taken while implementing the §3 `ex-workflow/schema` entry and the §12 on-load validation; they refine §3, §12, §13 and §14.

| Topic | Decision |
|---|---|
| Source of truth | The TypeScript types are the schema. `scripts/gen-schema.mjs` runs `ts-json-schema-generator` (devDependency only) over `src/types.ts` and the three `config.ts` files and writes `src/schema/generated.ts`, which is committed. `pnpm schema:check` regenerates in memory and fails on any difference; it runs in `ci` and in the husky pre-commit gate, so types and schema cannot drift. Nothing is hand-written in a schema. |
| Documents | Seven JSON Schema (draft-07) documents, each self-contained (`$schema`, `$ref: "#/definitions/<Type>"`, `definitions`): `workflowStateSchema` (`WorkflowState`), `roleSchema` (`Role`, the manifest format), `newItemSchema` (`NewItem`, `exwf add` input), `handoffSchema` (`Handoff`, `exwf complete` input), `scrumConfigSchema`, `kanbanConfigSchema`, `waterfallConfigSchema` (the `policy.json` of §15). The four core documents share one `definitions` map. Objects are closed (`additionalProperties: false`) wherever the type has no index signature; `unknown` fields (`config`, `Event.payload`) are `{}`. |
| Validator | `ex-workflow/schema` ships its own validator for the subset the generator emits: `type`, `const`, `enum`, `properties`, `required`, `additionalProperties` (boolean or schema), `items`, `anyOf`, `$ref` into the document's own `definitions`, plus `minimum`, `maximum`, `minLength`, `pattern` for annotated fields; unknown keywords are ignored. No ajv: runtime dependencies stay exactly `ex-flow` and `exsorted`. `validate(schema, value)` returns every `SchemaError { path, message, expected, found }` with a JSON-pointer `path`; for `anyOf` it reports the branch with the fewest errors (a matching `const` discriminator wins). `assertValid(schema, value, what)` throws `WorkflowError("invalid-input")` naming `what`, the first path and its message, with the remaining count and a `fix`. |
| On load | `loadState()` checks `version` first (unchanged `state-version` error), then `assertValid(workflowStateSchema, …)` on the parsed file and `assertValid(roleSchema, …)` on each `roles/*.json` manifest before merging. A state that fails is never returned. |
| CLI inputs | `exwf add` validates against `newItemSchema`, `exwf complete` against `handoffSchema`, `exwf role add` against `roleSchema`, each before the engine sees the value; `exwf init --config` keeps the methodology's `validateConfig` (its messages name defaults and examples the schema cannot). The config schemas are for hosts and tooling (L1 `policy.json`, editors). |
| Layering | `src/adapters` and `src/cli` import from `src/schema`; core and the methodology modules never do. The entry is `ex-workflow/schema` (tsup entry `schema/index`, `exports` with per-condition `types`, `typesVersions`). `check-dist` asserts `assertValid` throws the core `WorkflowError` in ESM and CJS. |
| Size | New budget keys `dist/schema/index.mjs` and `schema` (the entry bundled alone, minified) seeded at measured size; `core+scrum`, `core+kanban`, `core+waterfall` and `dist/index.mjs` must not change. |
| Tests | The three scenario tests validate their final state after a JSON round trip (`JSON.parse(JSON.stringify(state))`, the form `loadState` sees); each methodology's default roles, config and `init()` state validate; negative fixtures (status outside the enum, missing required field, extra property, wrong `version`, bad `anyOf` branch) fail with the expected `path`; `schema:check` is the drift test. |
| On save (final review) | `saveState()` validates the serialised state against `workflowStateSchema` before the atomic write, so no command can write a state the loader refuses; the error surfaces on the command that produced it, naming the file and the JSON pointer. |
| More CLI inputs (final review) | `exwf edit` validates its patch against `itemPatchSchema` (`ItemPatch` moved to `types.ts` and generated with the core group); `exwf init --roles` validates every role in the file against `roleSchema` before `init` runs (this also replaced a raw `TypeError` on a role without `capabilities`). |
| anyOf reporting (final review) | When every `anyOf` branch fails and each carries a `const` error at the same pointer (a discriminator typo), the validator reports one `enum` error there listing the discriminator values; a `type` error at the branch root outranks a `const` error so a scalar never masks a discriminator. `validate(schema, value)` is two-arg on the public API. |
| Spent (final review) | `Iteration.spent` is the named `Spent` interface (all three budget fields required) so the generated schema is as strict as the type was. |
| Compatibility | Engine-written `state.json` from 0.1.0–0.3.0-stage loads unchanged (every field added since is optional). Newly refused: extra keys in `state.json` or an item (closed objects) and `roles/*.json` manifests that carry only an `id`. The in-suite drift test was dropped (the generator needs Node ≥ 22; the package floor stays Node ≥ 18); `pnpm schema:check` in `ci` and pre-commit guards drift. |
| Out of Phase 4 | Migrations for `version ≠ 1`; schemas for ceremony inputs (`CeremonyInput` is open); replacing `validateConfig` with the schema; `$id` URLs and publishing the JSON files outside the package; the L1 `scripts/wf.js` bundle. |

## 21. Phase 5 implementation addenda (engine gaps from the workflowAI dogfood)

Decisions for GitHub issues #8–#21 (label `engine-gap`), raised by the workflowAI scrum-master skill dogfood of 2026-10-23 against 0.4.0-stage. A read-only probe reproduced every issue on `main` before planning; the three findings it added are marked (probe). They refine §8, §11, §13 and §17.

| Issue | Topic | Decision |
|---|---|---|
| #8 | Config between iterations | Core `changeConfig(state, methodology, patch, by, now?)` (action `config.change`, rules run): refused while an iteration is open (`invalid-input`), refused for a key in `Methodology.lockedConfigKeys` (kanban: `columns`, `classesOfService` — use `service-delivery-review`; waterfall: `phases`, `traceability`, `humanGates` — fixed at init; the T03 review found `humanGates` is baked into each phase gate, so a stored change would be a lie), the merged config is re-validated by `validateConfig`, an unchanged result is `no-op`, and `config.changed { changed, before, after }` is recorded. `Methodology.afterConfigChange?(state, now)` lets Scrum keep the review stage's exit policy in step with `definitionOfDone`. CLI `exwf config set <patch.json> [--by]`. `sprint-budget-fixed` now names the command in its fix. |
| #9 | Zero accounting | `complete()` refuses `tokensIn + tokensOut === 0` (`accounting-invalid`) unless `Accounting.estimate: true` (CLI `--estimate`), which marks the line a placeholder; `estimateTokens` ignores placeholder lines. Core `correctAccounting(state, item, patch, by, now?, line?)` rewrites one of the item's lines (default the last), clears `estimate`, adjusts the owning iteration's `spent` (open or closed) and records `accounting.corrected { item, line, iteration, before, after, delta }`; a correction to 0 tokens is refused, an unchanged one is `no-op`. Scrum metrics add the corrections recorded after a sprint closed to that sprint's frozen `spent` (probe: `sprint.closed` carries the figures `metrics` reads). CLI `exwf account <item> [--line n] [--tokens-in n] [--tokens-out n] [--duration-ms n] [--model m]`. |
| #10 | Review-stage carryover | No new field (probe: the system transition that returned the item to the backlog already records where it was). `resumeStageOf(item)` reads the item's last transition: when it was made by `system` into `backlog/todo` from a `review` status, the item re-enters at that stage with status `review` on the next `plan` or `commit` (`sprint.opened` / `sprint.committed` payloads list `resumed`); `carryover-reestimated` exempts such items (the delivery is done, only the review is owed). (B22 widens #10: any status in a review-flagged stage, or a `review` status elsewhere.) |
| #11 | Same-value re-estimate | `editItem` keeps its `no-op` guard. `refine` gains `reestimate: string[]` (backlog items with a weight; else `invalid-input`), recording `item.reestimated { id, weight }` per id; `carryover-reestimated` accepts either an `item.edited` that changed `weight` or an `item.reestimated` after the sprint closed. |
| #12 | Agreements | Core `src/agreements.ts`: `applyAgreement(state, { text, replaces? }, by, now)` and `retireAgreement(state, text, by, now)`; `LessonChange { kind: "agreement", text, replaces?: string }` retires the agreement whose text matches `replaces` exactly (unknown text: `invalid-input` listing the current agreements) and records `agreement.retired { text, replacedBy }`. Scrum `retro` and Waterfall `phaseRetrospective` share the helper and accept `retire: string[]` (payload `retired`). Matching is by exact text, never by index. |
| #13 | Lesson attribution | Retro `lessons[]` entries accept `from` (`"human"` or a role id in `state.roles`, else `invalid-input`) and `item` (must exist); `from` defaults to `input.by`. |
| #14 | Open questions on done | `complete()` returns a `warning` `open-questions-ignored` (item, count, the questions, fix: escalate or answer them) when a `done` / `needs-review` handoff carries `open_questions`; `openQuestions(state)` lists the last such completion per item and `exwf status` prints it as `openQuestions`. |
| #15 | Mid-sprint metrics | `scrumMetrics` gains `current: { spentTokens, spentTurns, budgetTokens, committedWeight, doneWeight, remainingWeight, costPerPoint, budgetUtilisation }` for the open sprint (all zero when none is open); flat numbers so `Methodology.metrics`'s type is unchanged. |
| #16 | Turns budget | The planner gates on every budget dimension: `turns` (remaining minus the iteration's in-flight items, one per dispatch) and `wallclockMs`, not only `tokens`; a spent dimension skips each ready item with reason `budget` and returns `budget-exhausted`. An iteration in `closing` answers `budget-exhausted`, not `no-candidates`. `ScrumConfig.autoClose` (default `true`, the §8 behaviour) set to `false` leaves an exhausted sprint in `closing` until `review` or `cancel` closes it, so the human gate is never skipped. |
| #17 | Unblock | `clearBlocker` gains an optional `note` (in the `blocker.cleared` payload). CLI `exwf unblock <item> [--blocker id] [--note text] [--by who]` clears the named blocker or every open one (action `blocker.clear`, rules run). Auto-clearing on a follow-up's completion is out of Phase 5. |
| #18 | `plan auto` | `selectAuto` skips a candidate that fails the backlog exit policy (no acceptance, no estimate) or does not fit the remaining budget, keeps walking, and `sprint.opened` reports `skipped: [{ id, reason: "policy" \| "budget", detail }]`; an explicit `items` list keeps the hard refusal. |
| #19 | Question brief | `Brief.parent { item, role, notes, produced, open_questions, do_not }` from the parent's last completion when the item is a `question`; the parent's `do_not` merges into the brief's. `CompletedPayload` carries `open_questions`. |
| #20 | DoD at retro | `dod-not-weakened` also checks a retro between sprints: a `dodChanges` list that drops a current policy is an error unless `allowWeaken: true`. `dodChanges` replaces the whole Definition of Done; `suggestedChange { kind: "dod" }` appends one policy. Probe: with a sprint open the ceremony's own check fires first, so the rule's open-sprint branch is reachable only through `validateAction` / `exwf validate` (kept). |
| #21 | Per-call hosts | A calls budget is `sprintBudget.turns` (one per completion), made effective by #16; no `calls` key. `estimateTokens(state, weight, fallbackPerWeight, mode)` gains `mode: "per-weight" \| "per-call"` (median tokens per completion regardless of weight; fallback = `fallbackPerWeight` for one call). `ScrumConfig.estimateMode` (default `per-weight`) and `ScrumConfig.fallbackTokensPerWeight` (default 20000) feed `PlannerOptions.estimateMode` / `fallbackTokensPerWeight` and `selectAuto`; `PlanOptions.fallbackTokensPerWeight` still wins. CLI `exwf next --fallback-tokens-per-weight n`. |
| Events | New kinds: `config.changed`, `accounting.corrected`, `agreement.retired`, `item.reestimated`. `Event.type` stays a free string. |
| Schema | `Accounting.estimate`, `LessonChange.replaces`, `ScrumConfig.autoClose` / `estimateMode` / `fallbackTokensPerWeight` regenerate `src/schema/generated.ts` (`pnpm schema:gen`); every earlier `state.json` still loads (all new fields optional). |
| Size | Core and Scrum grow; budgets are set at measured size per the owner's standing decision and the deltas are recorded in `size-budget.json`'s note. Kanban and Waterfall move only by the shared core delta plus their `lockedConfigKeys`. |
| Version | 0.5.0-stage. |
| Out of Phase 5 | `complete()` does not run through `applyAction`, so the core `conflict-of-interest` rule never sees a completion (probe finding; recorded in the README backlog); auto-clearing blockers from follow-ups; `exwf validate` for ceremony inputs; retro-created lessons emit no `lesson.raised`. |

## 22. Phase 6 implementation addenda (backlog zero)

The 1.0 definition (owner, 2026-10-23) requires every README "Known backlog" item to be fixed or explicitly accepted as a documented limitation. Phase 6 does that for the 24 items listed at 7deccf0 (numbered B01–B24 in README order), after a read-only probe verified each against the code. Version 0.6.0-stage. No `state.json` schema change (the WaterfallConfig document gains one optional key) and no new event kind; `.workflow/state.json` files from every stage release load unchanged.

| # | Item | Decision |
|---|---|---|
| B01 | Stale-lock takeover race (> 60 s) | SPLIT: re-stat the lock (inode + mtime) immediately before `unlink` and abort the takeover if it changed; the residual race between stat and unlink is accepted and documented. |
| B02 | `complete()` bypasses `applyAction` | SPLIT: `conflict-of-interest` is already enforced by `checkGate` (error `gate-unmet`, unchanged). `complete()` now also runs the methodology's rules through `applyAction` with action type `item.complete` after validation, so rule hooks see completions. The `ErrorCode` member `"conflict-of-interest"` stays declared, documented as reserved (never thrown); removing it would narrow a public type. |
| B03 | Blockers not auto-cleared by follow-ups | ACCEPT: a blocker is owned by a human; clearing it needs a link from the follow-up to the blocker that the schema does not carry. `exwf unblock` is the path. |
| B04 | `closing` with `autoClose: false` not flagged | FIX: Scrum gains `report(state)` → `{ closing: boolean, sprint, reason, inFlight: string[] }` (`null` fields when no sprint); `exwf status.report` is no longer `null` for Scrum. |
| B05 | `decide(approve)` ignores `needs-review` | FIX: the gate approval derives the verdict from the item's last `item.completed` event and advances to the review stage for `needs-review`. |
| B06 | `setDod` hard-codes the `review` stage id | SPLIT: Scrum owns the stage ids `backlog`, `sprint`, `review` (about twenty uses); accepted and documented. An init-time check refuses a Scrum config whose stages lack any of them (`config-invalid`). |
| B07 | `closing` not enforced on commit/uncommit | SPLIT: rule `sprint-closing` refuses `ceremony.commit` into a closing sprint; `uncommit` during closing stays allowed (it only shrinks the sprint). |
| B08 | State written before briefs | FIX: the CLI writes briefs and handoff files first, then state. |
| B09 | `roles/*.json` re-merged on every load | ACCEPT: state wins on an id conflict and `exwf role add` is the audited path; re-merging is idempotent. |
| B10 | Evidence can go stale across rework | FIX (own commit, reversible): policies and gates count only evidence recorded by an `item.evidence` event after the item's last `item.rework` (event order). Semantic change, flagged to the owner. |
| B11 | Scrum stub size row | ACCEPT: budgets are set at measured size by the owner's standing decision; the row stays as a tripwire. |
| B12 | Kanban WIP bounds active cards; queued reported | ACCEPT: the engine must not refuse a card it advanced itself; operations-review surfaces queues. |
| B13 | Kanban `wipBypass` is a column total | ACCEPT: renaming or re-scoping the key after 1.0 breaks configs; documented. |
| B14 | Kanban cadences count turns | ACCEPT: the key is `everyTurns`; the engine has no clock; wall-clock schedules are the host's. |
| B15 | Minor test gaps | FIX: `writeAtomic` failure path, `decide` reject and unknown-pending cases, a usage exit-2 test per command. The retro duplicate-ref test already exists. |
| B16 | Waterfall traceability keyed by phase ids | ACCEPT: already recorded in §19; §10's `traceability` type line is corrected to phase ids. |
| B17 | Waterfall `editItem`/`addItem` bypass `baseline-immutable` when called directly | ACCEPT: the low-level primitives bypass rules in every methodology by design; `applyAction` and the CLI enforce them. |
| B18 | Phase budgets reuse `Iteration`; fallback needs `next()` option | SPLIT: `openIteration` naming accepted; `WaterfallConfig.fallbackTokensPerWeight` (optional) feeds the planner like Scrum's. The generated `WaterfallConfig` schema document gains the key (additive regeneration, as Scrum's `estimateMode` in Phase 5); `state.config` itself stays `unknown`. |
| B19 | Phase retrospective applies agreements only | ACCEPT: baselines and config are locked in Waterfall; `dod`/`backlog` changes are stored for the host. |
| B20 | `plan auto` honours turns only without tokens | FIX: `selectAuto` applies both limits. |
| B21 | Waterfall lessons lack `from`/`item` | FIX: per-lesson `from` and `item` honoured as in Scrum (default `from` = the retro's `by`). |
| B22 | Carryover at `awaiting_human`/`blocked` in review restarts | FIX: `resumeStageOf` resumes at review for any status in a stage whose `review` flag is set; signature extended with an optional `state` parameter. |
| B23 | `correctAccounting` with `endedAt` outside any sprint | ACCEPT: a line outside every sprint window has no sprint to charge. |
| B24 | Valueless flags parse as `"true"` | FIX: a value-taking flag given without a value is `invalid-input` naming the flag; `--estimate` is the only boolean flag. |

Out of Phase 6: a compatibility test loading `state.json` from every stage release, the API freeze and the 1.0 release itself (own job once the owner says the definition is met).

## 23. Phase 7 implementation addenda (1.0.0 release)

The owner's instruction of 2026-10-24: fix every open issue (#23–#27, label `engine-gap`, raised by the workflowAI S2 dogfood against 0.5.0-stage) and release 1.0.0 to `latest`. A read-only probe reproduced each issue on `main` (3118629) before planning. The remaining 1.0 clauses from §22 are closed in the same phase: a compatibility test over `state.json` files written by every stage release, an API-surface freeze test, size budgets re-recorded, a CHANGELOG with a migration note, and `latest` moved off the 0.1.0-stage placeholder.

| Issue | Topic | Decision |
|---|---|---|
| #23 | `traces` and `impactAnalysis.reopen` ids unchecked at add/edit | FIX: new Waterfall rule `trace-ids-valid` on `item.add` and `item.edit`: every `traces` id must name an existing, non-dropped item (`rule-violation`; the fix lists the ids of the `traceability.from` phase and of the `to` phases, i.e. the artefacts a trace may name); for a change-request, every `impactAnalysis.reopen` id must be a configured phase (fix: `phases are: …`). `changeControlBoard` keeps its own checks (an item may have been dropped since). Direct `addItem`/`editItem` stay unguarded (B17). |
| #24 | Change-request without impact analysis accepted at add | FIX: the `change-needs-impact-analysis` rule also runs on `item.add` and `item.edit` of a change-request: with `changeControl.requiresImpactAnalysis: true` a missing `impactAnalysis` is refused, and a present one is shape-checked (non-empty `summary`, `reopen: string[]`, finite `weight ≥ 0`) with the same fix text naming `{ summary, reopen, weight }`. The board-time check stays (it also validates `pending` phases on approve). |
| #25 | `status.report.coverage` counts change-requests; disagrees with `metrics` | FIX: `traceabilityMatrix` excludes `change-request` items on both sides (as it excludes `question`); `waterfallMetrics.requirementsTraced` / `requirementsTotal` / `requirementCoverage` are read from `traceabilityMatrix(state)` (live, one shared computation) instead of the last `traceability.computed` event; the event stays as the gate's audit record. A link counts whatever the linked item's status is (coverage is about links; readiness is about status). |
| #26 | `readyForGate` never true on a traceability `to` phase | FIX: `phaseReport` mirrors the gate rules: for a phase in `traceability.to` the row gains `missingTraces: string[]` (`missingTraces(state, phase)`; `[]` elsewhere), and `traceability-matrix` counts as present for the last `to` phase when `missingTraces` is empty (the gate generates it). `readyForGate` is true exactly when `gateReview` would pass `deliverables-present` and `requirement-traced`. `PhaseReportRow` gains the one optional-free field `missingTraces` (always present). |
| #27 | Kanban cannot adopt or dismiss lessons | FIX: `service-delivery-review` accepts `lessons[]`, `adopt[]`, `dismiss[]` and `retire[]` with the Scrum retro semantics for `agreement` changes (`applyAgreement` / `retireAgreement`); `dod`, `backlog` and `skill` suggestions are stored on the lesson for the host (as Waterfall's phase retrospective does). The validation and the lesson bookkeeping move to a core helper (`src/lessons.ts`: `parseLessonInput`, `applyLessonInput`) shared by the Scrum retro, the Waterfall phase retrospective and the Kanban review; Scrum keeps its `dod`/`backlog` application through the helper's `applyChange` callback. Side effect, accepted: the Scrum retro now shares the helper's shape checks, so a malformed `lessons[]`, `adopt[]` or `dismiss[]` entry is refused `invalid-input` where it was silently accepted (or threw a TypeError) before; valid inputs, payloads and messages are unchanged. The `cadence.service-delivery-review` payload gains `lessons`, `adopted`, `dismissed`, `agreements`, `retired` (additive). No new event kind. |
| 1.0-a | Compatibility | `test/compat.test.ts` loads every fixture under `test/fixtures/compat/<version>/<methodology>/state.json` through `loadState` (schema validation included) and runs `status`, `metrics` and `brief`-free `next` planning on it. Fixtures are written by the published CLI of 0.1.0-stage (scrum), 0.2.0-stage (+ kanban), 0.3.0-stage (+ waterfall), 0.4.0-stage and 0.6.0-stage (0.5.0-stage was never published; its changes ship in 0.6.0-stage) via `scripts/gen-compat-fixtures.mjs` (installs each version into a temp dir; network needed only to regenerate). A fixture that fails to load is a 1.0 bug, fixed in the loader, never by editing the fixture. |
| 1.0-b | API freeze | `test/api-surface.test.ts` compares the runtime export names of each entry (`.`, `./scrum`, `./kanban`, `./waterfall`, `./schema`), the `USAGE` lines, the schema document names and the event kinds (string literals passed to `appendEvent` in `src`, test files excluded) against the committed `test/api-surface.json`; a drift fails the test. After 1.0.0 a removal is a major version, an addition is a minor one and updates the file. |
| 1.0-c | Version and tags | `1.0.0` in `package.json` and `VERSION`; `npm publish` without a tag moves `latest` to 1.0.0; the `stage` tag stays on 0.6.0-stage. README: Install resolves to 1.0.0, the Publishing section drops the `stage` instruction, Status names 1.0.0. CHANGELOG `## 1.0.0 (2026-10-24)` with a Migration paragraph (from any 0.N.0-stage: states load unchanged; behaviour changes of 0.5.0 and 0.6.0 apply; the new Waterfall add-time refusals (#23, #24) and the `coverage` recount (#25) are the only new observable changes). Size budgets re-recorded at measured size. |

Out of Phase 7: Kanban `backlog` lesson changes creating cards (the host adds them through `replenishment`); a Scrum-style `dod` in Kanban (Kanban has no Definition of Done; exit policies are edited by the same review).

## 24. Phase 8 implementation addenda (1.1.0: Investigation #37 and Experimentation #38)

Date: 2026-10-28. Released as 1.1.0 (tag `v1.1.0`, npm `latest`).

User-approved direction: ship two new methodologies, `investigation` (#37) and
`experimentation` (#38), rather than extensions to Scrum, Kanban or Waterfall.
The research reports in `docs/research/` are the input; the owner's
standalone-methodology decision supersedes their composition recommendation.

### Scope and architecture

Each methodology owns its factory, validated config, default roles and stages,
rules, ceremonies, serializable lifecycle record, report and metrics. Both use
the existing item/brief/handoff/accounting/planner contracts. Pure functions only:
the host executes commands, provisions isolation, captures immutable artifacts
and authenticates reviewers. Engine validation checks structured records and
provenance linkage; a ref alone cannot prove external artifact contents.

Investigation bounds an intake, registers falsifiable competing hypotheses,
preregisters discriminating experiments, records observations and belief updates,
and requires independent review before resolving a conclusion. Inconclusive and
stopped outcomes are first-class; rounds and accounting are bounded.

Experimentation freezes a shared base and harness, tracks separate candidate
attempts and workspace identities, records terminal failures/timeouts, requires
independent validation at the submitted SHA, compares eligible candidates under
preregistered ranking, and guards integration with fresh validation at the
integration SHA. All-fail produces no winner. Host resource cleanup is reported,
never performed implicitly by core.

### Implementation plan and verification

Execution shape: independent methodology modules, then sequential shared package
integration and final review. Each task is test → implement → spec review →
code-quality review. No unrelated cleanup or new runtime dependencies.

- [x] Investigation: write failing colocated lifecycle/invalid-transition tests;
  implement `src/investigation/{config,state,roles,stages,ceremonies,index}.ts`
  (split rules/metrics if needed); run the focused tests; review against #37 and
  existing pure-state, capability-based authorization and actionable-error patterns.
- [x] Experimentation: write failing colocated lifecycle/provenance/timeout tests;
  implement `src/experimentation/{config,state,roles,stages,ceremonies,index}.ts`
  (split rules/metrics if needed); run focused tests; review against #38, exact-SHA
  promotion and all-fail/no-winner requirements.
- [x] Package integration: extend `MethodologyName` and optional lifecycle state
  fields in `src/types.ts`; add CLI factories, package exports/typesVersions and
  tsup entries; generate both config schemas and lifecycle state schemas via
  `scripts/gen-schema.mjs`; extend the API snapshot additively. Test CLI init,
  save/load and ceremony dispatch for both new names, and keep old fixtures valid.
- [x] Documentation and final verification: add runnable end-to-end SDK examples
  and host boundaries to README, record additions in CHANGELOG; run `pnpm run ci`;
  inspect schema/API/size diffs, review spec compliance then code quality. Final
  verification: 372 tests and both executable examples pass. Independent SDD
  review findings closed. Optional planner `reservedTokens` preserves existing
  dispatch behavior when omitted and accounts for in-flight experiment estimates. New
  entry budgets must be measured; existing entry budgets must not be loosened
  without explaining a measured additive cost.

### Out of scope

Cross-methodology composition or integration, automatic git/worktree/process
execution, sandbox provisioning, LLM calls, automatic merge/publish, and claims
that illustrative research pilots establish measured effectiveness.

