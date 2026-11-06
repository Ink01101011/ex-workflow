# ex-workflow

**Methodology engine for AI agent teams.** Scrum, Kanban, Waterfall, Investigation and Experimentation as data-driven state machines in TypeScript: the engine decides which item may move, who may approve and whether an iteration may close; your agents only do the work.

[![npm](https://img.shields.io/npm/v/ex-workflow)](https://www.npmjs.com/package/ex-workflow) [![license](https://img.shields.io/npm/l/ex-workflow)](LICENSE) Node >= 18 · macOS, Linux, Windows · ESM + CommonJS · no I/O in core

- State is plain JSON. Every operation is `(state, action) -> state`.
- Every error names the rule, the item and a concrete fix.
- Two runtime dependencies: [`ex-flow`](https://www.npmjs.com/package/ex-flow) (DAG planner) and [`exsorted`](https://www.npmjs.com/package/exsorted).
- Works with any LLM host: the engine hands out **briefs**, you run them with your agents and hand back **handoffs**.
- The invariants the engine enforces, each with the file and the test behind it: [docs/principles.md](docs/principles.md).

## Contents

1. [Pick a methodology](#pick-a-methodology)
2. [How a run works](#how-a-run-works)
3. [Quick start: Scrum](#quick-start-scrum)
4. [Quick start: Kanban](#quick-start-kanban)
5. [Quick start: Waterfall](#quick-start-waterfall)
6. [Standalone investigation and experimentation](#standalone-investigation-and-experimentation)
7. [Persisting state](#persisting-state)
8. [Custom methodologies and extension state](#custom-methodologies-and-extension-state)
9. [Composable policies](#composable-policies)
10. [CLI reference (`exwf`)](#cli-reference-exwf)
11. [Configuration](#configuration)
12. [Ceremonies](#ceremonies)
13. [Items, briefs, handoffs, accounting](#items-briefs-handoffs-accounting)
14. [Errors](#errors)
15. [JSON Schema](#json-schema)
16. [Package entry points](#package-entry-points)
17. [Compatibility and versioning](#compatibility-and-versioning)
18. [Known limitations](#known-limitations)
19. [Contributing](#contributing)
20. [License](#license)

## Pick a methodology

| | Scrum (`ex-workflow/scrum`) | Kanban (`ex-workflow/kanban`) | Waterfall (`ex-workflow/waterfall`) | Investigation (`ex-workflow/investigation`) | Experimentation (`ex-workflow/experimentation`) |
|---|---|---|---|---|---|
| Fits | a goal delivered in budgeted sprints | a continuous flow of requests | a phase-gated project with a frozen baseline | one bounded question answered from preregistered experiments | competing candidates compared against a frozen baseline and harness |
| Unit of control | sprint budget (tokens, turns, wall-clock) | WIP limits per column, classes of service | human-approved gate per phase | round limit and budget, independent replay and conclusion review | concurrency cap, per-candidate and total budgets, independent validation at the exact SHA |
| Flow | backlog → sprint → review | options → ready → dev → review → done | work → review → done, inside each phase | intake → execute → observed | candidate → building → validation → done |
| Preset roles | product-owner, scrum-master, developer | service-request-manager, service-delivery-manager, worker | project-manager, business-analyst, architect, developer, qa, release-manager | investigator, replay-worker, conclusion-reviewer | coordinator, builder, validator, integrator |
| Ceremonies | refine, plan, commit, uncommit, daily, review, retro, cancel | replenishment, delivery-planning, service-delivery-review, operations-review, risk-review, strategy-review | kickoff, gateReview, changeControlBoard, phaseRetrospective | intake, hypotheses, preregister, observe, update-belief, conclude, review-conclusion, stop | freeze, provision, start, submit, validate, compare, integrate, validate-integration, terminate, stop, cleanup |
| Metrics | velocity, cost per point, budget utilisation | lead and cycle time, throughput, WIP, flow efficiency, aging, CFD, SLE compliance | phase report, requirement coverage, traceability matrix | rounds, valid and invalid runs | candidates by outcome, spent, tokens per candidate |

All five share one core: the same item model, the same brief and handoff contracts, the same CLI and the same `.workflow/` files. Roles are data (capabilities, not names), so you can replace or extend the presets with `exwf role add`. [Investigation and Experimentation](#standalone-investigation-and-experimentation) each run alone, in their own `.workflow/`.

## How a run works

```
 addItem ──▶ next() ──▶ Brief per item ──▶ your agent ──▶ Handoff + Accounting ──▶ complete()
                ▲                                                                    │
                └──────────── ceremonies, decide(), unblock ─────────────────────────┘
```

1. **Add items** with acceptance criteria. Rules check them at add time.
2. **`next()`** asks the planner which items may be dispatched now (dependencies, WIP, policies, budget, roles) and returns one brief per item: the item, its acceptance, the invariants in force, upstream results, prior attempts and what not to do.
3. **Run each brief** with whatever agent or model you like. The engine never calls an LLM.
4. **`complete()`** records the handoff (what was produced, verdict, follow-ups, lessons) and the accounting (tokens, duration, model). Policies and gates decide whether the item advances, needs review, is blocked or is reworked.
5. **Ceremonies** move the iteration: plan and review a sprint, replenish a board, open and gate a phase. Anything that needs a human lands in `pending`, and `decide()` resolves it.

## Quick start: Scrum

```ts
import { init, addItem, next, complete } from "ex-workflow";
import { scrum } from "ex-workflow/scrum";

const m = scrum();
const config = {
  sprintBudget: { tokens: 300_000 },
  productGoal: "ship the checkout",
  definitionOfDone: [{ kind: "evidence", evidenceKind: "test-output" }],
};
let state = init({ methodology: m, config }).state;
state = addItem(state, { id: "CART", title: "cart API", weight: 3, priority: 5, acceptance: ["add/remove items"] }, "product-owner");
state = m.ceremonies["plan"]!(state, { by: "scrum-master", goal: "customers can pay", items: "auto" }).state;

const { state: s2, briefs } = next(state, m); // one brief per dispatched item
// run each brief with your agent, then:
// state = complete(s2, m, handoff, accounting).state;
// state = m.ceremonies["review"]!(state, { by: "human", accepted: true, goalMet: true }).state;
```

The sprint closes when its budget is spent and nothing is in flight (`autoClose`), or through `review` / `cancel`. `retro` turns lessons into working agreements that every later brief carries.

## Quick start: Kanban

```ts
import { init, addItem, next, complete } from "ex-workflow";
import { kanban, board, kanbanMetrics } from "ex-workflow/kanban";

const m = kanban(); // options → ready (commitment point, WIP 4) → dev (WIP 3) → review (WIP 2) → done
let state = init({
  methodology: m,
  config: { classesOfService: { standard: { sle: { percentile: 85, targetMs: 7 * 86_400_000 } } } },
}).state;
state = addItem(state, { id: "SEARCH", title: "search box", acceptance: ["finds by name"] }, "service-request-manager");
state = m.ceremonies["replenishment"]!(state, { by: "service-request-manager", items: ["SEARCH"] }).state; // the only push

const { state: s2, briefs, skipped } = next(state, m); // pulls ready → dev within WIP; expedite jumps the queue
board(s2, new Date().toISOString()); // columns, active/queued counts, card ages
kanbanMetrics(s2);                   // lead time, cycle time per column, throughput, WIP, flow efficiency, SLE compliance
```

`skipped` lists every ready card the planner did not pull, with a `reason` (`entry-policy`, `wip`, `resource-cap`, `budget`) and a `detail`. Ordering is by class (expedite, fixed-date, standard, intangible), then priority; with `fairness.aging` on (default) a card passed over for `fairness.maxDeferralRounds` passes (default 5) is promoted, so nothing starves.

## Quick start: Waterfall

```ts
import { init, addItem, applyAction, next, complete, decide } from "ex-workflow";
import { waterfall } from "ex-workflow/waterfall";

const m = waterfall(); // requirements → design → implementation → verification → deployment → maintenance
let { state } = init({ methodology: m, config: {} });
const r1 = { id: "R1", title: "login", phase: "requirements", acceptance: ["user can log in"] };
state = applyAction(state, m, { type: "item.add", by: "business-analyst", payload: { item: r1 } }, (s) =>
  addItem(s, r1, "business-analyst"),
).state;
state = m.ceremonies["kickoff"]!(state, { by: "project-manager", phase: "requirements" }).state;
// next() → complete() as usual; items go work → review → done
state = m.ceremonies["gateReview"]!(state, { by: "project-manager", phase: "requirements" }).state; // raises a pending decision
state = decide(state, state.pending[0]!.id, "approve", "human", "ok", undefined, m);                 // baselines the phase
```

Phases open one at a time (`kickoff`) and close through a gate (`gateReview`), human-approved by default. An approved gate **baselines** the phase: its items are frozen and can only change through an approved change-request (`changeControlBoard`, with an impact analysis). Requirements must trace to design and verification items before those gates close; the engine generates the `traceability-matrix` deliverable. Default deliverables per phase: `srs`; `design-doc`, `interface-spec`; `code-baseline`; `test-report`, `traceability-matrix`; `release-notes`, `deployment-record`; `change-log`.

## Standalone investigation and experimentation

**Investigation** runs an evidence-driven inquiry: one bounded question, competing falsifiable hypotheses, preregistered experiments, recorded observations, belief updates and an independent review before a conclusion is resolved. **Experimentation** compares isolated candidates against a frozen baseline and harness: independent validation at the exact submitted SHA, deterministic selection, and fresh validation of the integration SHA. Each runs in its own `.workflow/` state; neither nests inside, migrates into or coordinates Scrum, Kanban, Waterfall or the other. The host executes procedures, provisions workspaces, runs benchmarks and performs Git operations; the engine records and validates the resulting artifacts (see [Known limitations](#known-limitations)).

Run the complete synthetic SDK examples from this repository:

```sh
pnpm exec tsx scripts/example-investigation.ts
pnpm exec tsx scripts/example-experimentation.ts
```

[Investigation example](scripts/example-investigation.ts) exercises execution, observation, rejected review, independent replay and a resolved conclusion. [Experimentation example](scripts/example-experimentation.ts) compares two candidates (one nonreproducible), records exact-SHA integration, validates it afresh and cleans up. Both use explicitly synthetic in-memory host outputs and assert their final outcomes; they do not execute procedures, benchmarks, Git or filesystem operations.

### Investigation

```ts
import { init } from "ex-workflow";
import { investigation } from "ex-workflow/investigation";

const m = investigation();
let { state } = init({ methodology: m, config: {
  question: "Why do repeated requests miss the cache?",
  maxRounds: 3, budget: { tokens: 100_000, turns: 20 },
} });
state = m.ceremonies["intake"]!(state, { by: "investigator", item: "CACHE" }).state;
state = m.ceremonies["hypotheses"]!(state, { by: "investigator", hypotheses: [
  { id: "key", claim: "Keys differ", falsifiedBy: "Identical keys" },
  { id: "expiry", claim: "Entries expire", falsifiedBy: "Live entries" },
] }).state;
```

Roles: `investigator` (intake, hypotheses, preregistration, observation, belief update, conclusion), `replay-worker` (executes a replay when the investigator ran the original), `conclusion-reviewer` (approves or rejects a conclusion; may not have executed any run). Stages: `intake` → `execute` → `observed`. Each preregistered experiment is an item: `next()` briefs the executor and `complete()` records `experiment-output` evidence before `observe`. A `resolved` conclusion needs a supported hypothesis, valid supporting evidence, a valid replay and an independent review; `inconclusive` and `stopped` are first-class outcomes. Config keys: [Configuration](#investigation-investigationconfig). Ceremonies and their inputs: [Ceremonies](#ceremonies).

### Experimentation

```ts
import { init, addItem } from "ex-workflow";
import { experimentation } from "ex-workflow/experimentation";

const m = experimentation();
let { state } = init({ methodology: m, config: {
  objective: "Lowest median latency", direction: "minimize", tieBreak: "candidate-id",
  concurrencyCap: 2, maxCandidates: 4,
  candidateBudget: { turns: 10 }, totalBudget: { turns: 40 },
} });
state = addItem(state, { id: "A", title: "Candidate A", acceptance: ["Pass frozen benchmark"] }, "coordinator");
state = m.ceremonies["freeze"]!(state, { by: "coordinator", baseSha: "a".repeat(40),
  harness: "bench-v1", candidates: [{ id: "a", item: "A", author: "builder" }],
}).state;
state = m.ceremonies["provision"]!(state, { by: "coordinator", candidate: "a", workspace: "/worktrees/a", baseSha: "a".repeat(40), isolated: true }).state;
```

Roles: `coordinator` (freeze, provision, compare, terminate, stop, cleanup), `builder` (start, submit), `validator` (validate, validate-integration), `integrator` (integrate). Stages: `candidate` → `building` → `validation` (gate `experiment-validation`) → `done`. Every candidate is an item dispatched to its author at `building`; `next()` admits at most `concurrencyCap` running candidates and reserves the tokens of in-flight work. Comparison ranks eligible validated candidates by score, then candidate id; when none is eligible the run stops without a winner. Config keys: [Configuration](#experimentation-experimentationconfig). Ceremonies and their inputs: [Ceremonies](#ceremonies).

### CLI

`exwf init investigation --config investigation.json` or `exwf init experimentation --config experimentation.json`, then the same `ceremony`, `next`, `complete`, `status`, `metrics` and persistence commands. A ceremony input file holds the object documented under [Ceremonies](#ceremonies); pass the role with `--by`.

## Persisting state

Core performs no I/O. The file adapter is the only part that touches disk, and the CLI is built on it.

```ts
import { loadState, saveState, withStateLock } from "ex-workflow/adapters";

await withStateLock(process.cwd(), async () => {
  const state = await loadState(process.cwd());
  await saveState(process.cwd(), complete(state, m, handoff, accounting).state);
});
```

Layout under the project root:

```
.workflow/
  state.json              the whole state (validated on load and before every write)
  briefs/<id>.json        written by `next`
  handoffs/<id>-<n>.json  written by `complete`
  state.lock              one writer at a time
```

The lock is created exclusively, retried for about two seconds and taken over when older than 60 s. Read-only commands do not lock. If a crashed process left a lock behind and a command reports that another `exwf` holds it, delete the file.

## Custom methodologies and extension state

`Methodology` and `WorkflowState` take the methodology name as an optional second type parameter. It defaults to the five built-in names, so code written for the built-ins type-checks unchanged; a custom methodology declares its own name and runs on the same core:

```ts
import { init, next, complete, type Methodology } from "ex-workflow";

function triage(): Methodology<TriageConfig, "triage"> {
  return { name: "triage", /* vocabulary, stages, roles, ceremonies, rules, metrics, ... */ };
}
let { state } = init({ methodology: triage(), config: { queue: "support" } }); // WorkflowState<"triage">
```

`ex-workflow/registry` maps names to factories, with the five built-ins pre-registered. Use it to resolve a loaded state's `methodology`, or to register your own:

```ts
import { methodologyFactory, registerMethodology, registeredMethodologies } from "ex-workflow/registry";

const m = methodologyFactory(state.methodology)(); // unknown name: invalid-input, the fix lists the known names
registerMethodology("triage", triage); // calls triage() once to check it; a taken name or a non-Methodology result: invalid-input
registeredMethodologies(); // ["scrum", "kanban", "waterfall", "investigation", "experimentation", "triage"]
```

The registry is its own entry so that importing core plus one methodology does not pull in the other four. Custom methodologies are SDK-only in 1.2: `exwf init <name>` resolves through the same registry, but the `exwf` binary cannot load third-party modules, and the file adapter only accepts the five built-in names (see [Known limitations](#known-limitations)).

A methodology keeps its own record in `state.ext`, keyed by its name, and reads and writes it only through the accessors:

```ts
import { readExt, writeExt } from "ex-workflow";

const queue = readExt<string[]>(state, "triage") ?? [];
state = writeExt(state, "triage", [...queue, "T-1"]); // returns a new state; undefined removes the key
```

Investigation and Experimentation store their record under `ext.investigation` / `ext.experimentation` and mirror it to the deprecated top-level `state.investigation` / `state.experimentation` in memory, so SDK code that reads those fields keeps working. On disk only `ext` is stored: `saveState` leaves the mirror out and `loadState` sets it back to the same record (if a hand-edited `state.json` carries both, `ext` wins). The mirrors are read-only: once `ext.<name>` exists the engine reads only it, and a write to the legacy field is ignored; write through `writeExt`. `readExt(state, "investigation")` (or `"experimentation"`) is typed, and on a state written before 1.2, which has no `ext`, it reads the legacy field.

## Composable policies

`ex-workflow/policies` holds policies you opt into per run by wrapping a methodology. A wrapped methodology keeps every other member, its `name` included, so it runs on the same core and its state persists through the file adapter like the plain one's. The policies are SDK-only: `exwf` runs the plain built-in factory (see [Known limitations](#known-limitations)).

### Risk-adaptive gates

A gate's requirements are static: the same approval for a typo fix and a production change. `withRiskGate` lets the item's recorded risk add to them, never take away:

```ts
import { addItem, complete, decide, init, next } from "ex-workflow";
import { kanban } from "ex-workflow/kanban";
import { recordRiskAssessment, withRiskGate } from "ex-workflow/policies";

const m = withRiskGate(kanban(), { gates: ["code-review"] }); // only these gate ids escalate
// ... init with a review stage carrying gate { id: "code-review", requires: [{ capability: "review" }], ... }

// after the work, an independent role with capability verify (or "human") assesses the item
state = recordRiskAssessment(state, m, {
  item: "CART-12",
  level: "high", // "low" | "medium" | "high" | "critical"
  factors: ["prod-infra", "secrets"], // free strings
  ref: "risk/CART-12.md", // the host's assessment artifact
  subject: "3f2c1e0", // optional: the SHA or ref assessed
  by: "risk-reviewer",
}).state;

// the reviewer completes as usual: low passes on the static gate, high raises a human pending
const done = complete(state, m, handoff, accounting);
```

- **The assessment** is evidence `risk-assessment` with `data: { level, factors, subject? }`, recorded through `applyAction` (action `risk.assess`, so your rules see it). `recordRiskAssessment` refuses `invalid-input` for an unknown key or level, a non-string factor, an empty `ref`, an assessor that is neither `human` nor a role with capability `verify`, and an assessor that is the item's author or assigned role.
- **Which assessment counts:** only fresh ones (recorded after the item's last rework), with well-formed `data`, by a qualified and independent assessor (re-checked when the gate is resolved). The strictest one wins, so a later, lower assessment does not relax an earlier one; only rework does. With none, the level is `critical`.
- **The table** says what each level adds to the static gate. `DEFAULT_RISK_TABLE`:

  | Level | Adds |
  |---|---|
  | `low`, `medium` | nothing |
  | `high`, `critical` | `"human"` |

  Pass your own as `withRiskGate(m, { gates, table })`: every level needs a row `{ requires: GateRequirement[]; evidence?: string[] }`, e.g. `medium: { requires: [{ capability: "security-review" }], evidence: ["sbom"] }`. Invalid options fail `invalid-input` when you wrap.
- **`gate.resolved`**: on a gated completion, `complete()` appends `gate.resolved { item, gate, requires, evidence, reason }` before `gate.passed` or `pending.raised`, with the requirements actually checked and `reason: { level, why, assessment, by }` (`why` is `assessed`, `missing`, `invalid` or `not-independent`). A gate the policy does not name records the static gate with `reason: {}`.
- **`decide`** judges a pending gate against the last `gate.resolved` of that item and gate, so a role cannot approve an escalation to a human, also through `exwf decide`.
- **Any methodology** may implement the hook itself: `Methodology.escalateGate(state, item, gate)` returns `{ requires, evidence, reason }` or `undefined`. Core only appends what it returns to the static gate, so a hook can tighten a gate but never loosen it. `withRiskGate` keeps an existing hook and widens with both.
- `riskEscalation(state, item, gate, options)` is the resolver on its own, for hosts that want the answer without wrapping.

## CLI reference (`exwf`)

Run from the directory that holds `.workflow/`. Every command prints JSON on stdout. Exit 0 = ok, exit 1 = `{ ok: false, error }`, exit 2 = usage. `--by` defaults to `human`. Flags take `--flag value` (not `--flag=value`); a value that starts with `--` must come through a JSON input file.

| Command | Returns |
|---|---|
| `init <scrum\|kanban\|waterfall\|investigation\|experimentation> --config <file> [--roles <file>]` | `{ ok, state: { methodology, stages, roles } }` |
| `add <item.json> [--by who]` | `{ ok, warnings, item }`, checked by the methodology rules |
| `edit <id> <patch.json> [--by who]` | `{ ok, warnings, item }` |
| `next [--max n] [--fallback-tokens-per-weight n]` | `{ ok, reason, skipped, briefs }`; writes `.workflow/briefs/<id>.json`. `--max` caps the briefs returned; the fallback prices a candidate with no accounting history (default 20000 tokens per weight unit) |
| `complete <id> <handoff.json> --tokens-in n --tokens-out n --duration-ms n --model m [--role r] [--estimate]` | `{ ok, item, warnings }`. Zero tokens is refused unless `--estimate` marks the line as a placeholder |
| `account <item> [--line n] [--tokens-in n] [--tokens-out n] [--duration-ms n] [--model m] [--by who]` | `{ ok, line, event }`: corrects one accounting line (the last by default) and clears the placeholder flag |
| `ceremony <name> [input.json] [--by who]` | `{ ok, warnings, lastEvent }` |
| `decide <pendingId> approve\|reject [--by who] [--note text]` | `{ ok, item }`; runs the methodology's after-decide hook (a Waterfall gate approval baselines the phase) |
| `config set <patch.json> [--by who]` | `{ ok, warnings, changed, config }`: shallow-merges a patch between iterations; refused while an iteration is open and for locked keys |
| `unblock <item> [--blocker id] [--note text] [--by who]` | `{ ok, warnings, item }`: clears one open blocker, or all |
| `status` | `{ ok, methodology, openIteration, counts, pending, openQuestions, lastEvent, report }`; `report` is methodology-specific (Scrum: closing sprint; Kanban: cadences due; Waterfall: phases, pending gates, coverage) |
| `board` | `{ ok, columns }` |
| `metrics` | `{ ok, metrics }` |
| `pending` / `lessons` | the arrays |
| `validate <action.json>` | `{ ok: true, violations }`, a dry run of the rules |
| `role add <manifest.json>` / `role list` | `{ ok, roles }` |

## Configuration

### Scrum (`ScrumConfig`)

| Key | Meaning |
|---|---|
| `sprintBudget` | `{ tokens?, turns?, wallclockMs? }`, at least one. `turns` counts one per completion. The planner gates on every dimension set |
| `productGoal` | the goal every sprint serves |
| `definitionOfDone` | policies an item must meet to be done, e.g. `{ kind: "evidence", evidenceKind: "test-output" }` |
| `refinementSharePct`, `allowMidSprintAdd` (`never` \| `po-only` \| `any`), `inProgressWipLimit?` | refinement share, mid-sprint additions, optional WIP cap |
| `autoClose` (default `true`) | close the sprint when its budget is spent and nothing is in flight; `false` keeps it in `closing` until `review` or `cancel` |
| `estimateMode` (`per-weight` default, or `per-call`) | how candidates are priced: median tokens per weight unit, or median tokens per completion (for hosts that bill one total per call) |
| `fallbackTokensPerWeight` (default 20000) | pricing when there is no history |

### Kanban (`KanbanConfig`)

| Key | Meaning |
|---|---|
| `columns` | ordered columns with `wipLimit`, `commitmentPoint` and entry/exit `policies`; the default board is options, ready (commit, WIP 4), dev (WIP 3), review (WIP 2), done |
| `classesOfService` | per class (`expedite`, `fixed-date`, `standard`, `intangible`): `sle: { percentile, targetMs }` and `wipBypass` |
| `fairness` | `{ aging, maxDeferralRounds }` anti-starvation |
| `cadences` | `{ <cadence>: { everyTurns } }`; `exwf status` reports which are due |
| `throughputWindowMs`, `maxExpedite` | metrics window, cap on simultaneous expedites |

### Waterfall (`WaterfallConfig`)

| Key | Meaning |
|---|---|
| `phases` | ordered phases with deliverables, delivering role and gate; the default is the six classic phases |
| `humanGates` | `"all"` (default) or the phase ids whose gate needs a human |
| `changeControl` | `{ requiresImpactAnalysis, approvers }`; with impact analysis required, a change-request without one is refused at `add` |
| `traceability` | `{ from, to[] }` phase ids: every item of `from` must trace to an item of each `to` phase before that gate |
| `fallbackTokensPerWeight` | as in Scrum |

### Investigation (`InvestigationConfig`)

| Key | Meaning |
|---|---|
| `question` | the question the investigation answers; it heads every brief's invariants |
| `maxRounds` | positive integer; a round is one preregistered experiment |
| `budget` | `{ tokens?, turns?, wallclockMs? }`, at least one, every value finite and positive; when it is spent no further run is dispatched and the investigation closes `stopped` |

All three keys are locked after `init` (`config set` refuses them).

### Experimentation (`ExperimentationConfig`)

| Key | Meaning |
|---|---|
| `objective` | what the score measures |
| `direction` (`minimize` default, or `maximize`) | how scores rank |
| `tieBreak` (`candidate-id`, the only value) | equal scores rank by candidate id |
| `concurrencyCap` (default 2), `maxCandidates` (default 4) | candidates running at once, candidates per run; the cap cannot exceed the maximum |
| `candidateBudget` (default `{ turns: 10 }`), `totalBudget` (default `{ turns: 40 }`) | `{ tokens?, turns?, wallclockMs? }` of positive integers, per candidate and for the whole run including control, validation and integration overhead |

Every key is locked after `init`; an unknown key is refused.

Every config is validated at `init` (`config-invalid` names the key and an example value).

## Ceremonies

`ceremony <name> [input.json] --by <role>`; the caller needs the ceremony's capability.

**Scrum**
- `refine { reestimate?: string[] }` confirms backlog weights.
- `plan { goal, items: string[] | "auto" }` commits a sprint; `auto` fills the budget from priority and history.
- `commit { items }` / `uncommit { items }` adjust the sprint (a closing sprint can only shrink).
- `daily` reports progress; `review { accepted, goalMet }` closes the sprint; `cancel` abandons it.
- `retro { lessons?, adopt?, dismiss?, retire?, dodChanges?, allowWeaken? }`. A lesson is `{ text, scope, from?, item?, suggestedChange? }`; `suggestedChange` may add an `agreement` (optionally `replaces` an earlier one), append a `dod` policy, queue `backlog` work, or leave a `skill` note for the host. `retire` removes agreements by exact text. Dropping a Definition of Done policy is refused unless `allowWeaken: true`.

**Kanban**
- `replenishment { items }` moves options to the commitment column (the only push on the board).
- `delivery-planning { items }` (non-empty) plans the release of done cards.
- `service-delivery-review { wip?, policies?, sle?, lessons?, adopt?, dismiss?, retire? }` tunes the board; lessons follow the Scrum retro semantics.
- `operations-review { assign?: [{ item, blocker, owner }] }` reviews blockers and aging WIP.
- `risk-review { staleAfterMs? }` reports fixed-date risk, stale blockers and active expedites.
- `strategy-review { classesOfService?, maxExpedite? }` changes classes of service.

**Waterfall**
- `kickoff { phase }` opens the next phase.
- `gateReview { phase }` checks deliverables and traceability, then raises a pending gate decision; `decide … approve` baselines the phase.
- `changeControlBoard { change, decision, note? }` approves or rejects a change-request; an approval reopens the phases its impact analysis names.
- `phaseRetrospective { lessons?, adopt?, dismiss?, retire? }`; `adopt` entries are `[{ id }]`. Only `agreement` suggestions apply (baselines and config are locked); others are stored for the host.

**Investigation** (`investigator` unless noted; every input also takes `by`; every record is a closed object, an unknown key is refused)
- `intake { item }` names the question item and opens the investigation.
- `hypotheses { hypotheses: [{ id, claim, falsifiedBy }], singleHypothesisRationale? }` registers unique, falsifiable, competing hypotheses; a single hypothesis needs the rationale.
- `preregister { experiment: { id, procedureRef, predictions: [{ hypothesis, prediction }], replayOf? } }` creates the run item; `replayOf` names an earlier valid experiment with the same procedure and predictions, and is executed by a role that did not run it. Refused once `maxRounds` or the budget is spent; `stop` closes the investigation.
- `observe { experiment, result: { id, valid, summary, provenanceRefs } }` records the outcome once the run item is `done` with `experiment-output` evidence; an invalid run stays recorded.
- `update-belief { result, assessments: [{ hypothesis, assessment, reason }], next }` with `assessment` `supported` | `refuted` | `uncertain` and `next` `round` | `conclusion`.
- `conclude { outcome, summary, evidenceRefs, supportedHypothesis? }` with `outcome` `resolved` | `inconclusive`; `resolved` needs a supported hypothesis, valid supporting evidence and a valid replay.
- `review-conclusion { approve, reason, replayRefs?, next? }` by `conclusion-reviewer`, who may not have contributed a run; a rejection returns to `round` or `conclusion`.
- `stop { reason }` closes the investigation `stopped`.

**Experimentation** (SHAs are full lowercase 40- or 64-character hex; `spent` is `{ tokens?, turns?, wallclockMs? }`, cumulative for the candidate)
- `freeze { baseSha, harness, candidates: [{ id, item, author }] }` by `coordinator` freezes the baseline and harness and registers each candidate (an existing item and its builder role); nothing runs before the freeze.
- `provision { candidate, workspace, baseSha, isolated: true }` by `coordinator` records the host-created isolated workspace at the frozen base; the candidate becomes `ready`.
- `start { candidate }` by the builder marks the dispatched candidate `running`.
- `submit { candidate, sha, score, baseSha, workspace, harness, command, log, spent }` by the builder records the exact commit, the benchmark result and the usage.
- `validate { candidate, sha, harness, passed, reproducible, evidence, spent }` by a `validator` other than the author, at the submitted SHA and frozen harness; a failed or nonreproducible candidate is ineligible. A candidate the planner dispatched (`next`) is validated after its builder's `complete`; one the host started by ceremony needs no completion.
- `compare` by `coordinator` ranks the eligible validated candidates by score, then candidate id, and selects the winner; with none eligible the run stops without a winner.
- `integrate { selectedSha, targetSha, integrationSha, spent }` by `integrator` records the exact selected SHA merged into the current target.
- `validate-integration { sha, targetSha, harness, passed, evidence, spent }` by a validator independent of the author and the integrator; a pass closes the run `integrated`, a fail stops it.
- `terminate { candidate, status, reason, spent, log }` with `status` `failed` | `timed-out` | `cancelled` records a terminal attempt with its final usage; required for every dispatched, running or submitted candidate before `stop`.
- `stop { reason, spent }` by `coordinator` closes the run; candidates that never started are cancelled automatically.
- `cleanup { workspaces }` by `coordinator`, after closure, records the host-confirmed release of workspaces.

## Items, briefs, handoffs, accounting

**Item** (`NewItem`): `id`, `title`, `acceptance[]`, and optionally `type` (`epic`, `story`, `task`, `bug`, `change-request`, `deliverable`, `question`), `description`, `dependsOn[]`, `priority`, `weight`, `deadline`, `classOfService`, `role`, `traces[]`, `tags[]`, `phase` (Waterfall), and for bugs and change-requests `affects[]` and `impactAnalysis`. Status moves through `todo`, `in_progress`, `blocked`, `review`, `awaiting_human`, `done` or `dropped`.

**Brief** (what `next` gives your agent):

```ts
{ item, role, modelTier, invariants, do_not, acceptance,
  upstream,        // results of the items this one depends on
  priorHandoffs,   // earlier attempts at this item (rework feedback)
  relatedBugs, budgetRemaining, gateAhead }
```

**Handoff** (what your agent gives back):

```ts
{ item, role,
  produced: [{ kind, ref }],          // evidence; policies match on `kind`
  notes, do_not: string[], open_questions: string[],
  verdict?: "done" | "blocked" | "needs-review" | "rework" | "escalate",
  follow_ups?: NewItem[],             // new work; lands in the first stage, never in the iteration
  lessons?: [{ text, scope }] }
```

`escalate` creates a question item for a role that can answer it, and the original item is re-briefed with the decision as upstream. `blocked` raises a blocker that `unblock` clears. An item whose `done` handoff still has `open_questions` is reported under `status.openQuestions`.

**Accounting**: `{ item, role, model, tokensIn, tokensOut, durationMs, startedAt, endedAt, estimate? }`. The planner uses accounting history to price future candidates against the budget, so record real figures; `--estimate` plus `account` is the path when the host reports them late.

## Errors

Every failure is a `WorkflowError` (CLI: exit 1) with the same shape:

```json
{ "ok": false, "error": { "code": "policy-unmet", "message": "…", "fix": "…", "items": ["CART"], "rule": "dod" } }
```

Codes: `unknown-item`, `duplicate-item`, `unknown-role`, `duplicate-role`, `unknown-stage`, `missing-capability`, `exclusive-capability`, `role-has-open-items`, `invalid-transition`, `policy-unmet`, `gate-unmet`, `handoff-invalid`, `accounting-invalid`, `rule-violation`, `planner-error`, `no-op`, `unknown-pending`, `unknown-ceremony`, `state-version`, `config-invalid`, `budget-exhausted`, `invalid-input`. `fix` always says what to change; act on it rather than on the state.

## JSON Schema

`ex-workflow/schema` exports draft-07 documents generated from the TypeScript types, plus a dependency-free validator:

`workflowStateSchema`, `roleSchema`, `newItemSchema`, `itemPatchSchema`, `handoffSchema`, `scrumConfigSchema`, `kanbanConfigSchema`, `waterfallConfigSchema`, `investigationConfigSchema`, `experimentationConfigSchema`

```ts
import { assertValid, validate, handoffSchema } from "ex-workflow/schema";

const errors = validate(handoffSchema, JSON.parse(raw));          // SchemaError[] with JSON-pointer paths
assertValid(handoffSchema, JSON.parse(raw), "inbox/CART.json");   // throws WorkflowError("invalid-input")
```

The CLI validates state, role manifests, items, patches and handoffs with these documents before acting, and `saveState` validates before writing. They are standard JSON Schema, so editors and ajv read them too.

## Package entry points

| Import | Contents |
|---|---|
| `ex-workflow` | core: `init`, `addItem`, `editItem`, `next`, `complete`, `decide`, `applyAction`, `validateAction`, `changeConfig`, `correctAccounting`, `clearBlocker`, `raiseBlocker`, `registerRole`, `openQuestions`, `readExt`, `writeExt`, `independenceConflicts`, `frozenChanges`, `WorkflowError`, `VERSION`, … |
| `ex-workflow/scrum` | `scrum()`, `scrumMetrics`, `dailyReport`, `closeSprint`, presets |
| `ex-workflow/kanban` | `kanban()`, `board`, `kanbanMetrics`, `opsReport`, `riskReport`, `cadencesDue`, `DEFAULT_COLUMNS`, presets |
| `ex-workflow/waterfall` | `waterfall()`, `phaseReport`, `traceabilityMatrix`, `waterfallMetrics`, `baselinePhase`, `reopenPhases`, presets |
| `ex-workflow/investigation` | `investigation()`, `validateInvestigationConfig`; types `InvestigationConfig`, `InvestigationState`, `InvestigationRound`, `InvestigationConclusion`, `Hypothesis`, `Experiment`, `Observation`, `BeliefUpdate` |
| `ex-workflow/experimentation` | `experimentation()`, `validateExperimentationConfig`, `experimentationCeremonies`, `experimentationMetrics`, `experimentationReport`, `experimentationRoles`, `experimentationRules`, `experimentationStages`; types `ExperimentationConfig`, `ExperimentationState`, `ExperimentCandidate` |
| `ex-workflow/registry` | `registerMethodology`, `methodologyFactory`, `registeredMethodologies` (five built-ins pre-registered); types `MethodologyFactory`, `MethodologyRegistry` |
| `ex-workflow/policies` | `withRiskGate`, `recordRiskAssessment`, `riskEscalation`, `DEFAULT_RISK_TABLE`; types `RiskLevel`, `RiskTable`, `RiskAssessmentData`, `RiskAssessmentInput`, `RiskGateOptions` |
| `ex-workflow/adapters` | `loadState`, `saveState`, `saveBrief`, `saveHandoff`, `withStateLock`, `WORKFLOW_DIR` |
| `ex-workflow/schema` | the ten schema documents, `validate`, `assertValid` |
| `ex-workflow/cli` | `runCommand`, `parseArgs`, `USAGE`: the `exwf` command as a library |
| `ex-workflow/types` | every public type |

Each entry ships ESM, CommonJS and `.d.ts`. Core plus one methodology is about 53–69 kB minified.

## Compatibility and versioning

- Semver from 1.0.0. The public surface (exports of every entry point, the CLI commands, the ten schema documents, the 70 event kinds) is frozen by test: a removal is a major version, an addition a minor one.
- A `.workflow/state.json` written by any earlier release loads unchanged; the test suite replays state files from every published pre-release.
- **Deprecated in 1.2:** the top-level `state.investigation` and `state.experimentation` fields. They are still set in memory and for SDK readers, as read-only mirrors of `ext.investigation` / `ext.experimentation` (on disk only `ext` is written; `loadState` restores the mirror), so SDK code reading `state.investigation` / `state.experimentation` sees the same record; once `ext.<name>` exists a write to the legacy field is ignored. Read with `readExt` and write with `writeExt` instead. The mirrors do not make a 1.2 state loadable by 1.1.x (see [Known limitations](#known-limitations)). 2.0 removes the mirrors.
- Behaviour changes are listed per release in [CHANGELOG.md](CHANGELOG.md).

## Known limitations

Deliberate, documented, and stable within 1.x.

- **A custom methodology's state cannot go through the file adapter or the CLI.** The state schema accepts only the five built-in names in `methodology`, so `saveState`, `loadState` and every `exwf` command refuse it. Keep such a state through the SDK and persist it yourself.
- **No downgrade for Investigation and Experimentation.** 1.1.x cannot load a state that 1.2 wrote for those two methodologies: the 1.1 state schema rejects the `ext` field, and the legacy mirrors do not change that. Keep a run on 1.2 once 1.2 has saved it.
- **No downgrade for a state with evidence `data`.** 1.2.x cannot load a state carrying `Evidence.data` (a risk assessment recorded by `ex-workflow/policies`): its schema closes `Evidence`. Keep such a run on 1.3.
- **Policies are SDK-only.** `exwf` runs the plain built-in methodology, so `exwf complete` checks a gate's static requirements only. `exwf decide` does honour an escalation the SDK recorded (`gate.resolved`). Run completions of a risk-gated run through the SDK.
- **`checkGate` alone sees the static gate.** The risk escalation is applied by `complete()` and `decide()`; a host calling `checkGate` directly gets the 1.2 answer.

- **Stale lock takeover** narrows the race to the gap between the stat and the unlink; no portable call closes it. On file systems without inodes (FAT, exFAT, some shares) only the mtime is compared. If a stale lock cannot be unlinked (read-only directory, EPERM), the command gives up after its retries with `invalid-input` naming the lock file; delete it by hand.
- **Item ids that differ only in letter case cannot both get a brief file.** On macOS and Windows `briefs/A.json` and `briefs/a.json` are one file, so `exwf next` checks every brief name of the batch first and, when an item's id differs from another item's (in the same batch, or with an existing brief) only in case, refuses the whole dispatch with `invalid-input` naming both: no brief is written and the state is unchanged. `saveBrief` refuses such an id the same way. Give ids that differ by more than case (re-add one item under a new id).
- **An id long enough to hit the OS file-name limit fails at write time.** `exwf next` writes `briefs/<id>.json` per item, so such an id fails `invalid-input` when its brief is written, possibly after earlier briefs of the batch were written. 1.1.1 behaved the same.
- **Blockers are owned by a human.** Finishing a follow-up does not clear its blocker; `unblock` does.
- **Direct primitives bypass the baseline.** `addItem` and `editItem` called directly do not check `baseline-immutable`; `applyAction` and the CLI do.
- **Kanban cadences count turns, not time.** The engine has no clock; wall-clock schedules are the host's job. `wipBypass` is a column total.
- **Kanban WIP is not enforced against the engine's own moves**; a column the engine over-fills by advancing a card is surfaced by `operations-review`.
- **Waterfall traceability is keyed by phase**, not by item type: phase membership says what counts as a requirement, design or test item.
- **Waterfall retrospectives apply only `agreement` lessons**; `dod` and `backlog` suggestions are stored for the host because baselines and config are locked.
- **Scrum stage ids** `backlog`, `sprint` and `review` are fixed; `init` refuses a config without them. `status.report.reason` is always `budget`.
- **Carryover**: an item that was `blocked` or `awaiting_human` in a stage not flagged `review: true` restarts at the sprint start and needs a re-estimate; flag the stage `review: true` to resume there.
- **Accounting outside a sprint** (a line whose `endedAt` lies in no sprint window) is kept but charged to no sprint.
- **Reworked items need fresh evidence**: policies and gates count only evidence recorded after the last rework.
- **CLI flags** take `--flag value` only; `--estimate` is the sole boolean flag.
- **Investigation and Experimentation run alone.** Neither nests inside, migrates into or coordinates Scrum, Kanban, Waterfall or the other; one `.workflow/` per run.
- **The host executes.** Core never runs a procedure, benchmark or Git command and never creates or removes a workspace; `provision`, `submit`, `integrate` and `cleanup` record what the host did. A `procedureRef`, `provenanceRefs` entry, `evidence` or `log` is a recorded reference: the engine checks its shape and linkage, not the contents behind it.
- **Independence is by role id.** Replay, conclusion review and validation must come from a role that did not do the work, judged by the recorded role id; authenticating who runs which role is the host's job.

## Contributing

```sh
pnpm install
pnpm test        # unit, e2e scenarios per methodology, compatibility fixtures, API-surface freeze
pnpm run ci      # format, lint, typecheck, schema drift, tests, minified build, dist checks, size ratchet
```

Conventions for branches, commits, tests, the frozen public surface, size budgets, docs and releases are in [CONTRIBUTING.md](CONTRIBUTING.md). The design, including every decision log since the first release, lives in [docs/superpowers/specs/2026-10-19-ex-workflow-design.md](docs/superpowers/specs/2026-10-19-ex-workflow-design.md). The end-to-end scenarios (`test/sprint.e2e.test.ts`, `test/kanban.e2e.test.ts`, `test/waterfall.e2e.test.ts`) are the best long-form examples: rework, blockers, escalations, retros, change-requests and metrics in one run each. Issues and pull requests: [github.com/Ink01101011/ex-workflow](https://github.com/Ink01101011/ex-workflow).

## License

[MIT](LICENSE)
