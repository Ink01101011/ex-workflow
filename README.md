# ex-workflow

Methodology engine for AI teams. Scrum, Kanban and Waterfall are modelled as data (stages, roles, policies, gates, ceremonies) and driven by a pure state machine on top of the [`ex-flow`](https://www.npmjs.com/package/ex-flow) DAG planner. The program decides, the LLM executes: which item may move, who may approve, whether a sprint may close is enforced by the engine, not by a prompt.

State is plain JSON, every operation is `(state, action) -> state`, and every error names the rule, the item and a concrete fix. Core performs no I/O; a small file adapter and the `exwf` CLI sit on top. Runtime dependencies are exactly `ex-flow` and `exsorted`.

## Install

```sh
npm install ex-workflow
```

`npm install ex-workflow` resolves to 1.0.0 (`pnpm add ex-workflow` likewise). Stage pre-releases may still appear under the `stage` dist-tag.

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

Cadences are ceremonies: `replenishment`, `delivery-planning`, `service-delivery-review` (WIP, policies, SLEs), `operations-review` (blockers, aging WIP), `risk-review` (fixed-date risk, stale blockers), `strategy-review` (classes of service). `exwf status` reports which cadences are due (`config.cadences.<name>.everyTurns`). `delivery-planning` needs a non-empty `items` list, and the `operations-review` assign entries need an existing blocker id. `test/kanban.e2e.test.ts` is a full week with an expedite, an escalation and a blocker.

`next()` also returns `skipped`: each ready card it did not pull, with `reason` (`entry-policy`, `wip`, `resource-cap` or `budget`) and a `detail`; the commitment column's policies gate the pull out of it (escalation `question` cards are exempt, as from exit policies and gates). Ordering is by class band (question, expedite, fixed-date, standard, intangible) and, with `fairness.aging` on (the default), priority stays primary inside a window of `fairness.maxDeferralRounds` passes (default 5); each full window a card is passed over promotes it one step above any priority difference, and an intangible card reaching the first window is ranked as standard, so nothing is starved.

`service-delivery-review` also takes `lessons`, `adopt`, `dismiss` and `retire`, with the Scrum retro semantics for agreements.

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

`add` and `edit` validate `traces` ids and the impact analysis of a change-request, and `status` phase rows carry `missingTraces`.

## CLI

State lives in `.workflow/`. Every command prints JSON; errors exit 1, bad usage exits 2.

| Command | Returns |
|---|---|
| `init <scrum\|kanban\|waterfall> --config <file> [--roles <file>]` | `{ ok, state: { methodology, stages, roles } }` |
| `add <item.json>` | `{ ok, warnings, item }` (checked by the methodology rules) |
| `edit <id> <patch.json>` | `{ ok, warnings, item }` (checked by the methodology rules) |
| `next [--max n] [--fallback-tokens-per-weight n]` | `{ ok, reason, skipped, briefs }`; writes `.workflow/briefs/<id>.json`. `--fallback-tokens-per-weight` prices a candidate when there is no accounting history (default 20000 per weight unit, or `ScrumConfig.fallbackTokensPerWeight`) |
| `complete <id> <handoff.json> --tokens-in n --tokens-out n --duration-ms n --model m [--role r] [--estimate]` | `{ ok, item, warnings }`. Zero tokens is refused unless `--estimate` marks the line as a placeholder; correct it later with `account` |
| `account <item> [--line n] [--tokens-in n] [--tokens-out n] [--duration-ms n] [--model m] [--by who]` | `{ ok, line, event }`: rewrites one accounting line of an item (the last by default), adjusts the owning sprint or phase, clears the placeholder flag and records `accounting.corrected` |
| `ceremony <name> [input.json] [--by who]` | `{ ok, warnings, lastEvent }` |
| `decide <pendingId> approve\|reject --by who [--note text]` | `{ ok, item }` (runs the methodology's `afterDecide`, e.g. a Waterfall phase baseline) |
| `config set <patch.json> [--by who]` | `{ ok, warnings, changed, config }`: merges a patch into the methodology config between iterations (refused while an iteration is open, and for locked keys); the merge is shallow: top-level keys replace wholesale, so `{ "sprintBudget": { "tokens": N } }` drops `turns`/`wallclockMs` |
| `unblock <item> [--blocker id] [--note text] [--by who]` | `{ ok, warnings, item }`: clears the named open blocker, or every open one |
| `status` | `{ ok, methodology, openIteration, counts, pending, openQuestions, lastEvent, report }` (`openQuestions` lists the questions a `done` completion left open; `report` is the methodology's own status: Scrum's closing sprint, Kanban's cadences due, Waterfall's phases, pending gates and traceability coverage) |
| `board` | `{ ok, columns }` |
| `metrics` | `{ ok, metrics }` (Scrum adds `current`, the open sprint's spent, committed and done weight, cost per point and budget utilisation; zeros when no sprint is open) |
| `pending` / `lessons` | the arrays |
| `validate <action.json>` | `{ ok: true, violations }` |
| `role add <manifest.json>` / `role list` | `{ ok, roles }` |

`--by` defaults to `human`.

### Scrum configuration

`init scrum --config <file>` takes a `ScrumConfig`. Three keys were added in 0.5.0-stage, all optional:

- `autoClose` (default `true`): close the sprint automatically when its budget is spent and nothing is in flight. `false` leaves an exhausted sprint in `closing` until `ceremony review` or `ceremony cancel` closes it, so the human gate is never skipped.
- `estimateMode` (`"per-weight"` by default, or `"per-call"`): how the planner and `plan auto` price a candidate. `per-weight` uses the median tokens per weight unit from history. `per-call` uses the median tokens per completion regardless of weight, which fits a host that bills one all-inclusive total per worker call.
- `fallbackTokensPerWeight` (default 20000): tokens per weight unit when there is no history.

The planner gates on every budget dimension. `sprintBudget.turns` counts one per completion, so a host with a calls budget sets `turns` and `estimateMode: "per-call"` rather than a `calls` key.

### Scrum retrospective

`ceremony retro <input.json>` runs between sprints. Its input:

- `lessons[]`: `{ text, scope, from?, item?, suggestedChange? }`. `from` is `"human"` or a role id (default: the `--by` who); `item` must name an existing item.
- `adopt[]` / `dismiss[]`: raised lessons, by id, each once.
- `retire: string[]`: agreement texts to remove, matched by exact text (never by index). An agreement that is not current fails `invalid-input` and lists the current ones.
- `suggestedChange` (on a lesson or an adopt entry): `{ kind: "agreement", text, replaces? }` adds a working agreement, and `replaces` retires the earlier agreement with that exact text; `{ kind: "dod", policy }` appends one Definition of Done policy; `{ kind: "backlog", item }` queues work; `{ kind: "skill", note }` is for the host.
- `dodChanges: Policy[]` replaces the whole Definition of Done. Dropping a current policy is refused by `dod-not-weakened` unless the retro input also sets `allowWeaken: true`.

`ceremony refine` takes `reestimate: string[]`: confirm the weight of backlog items (each gets `item.reestimated`) without changing them. An item carried over from `review` re-enters at review and is not re-estimated.

### Concurrency

One writer at a time per `.workflow/`: `exwf` serialises writers with `.workflow/state.lock` (created exclusively, retried for about two seconds, taken over when older than 60 s). If a crashed process left the lock behind and a command reports that another `exwf` holds it, delete the file. Read-only commands do not lock. Use `withStateLock` from `ex-workflow/adapters` when you write state yourself.

### Schema

`ex-workflow/schema` exports JSON Schema (draft-07) documents generated from the TypeScript types — `workflowStateSchema`, `roleSchema`, `newItemSchema`, `itemPatchSchema`, `handoffSchema`, `scrumConfigSchema`, `kanbanConfigSchema`, `waterfallConfigSchema` — and a small validator with no runtime dependencies:

```ts
import { assertValid, validate, workflowStateSchema } from "ex-workflow/schema";

const errors = validate(workflowStateSchema, JSON.parse(raw)); // SchemaError[] with JSON-pointer paths
assertValid(workflowStateSchema, JSON.parse(raw), ".workflow/state.json"); // throws WorkflowError("invalid-input")
```

`exwf` validates `state.json`, role manifests, item files, `exwf edit` patches, `--roles` files and handoff files with these schemas before acting on them, and `saveState` validates a state before writing it, so the CLI cannot write a file the loader would refuse. The documents are standard JSON Schema, so editors and ajv read them too. They are regenerated with `pnpm schema:gen`; `pnpm schema:check` (in `ci` and the pre-commit hook) fails when they drift from the types.

## Layers

```
L3  MCP server (planned)    daemon, hook enforcement, dashboard, team mode
L2  agent adapters          Claude Code agents/*.md, future Cursor/Codex formats   (planned)
L1  skills                  SKILL.md + scripts/wf.js (bundled L0)                   (planned)
L0  ex-workflow             this spec: state, policy, planner, accounting          (npm, free)
```

This package is L0. All layers read and write the same `.workflow/` files.

## Status

1.0.0 (2026-10-24) closes the Phase 7 engine gaps (#23-#27) and freezes the public API (exports, CLI commands, schema documents, event kinds — test/api-surface.json) with a compatibility test over state files from every stage release; from here versioning is semver and `latest` is the supported line. 0.6.0-stage closed the Phase 6 backlog: every item the 1.0 definition named is either fixed or an accepted limitation (see [Accepted limitations](#accepted-limitations)). 0.5.0-stage closes the engine gaps from the workflowAI dogfood (Scrum budget gates, configuration between iterations, accounting corrections, agreements that can be replaced or retired, question briefs with their parent); see [CHANGELOG.md](CHANGELOG.md). 0.4.0-stage added `ex-workflow/schema` (JSON Schema documents and a validator, checked by `exwf` on load and on input). 0.3.0-stage added the Waterfall module; all three methodologies ship. Design: [docs/superpowers/specs/2026-10-19-ex-workflow-design.md](docs/superpowers/specs/2026-10-19-ex-workflow-design.md).

## Accepted limitations

The 1.0 definition requires every known gap to be fixed or accepted as a documented limitation. These are the accepted ones (design spec, section 22). Each has one line of reasoning.

- Stale-lock takeover (B01): the re-stat narrows the race to the gap between the stat and the `unlink`, which no portable call closes; `ino` may be 0 (FAT/exFAT, some shares), in which case only the mtime is compared.
- Conflict of interest (B02): `"conflict-of-interest"` stays a declared, reserved `ErrorCode` that is never thrown, and the core rule matching action type `complete` stays dormant; `checkGate` already refuses the case as `gate-unmet`, and removing the code would narrow a public type.
- Blockers (B03): a blocker is owned by a human, and clearing it would need a link from the follow-up that the schema does not carry; `exwf unblock` is the path.
- Scrum stage ids (B06): `backlog`, `sprint` and `review` are owned by the module (about twenty uses); init refuses a config that lacks them.
- Uncommit while closing (B07): `ceremony uncommit` stays allowed during `closing` because it only shrinks the sprint.
- Roles on load (B09): state wins on an id conflict, `exwf role add` is the audited path, and re-merging is idempotent.
- Scrum size row (B11): budgets sit at measured size by the owner's standing decision; the row stays as a tripwire.
- Kanban WIP (B12): the engine must not refuse a card it advanced itself; operations-review surfaces queued cards.
- Kanban `wipBypass` (B13): it is a column total; re-scoping the key after 1.0 would break configs.
- Kanban cadences (B14): the key is `everyTurns` because the engine has no clock; wall-clock schedules are the host's job.
- Waterfall traceability (B16): it is keyed by phase ids because the core item union has no requirement, design or test types; phase membership classifies items.
- Direct primitives (B17): `editItem` and `addItem` bypass `baseline-immutable` by design; `applyAction` and the CLI enforce it.
- Phase budgets (B18): a phase budget reuses `Iteration` and `status` shows `openIteration`; the naming is accepted, and `fallbackTokensPerWeight` covers the no-history case.
- Phase retrospective (B19): baselines and config are locked in Waterfall, so only `agreement` lessons apply; `dod` and `backlog` suggestions are stored for the host.
- Accounting outside sprints (B23): a line whose `endedAt` lies outside every sprint window has no sprint to charge.
- Waterfall deliverables (B10): `deliverables-present` aggregates raw item evidence while stage gates use fresh evidence; the two diverge only when one config uses both.
- Rework in flight (B10): an item reworked mid-flight in a state written before 0.6.0-stage needs fresh evidence before it can pass.
- Flag values (B24): CLI flags take `--flag value` only; a value beginning with `--` must come via a JSON input file; `--flag=value` is not supported.
- Stale lock unlink: `withStateLock` retries without reaching the retry cap when a stale lock's unlink keeps failing (EPERM, read-only directory); delete the file by hand.
- Scrum `status.report.reason`: it is always `budget`; the engine has no other closing cause yet.
- Carryover in an unflagged stage (B22): a carryover that was `blocked` or `awaiting_human` in a stage without `review: true` restarts at the sprint start and needs a reestimate; only a stage flagged `review`, or an item still at status `review`, resumes where it was. Flag the stage `review: true` to resume there.

## Development gate

There is no hosted CI. A husky pre-commit hook runs the local gate on every commit
(`pnpm format:check && pnpm lint && pnpm typecheck && pnpm schema:check && pnpm test`); `pnpm run ci` adds the
minified build, the dist identity check and the size ratchet, and `prepublishOnly` runs it
before any publish. oxfmt and oxlint need Node ^20.19 or >=22.12 on the developer machine; the
package itself supports Node >=18 (verified on ubuntu, macOS and Windows x Node 18/20/22
before the hosted workflow was removed). `pnpm test` includes the compatibility fixtures (`test/fixtures/compat`, `state.json` files written by the published 0.1.0, 0.2.0, 0.3.0, 0.4.0 and 0.6.0 stage releases; 0.5.0-stage was never published); `node scripts/gen-compat-fixtures.mjs` regenerates them (network needed). Schema drift is guarded by `pnpm schema:check` alone, not by a test, because the generator needs Node >=22 and the test suite must run on >=18.

## Publishing

For the owner. A release moves `latest`:

```sh
pnpm run ci && npm publish
```

Use `npm publish --tag stage` only for a pre-release.

## Design principles

1. One engine, three methodologies, modelled as completely as the canonical texts describe them (Scrum Guide 2020; the Kanban Method's six practices, cadences, classes of service and flow metrics; classic phase-gate Waterfall with change control and traceability).
2. The program decides, the LLM executes. Which item may move, who may approve, whether a stage may start: engine, not prompt.
3. Roles are data. Methodologies reference capabilities, never role names.
4. Pure, serialisable state. Every operation is `(state, action) -> state` or `(state) -> view`. No I/O in core.
5. Zero runtime dependencies beyond `ex-flow` and `exsorted` (both MIT, both the owner's). Runs on Node on macOS, Linux and Windows.
6. Errors resolve: every violation names the exact rule, the exact item, and a concrete fix.

## License

MIT
