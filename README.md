# ex-workflow

Methodology engine for AI teams. Scrum, Kanban and Waterfall (Scrum today; Kanban and Waterfall follow) are modelled as data (stages, roles, policies, gates, ceremonies) and driven by a pure state machine on top of the [`ex-flow`](https://www.npmjs.com/package/ex-flow) DAG planner. The program decides, the LLM executes: which item may move, who may approve, whether a sprint may close is enforced by the engine, not by a prompt.

State is plain JSON, every operation is `(state, action) -> state`, and every error names the rule, the item and a concrete fix. Core performs no I/O; a small file adapter and the `exwf` CLI sit on top. Runtime dependencies are exactly `ex-flow` and `exsorted`.

## Install

```sh
pnpm add ex-workflow@stage
```

The first pre-release is published under the `stage` dist-tag (`0.0.0-stage`); `latest` is reserved for 0.1.0.

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

## CLI

State lives in `.workflow/`. Every command prints JSON; errors exit 1, bad usage exits 2.

| Command | Returns |
|---|---|
| `init <scrum> --config <file> [--roles <file>]` | `{ ok, state: { methodology, stages, roles } }` |
| `add <item.json>` | `{ ok, item }` |
| `edit <id> <patch.json>` | `{ ok, item }` |
| `next [--max n]` | `{ ok, reason, briefs }`; writes `.workflow/briefs/<id>.json` |
| `complete <id> <handoff.json> --tokens-in n --tokens-out n --duration-ms n --model m [--role r]` | `{ ok, item, warnings }` |
| `ceremony <name> [input.json] [--by who]` | `{ ok, warnings, lastEvent }` |
| `decide <pendingId> approve\|reject --by who [--note text]` | `{ ok, item }` |
| `status` | `{ ok, methodology, openIteration, counts, pending, lastEvent }` |
| `board` | `{ ok, columns }` |
| `metrics` | `{ ok, metrics }` |
| `pending` / `lessons` | the arrays |
| `validate <action.json>` | `{ ok: true, violations }` |
| `role add <manifest.json>` / `role list` | `{ ok, roles }` |

`--by` defaults to `human`.

### Concurrency

One writer at a time per `.workflow/`: `exwf` serialises writers with `.workflow/state.lock` (created exclusively, retried for about two seconds, taken over when older than 60 s). If a crashed process left the lock behind and a command reports that another `exwf` holds it, delete the file. Read-only commands do not lock. Use `withStateLock` from `ex-workflow/adapters` when you write state yourself.

## Layers

```
L3  MCP server (planned)    daemon, hook enforcement, dashboard, team mode
L2  agent adapters          Claude Code agents/*.md, future Cursor/Codex formats   (planned)
L1  skills                  SKILL.md + scripts/wf.js (bundled L0)                   (planned)
L0  ex-workflow             this spec: state, policy, planner, accounting          (npm, free)
```

This package is L0. All layers read and write the same `.workflow/` files.

## Status

0.0.0-stage is a pre-release for integration testing: core + Scrum, adapters and the `exwf` CLI. Expect changes before 0.1.0. Kanban and Waterfall follow. Design: [docs/superpowers/specs/2026-10-19-ex-workflow-design.md](docs/superpowers/specs/2026-10-19-ex-workflow-design.md).

## Known backlog

Minor items deferred past 0.0.0-stage:

- Stale-lock takeover can race when a lock is older than 60 s.
- `decide(approve)` ignores a `needs-review` verdict.
- `setDod` hard-codes the `review` stage id in the Scrum methodology.
- The `closing` sprint state is not enforced on commit, plan or uncommit.
- State is written before briefs; a crash between the two leaves them out of step.
- `roles/*.json` are re-merged on every load.
- Evidence can go stale across a rework cycle.
- The scrum stub size row in `size-budget.json` guards little; the `core+scrum` budget ratchets down from 45238 B (spec target 40960 B).
- Minor test gaps: retro duplicate-ref rejection, `writeAtomic` failure path, thin CLI usage and `decide` tests.

## Publishing

For the owner. The `stage` dist-tag keeps `latest` free for 0.1.0:

```sh
pnpm run ci && npm publish --tag stage
```

## Design principles

1. One engine, three methodologies (Scrum today; Kanban and Waterfall follow), modelled as completely as the canonical texts describe them (Scrum Guide 2020; the Kanban Method's six practices, cadences, classes of service and flow metrics; classic phase-gate Waterfall with change control and traceability).
2. The program decides, the LLM executes. Which item may move, who may approve, whether a stage may start: engine, not prompt.
3. Roles are data. Methodologies reference capabilities, never role names.
4. Pure, serialisable state. Every operation is `(state, action) -> state` or `(state) -> view`. No I/O in core.
5. Zero runtime dependencies beyond `ex-flow` and `exsorted` (both MIT, both the owner's). Runs on Node on macOS, Linux and Windows.
6. Errors resolve: every violation names the exact rule, the exact item, and a concrete fix.

## License

MIT
