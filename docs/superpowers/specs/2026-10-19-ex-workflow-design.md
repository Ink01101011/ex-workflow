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
  traceability: { from: ItemType; to: ItemType[] };    // default requirement -> design, test
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
