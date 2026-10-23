# ex-workflow

Methodology engine for AI teams. Scrum, Kanban and Waterfall are modelled as data (stages, roles, policies, gates, ceremonies) and driven by a pure state machine on top of the [`ex-flow`](https://www.npmjs.com/package/ex-flow) DAG planner. The program decides, the LLM executes: which item may move, who may approve, whether a sprint may close is enforced by the engine, not by a prompt.

State is plain JSON, every operation is `(state, action) -> state`, and every error names the rule, the item and a concrete fix. Core performs no I/O; a small file adapter and the `exwf` CLI sit on top. Runtime dependencies are exactly `ex-flow` and `exsorted`.

## Install

```sh
pnpm add ex-workflow@stage
```

Pre-releases are published under the `stage` dist-tag (currently `0.3.0-stage`); `latest` is reserved for 0.1.0.

Node >= 18. Runs on macOS, Linux and Windows.

## Quick start

```ts
import { init, addItem, next, complete } from "ex-workflow";
import { scrum } from "ex-workflow/scrum";

const m = scrum();
const config = { sprintBudget: { tokens: 300_000 }, productGoal: "ship the checkout", definitionOfDone: [{ kind: "evidence", evidenceKind: "test-output" }] };
let state = init({ methodology: m, config }).state;
state = addItem(state, { id: "CART", title: "cart API", weight: 3, priority: 5, acceptance: ["add/remove items"] }, "product-owner");
state = m.ceremonies["plan"]!(state, { by: "scrum-master", goal: "customers can pay", items: "auto" }).state;

const { state: s2, briefs } = next(state, m); // dispatches work, returns one brief per item
// ...run each brief with your agent, then record the result:
// state = complete(s2, m, handoff, accounting).state;
// state = m.ceremonies["review"]!(state, { by: "human", accepted: true, goalMet: true }).state;
```

To persist state, use the file adapter (the only part of the package that touches disk):

```ts
import { loadState, saveState, withStateLock } from "ex-workflow/adapters";

await withStateLock(process.cwd(), async () => {
  const state = await loadState(process.cwd());
  await saveState(process.cwd(), complete(state, m, handoff, accounting).state);
});
```

`test/sprint.e2e.test.ts` is a complete two-sprint scenario: rework, a blocker, an escalation, a retro that changes the working agreements, and metrics.

### Kanban

```ts
import { addItem, complete, init, next } from "ex-workflow";
import { board, kanban, kanbanMetrics } from "ex-workflow/kanban";

const m = kanban(); // default board: options → ready (commit, WIP 4) → dev (WIP 3) → review (WIP 2) → done
let state = init({ methodology: m, config: { classesOfService: { standard: { sle: { percentile: 85, targetMs: 7 * 86_400_000 } } } } }).state;
state = addItem(state, { id: "SEARCH", title: "search box", acceptance: ["finds by name"] }, "service-request-manager");
state = m.ceremonies["replenishment"]!(state, { by: "service-request-manager", items: ["SEARCH"] }).state; // the only push: options → commitment point
const { state: s2, briefs } = next(state, m); // the planner pulls ready → dev within WIP; expedite cards jump the queue
// ...run each brief, then complete(s2, m, handoff, accounting); cards advance column by column
board(s2, new Date().toISOString()); // columns with active/queued counts and card ages
kanbanMetrics(s2); // lead time, cycle time per column, throughput, WIP, flow efficiency, aging, CFD, SLE compliance
```

Cadences are ceremonies: `replenishment`, `delivery-planning`, `service-delivery-review` (WIP, policies, SLEs), `operations-review` (blockers, aging WIP), `risk-review` (fixed-date risk, stale blockers), `strategy-review` (classes of service). `exwf status` reports which cadences are due (`config.cadences.<name>.everyTurns`). `test/kanban.e2e.test.ts` is a full week with an expedite, an escalation and a blocker.

`next()` also returns `skipped`: each ready card it did not pull, with `reason` (`entry-policy`, `wip`, `resource-cap` or `budget`) and a `detail`; the commitment column's policies gate the pull out of it (escalation `question` cards are exempt, as from exit policies and gates). Ordering is by class band (question, expedite, fixed-date, standard, intangible) and, with `fairness.aging` on (the default), priority stays primary inside a window of `fairness.maxDeferralRounds` passes (default 5); each full window a card is passed over promotes it one step above any priority difference, and an intangible card reaching the first window is ranked as standard, so nothing is starved.

### Waterfall

```ts
import { init, addItem, applyAction, next, complete, decide } from "ex-workflow";
import { waterfall } from "ex-workflow/waterfall";

const m = waterfall();
let { state } = init({ methodology: m, config: {} }); // six classic phases, every gate human-approved
const r1 = { id: "R1", title: "login", phase: "requirements", acceptance: ["user can log in"] };
state = applyAction(state, m, { type: "item.add", by: "business-analyst", payload: { item: r1 } }, (s) =>
  addItem(s, r1, "business-analyst"),
).state;
state = m.ceremonies["kickoff"]!(state, { by: "project-manager", phase: "requirements" }).state;
// next() → complete() as with any methodology; items go work → review → done
state = m.ceremonies["gateReview"]!(state, { by: "project-manager", phase: "requirements" }).state; // pending decision
state = decide(state, state.pending[0]!.id, "approve", "human", "ok", undefined, m); // baselines the phase
```

Phases open one at a time (`kickoff`), close through a gate (`gateReview`, human-approved by default) that
baselines their items, and reopen only through an approved change-request (`changeControlBoard`, with an
impact analysis). Requirements must trace to design and verification items before those gates; the engine
generates the `traceability-matrix` deliverable. Edits to baselined items are refused by the rules when
they go through `applyAction` or the CLI. `test/waterfall.e2e.test.ts` is a full project with a
change-request that reopens two baselined phases.

## CLI

State lives in `.workflow/`. Every command prints JSON; errors exit 1, bad usage exits 2.

| Command | Returns |
|---|---|
| `init <scrum\|kanban\|waterfall> --config <file> [--roles <file>]` | `{ ok, state: { methodology, stages, roles } }` |
| `add <item.json>` | `{ ok, warnings, item }` (checked by the methodology rules) |
| `edit <id> <patch.json>` | `{ ok, warnings, item }` (checked by the methodology rules) |
| `next [--max n]` | `{ ok, reason, skipped, briefs }`; writes `.workflow/briefs/<id>.json` |
| `complete <id> <handoff.json> --tokens-in n --tokens-out n --duration-ms n --model m [--role r]` | `{ ok, item, warnings }` |
| `ceremony <name> [input.json] [--by who]` | `{ ok, warnings, lastEvent }` |
| `decide <pendingId> approve\|reject --by who [--note text]` | `{ ok, item }` (runs the methodology's `afterDecide`, e.g. a Waterfall phase baseline) |
| `status` | `{ ok, methodology, openIteration, counts, pending, lastEvent, report }` (`report` is the methodology's own status: Kanban's cadences due, Waterfall's phases, pending gates and traceability coverage; `null` for Scrum) |
| `board` | `{ ok, columns }` |
| `metrics` | `{ ok, metrics }` |
| `pending` / `lessons` | the arrays |
| `validate <action.json>` | `{ ok: true, violations }` |
| `role add <manifest.json>` / `role list` | `{ ok, roles }` |

`--by` defaults to `human`.

### Concurrency

One writer at a time per `.workflow/`: `exwf` serialises writers with `.workflow/state.lock` (created exclusively, retried for about two seconds, taken over when older than 60 s). If a crashed process left the lock behind and a command reports that another `exwf` holds it, delete the file. Read-only commands do not lock. Use `withStateLock` from `ex-workflow/adapters` when you write state yourself.

### Schema

`ex-workflow/schema` exports JSON Schema (draft-07) documents generated from the TypeScript types — `workflowStateSchema`, `roleSchema`, `newItemSchema`, `handoffSchema`, `scrumConfigSchema`, `kanbanConfigSchema`, `waterfallConfigSchema` — and a small validator with no runtime dependencies:

```ts
import { assertValid, validate, workflowStateSchema } from "ex-workflow/schema";

const errors = validate(workflowStateSchema, JSON.parse(raw)); // SchemaError[] with JSON-pointer paths
assertValid(workflowStateSchema, JSON.parse(raw), ".workflow/state.json"); // throws WorkflowError("invalid-input")
```

`exwf` validates `state.json`, role manifests, item files and handoff files with these schemas before acting on them. The documents are standard JSON Schema, so editors and ajv read them too. They are regenerated with `pnpm schema:gen`; `pnpm schema:check` (in `ci` and the pre-commit hook) fails when they drift from the types.

## Layers

```
L3  MCP server (planned)    daemon, hook enforcement, dashboard, team mode
L2  agent adapters          Claude Code agents/*.md, future Cursor/Codex formats   (planned)
L1  skills                  SKILL.md + scripts/wf.js (bundled L0)                   (planned)
L0  ex-workflow             this spec: state, policy, planner, accounting          (npm, free)
```

This package is L0. All layers read and write the same `.workflow/` files.

## Status

0.4.0-stage adds `ex-workflow/schema` (JSON Schema documents and a validator, checked by `exwf` on load and on input). 0.3.0-stage added the Waterfall module; all three methodologies ship. Design: [docs/superpowers/specs/2026-10-19-ex-workflow-design.md](docs/superpowers/specs/2026-10-19-ex-workflow-design.md).

## Known backlog

Minor items deferred past 0.3.0-stage:

- Stale-lock takeover can race when a lock is older than 60 s.
- `decide(approve)` ignores a `needs-review` verdict.
- `setDod` hard-codes the `review` stage id in the Scrum methodology.
- The `closing` sprint state is not enforced on commit, plan or uncommit.
- State is written before briefs; a crash between the two leaves them out of step.
- `roles/*.json` are re-merged on every load.
- Evidence can go stale across a rework cycle.
- The scrum stub size row in `size-budget.json` guards little; the `core+scrum` budget ratchets down from 45238 B (spec target 40960 B).
- Kanban WIP limits bound active cards (`in_progress`, `blocked`, `awaiting_human`); cards the engine advanced into a column's queue are reported as `queued` and surfaced by operations-review, not refused.
- Kanban `wipBypass` is the total number of extra slots a column grants while any expedite is active, not one per expedite.
- Kanban cadences use `item.completed` counts as turns; a wall-clock cadence schedule is the host's job.
- Minor test gaps: retro duplicate-ref rejection, `writeAtomic` failure path, thin CLI usage and `decide` tests.
- Waterfall traceability is keyed by phase ids, not item types (spec §10 wording); links are read in both directions.
- Waterfall `editItem`/`addItem` called directly (not through `applyAction` or the CLI) bypass `baseline-immutable`.
- Waterfall phase budgets reuse `Iteration`; `exwf status` shows the open phase as `openIteration`. With no accounting history the planner estimates 20000 tokens per weight unit, so a small phase budget dispatches nothing until `next({ fallbackTokensPerWeight })` is passed or history exists.
- Phase retrospective applies `agreement` lessons only; other suggested changes are stored for the host.

## Development gate

There is no hosted CI. A husky pre-commit hook runs the local gate on every commit
(`pnpm format:check && pnpm lint && pnpm typecheck && pnpm schema:check && pnpm test`); `pnpm run ci` adds the
minified build, the dist identity check and the size ratchet, and `prepublishOnly` runs it
before any publish. oxfmt and oxlint need Node ^20.19 or >=22.12 on the developer machine; the
package itself supports Node >=18 (verified on ubuntu, macOS and Windows x Node 18/20/22
before the hosted workflow was removed).

## Publishing

For the owner. The `stage` dist-tag keeps `latest` free for 0.1.0:

```sh
pnpm run ci && npm publish --tag stage
```

## Design principles

1. One engine, three methodologies, modelled as completely as the canonical texts describe them (Scrum Guide 2020; the Kanban Method's six practices, cadences, classes of service and flow metrics; classic phase-gate Waterfall with change control and traceability).
2. The program decides, the LLM executes. Which item may move, who may approve, whether a stage may start: engine, not prompt.
3. Roles are data. Methodologies reference capabilities, never role names.
4. Pure, serialisable state. Every operation is `(state, action) -> state` or `(state) -> view`. No I/O in core.
5. Zero runtime dependencies beyond `ex-flow` and `exsorted` (both MIT, both the owner's). Runs on Node on macOS, Linux and Windows.
6. Errors resolve: every violation names the exact rule, the exact item, and a concrete fix.

## License

MIT
