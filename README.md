# ex-workflow

**Methodology engine for AI agent teams.** Scrum, Kanban, Waterfall, Investigation and Experimentation as data-driven state machines in TypeScript: the engine decides which item may move, who may approve and whether an iteration may close; your agents only do the work.

[![npm](https://img.shields.io/npm/v/ex-workflow)](https://www.npmjs.com/package/ex-workflow) [![license](https://img.shields.io/npm/l/ex-workflow)](LICENSE) Node >= 18 · macOS, Linux, Windows · ESM + CommonJS · no I/O in core

- State is plain JSON. Every operation is `(state, action) -> state`.
- Every error names the rule, the item and a concrete fix.
- Two runtime dependencies: [`ex-flow`](https://www.npmjs.com/package/ex-flow) (DAG planner) and [`exsorted`](https://www.npmjs.com/package/exsorted).
- Works with any LLM host: the engine hands out **briefs**, you run them with your agents and hand back **handoffs**.

## Contents

1. [Install](#install)
2. [Pick a methodology](#pick-a-methodology)
3. [How a run works](#how-a-run-works)
4. [Quick start: Scrum](#quick-start-scrum)
5. [Quick start: Kanban](#quick-start-kanban)
6. [Quick start: Waterfall](#quick-start-waterfall)
7. [Standalone investigation and experimentation](#standalone-investigation-and-experimentation)
8. [Persisting state](#persisting-state)
9. [CLI reference (`exwf`)](#cli-reference-exwf)
10. [Configuration](#configuration)
11. [Ceremonies](#ceremonies)
12. [Items, briefs, handoffs, accounting](#items-briefs-handoffs-accounting)
13. [Errors](#errors)
14. [JSON Schema](#json-schema)
15. [Package entry points](#package-entry-points)
16. [Compatibility and versioning](#compatibility-and-versioning)
17. [Known limitations](#known-limitations)
18. [Contributing](#contributing)
19. [License](#license)

## Install

```sh
npm install ex-workflow      # or: pnpm add ex-workflow
npx exwf                     # prints the CLI usage
```

This source tree targets version 1.1.0. Pre-releases, when any, are published under the `stage` dist-tag.

## Pick a methodology

| | Scrum (`ex-workflow/scrum`) | Kanban (`ex-workflow/kanban`) | Waterfall (`ex-workflow/waterfall`) |
|---|---|---|---|
| Fits | a goal delivered in budgeted sprints | a continuous flow of requests | a phase-gated project with a frozen baseline |
| Unit of control | sprint budget (tokens, turns, wall-clock) | WIP limits per column, classes of service | human-approved gate per phase |
| Flow | backlog → sprint → review | options → ready → dev → review → done | work → review → done, inside each phase |
| Preset roles | product-owner, scrum-master, developer | service-request-manager, service-delivery-manager, worker | project-manager, business-analyst, architect, developer, qa, release-manager |
| Ceremonies | refine, plan, commit, uncommit, daily, review, retro, cancel | replenishment, delivery-planning, service-delivery-review, operations-review, risk-review, strategy-review | kickoff, gateReview, changeControlBoard, phaseRetrospective |
| Metrics | velocity, cost per point, budget utilisation | lead and cycle time, throughput, WIP, flow efficiency, aging, CFD, SLE compliance | phase report, requirement coverage, traceability matrix |

Scrum, Kanban and Waterfall share one core: the same item model, the same brief and handoff contracts, the same CLI and the same `.workflow/` files. Roles are data (capabilities, not names), so you can replace or extend the presets with `exwf role add`.

Standalone [Investigation and Experimentation](#standalone-investigation-and-experimentation) add evidence-driven inquiry and isolated candidate comparison; each runs in its own state.

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

Run the complete synthetic SDK examples from this repository:

```sh
pnpm exec tsx scripts/example-investigation.ts
pnpm exec tsx scripts/example-experimentation.ts
```

[Investigation example](scripts/example-investigation.ts) exercises execution, observation, rejected review, independent replay and a resolved conclusion. [Experimentation example](scripts/example-experimentation.ts) compares two candidates (one nonreproducible), records exact-SHA integration, validates it afresh and cleans up. Both use explicitly synthetic in-memory host outputs and assert their final outcomes; they do not execute procedures, benchmarks, Git or filesystem operations.

These methodologies run in their own workflow state. They do not nest inside, migrate into, or coordinate Scrum, Kanban, Waterfall or each other. The host executes procedures, creates isolated workspaces, runs benchmarks and performs Git operations; the engine records and validates the resulting artifacts.

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

Investigation requires a question, positive `maxRounds` and a finite positive `budget` (`tokens`, `turns`, `wallclockMs`). Its ceremonies are `intake { item }`, `hypotheses { hypotheses: [{ id, claim, falsifiedBy }], singleHypothesisRationale? }`, `preregister { experiment: { id, procedureRef, predictions: [{ hypothesis, prediction }], replayOf? } }`, `observe { experiment, result: { id, valid, summary, provenanceRefs } }`, `update-belief { result, assessments: [{ hypothesis, assessment, reason }], next: "round" | "conclusion" }`, `conclude { outcome, summary, evidenceRefs, supportedHypothesis? }`, `review-conclusion { approve, reason, replayRefs?, next?: "round" | "conclusion" }` and `stop { reason }`. Assessments are `supported`, `refuted` or `uncertain`; outcomes are `resolved` or `inconclusive`. Execute each preregistered run with `next()` and `complete()` before observing it, producing `experiment-output` evidence. A resolved conclusion needs supporting valid evidence, a valid replay and an independent `conclusion-reviewer`; `investigator` handles the other ceremonies. Invalid runs remain recorded.

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

Experimentation requires `objective`; `direction` defaults to `minimize` (`maximize` also supported), `tieBreak` to `candidate-id`, `concurrencyCap` to 2, `maxCandidates` to 4, and positive `candidateBudget` / `totalBudget` to 10 / 40 turns. Freeze the full baseline SHA, harness identity and candidate authors before work. The host must provision distinct isolated workspaces at that baseline and enforce their ownership; workspace strings are recorded identities, not filesystem operations.

Ceremonies continue with `start { candidate }` and `submit { candidate, sha, score, baseSha, workspace, harness, command, log, spent: { tokens, turns, wallclockMs } }` by the builder; `validate { candidate, sha, harness, passed, reproducible, evidence, spent }` by an independent validator; `compare` by the coordinator; `integrate { selectedSha, targetSha, integrationSha, spent }` by the integrator; and `validate-integration { sha, targetSha, harness, passed, evidence, spent }` by a validator independent of the author and integrator. SHAs are full lowercase commit hashes. Comparison ranks eligible validated candidates by score then candidate id. Promotion records the exact selected SHA; fresh validation checks the integration SHA against the current target and frozen harness. The coordinator may `terminate { candidate, status: "failed" | "timed-out" | "cancelled", reason, spent, log }`, `stop { reason, spent }`, then `cleanup { workspaces }` after closure. Terminate every dispatched, running or submitted candidate with final cumulative usage and logs before stopping; stop only automatically cancels candidates that never started. Cleanup records host-confirmed release; the host removes workspaces itself.

The CLI supports `exwf init investigation --config investigation.json` and `exwf init experimentation --config experimentation.json`, followed by the same `ceremony`, `next`, `complete`, `status`, `metrics` and persistence commands. Ceremony input files contain the objects above; pass the role with `--by`.

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
| `ex-workflow` | core: `init`, `addItem`, `editItem`, `next`, `complete`, `decide`, `applyAction`, `validateAction`, `changeConfig`, `correctAccounting`, `clearBlocker`, `raiseBlocker`, `registerRole`, `openQuestions`, `WorkflowError`, `VERSION`, … |
| `ex-workflow/scrum` | `scrum()`, `scrumMetrics`, `dailyReport`, `closeSprint`, presets |
| `ex-workflow/kanban` | `kanban()`, `board`, `kanbanMetrics`, `opsReport`, `riskReport`, `cadencesDue`, `DEFAULT_COLUMNS`, presets |
| `ex-workflow/waterfall` | `waterfall()`, `phaseReport`, `traceabilityMatrix`, `waterfallMetrics`, `baselinePhase`, `reopenPhases`, presets |
| `ex-workflow/investigation` | `investigation()`, config validation and artifact types |
| `ex-workflow/experimentation` | `experimentation()`, config validation and artifact types |
| `ex-workflow/adapters` | `loadState`, `saveState`, `saveBrief`, `saveHandoff`, `withStateLock`, `WORKFLOW_DIR` |
| `ex-workflow/schema` | the ten schema documents, `validate`, `assertValid` |
| `ex-workflow/cli` | `runCommand`, `parseArgs`, `USAGE`: the `exwf` command as a library |
| `ex-workflow/types` | every public type |

Each entry ships ESM, CommonJS and `.d.ts`. Core plus one methodology is about 60–68 kB minified.

## Compatibility and versioning

- Semver from 1.0.0. The public surface (exports of every entry point, the CLI commands, the ten schema documents, the event kinds) is frozen by test: a removal is a major version, an addition a minor one.
- A `.workflow/state.json` written by any earlier release loads unchanged; the test suite replays state files from every published pre-release.
- Behaviour changes are listed per release in [CHANGELOG.md](CHANGELOG.md).

## Known limitations

Deliberate, documented, and stable within 1.x.

- **Stale lock takeover** narrows the race to the gap between the stat and the unlink; no portable call closes it. On file systems without inodes (FAT, exFAT, some shares) only the mtime is compared. If a stale lock cannot be unlinked (read-only directory, EPERM), delete it by hand.
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

## Contributing

```sh
pnpm install
pnpm test        # unit, e2e scenarios per methodology, compatibility fixtures, API-surface freeze
pnpm run ci      # format, lint, typecheck, schema drift, tests, minified build, dist checks, size ratchet
```

The design, including every decision log since the first release, lives in [docs/superpowers/specs/2026-10-19-ex-workflow-design.md](docs/superpowers/specs/2026-10-19-ex-workflow-design.md). The end-to-end scenarios (`test/sprint.e2e.test.ts`, `test/kanban.e2e.test.ts`, `test/waterfall.e2e.test.ts`) are the best long-form examples: rework, blockers, escalations, retros, change-requests and metrics in one run each. Issues and pull requests: [github.com/Ink01101011/ex-workflow](https://github.com/Ink01101011/ex-workflow).

## License

[MIT](LICENSE)
