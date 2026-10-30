# Changelog

## 1.1.1 (2026-10-30)

Fix wave for the ten findings of the 1.1.0 code review (Investigation and Experimentation); the decisions are in the design spec, section 25. No new ceremony, key, export, event kind or schema document.

- Investigation records are closed objects (R1): a `hypotheses` entry, the `experiment` and its `predictions` entries, the `result` and an `assessments` entry with an unknown key are refused `invalid-input` naming the key. 1.1.0 copied them into `state.json`, which `saveState` then rejected with an error pointing at the state file. Stored records are copied field by field.
- `preregister` after the round limit or the budget is spent is refused `invalid-input` with the fix naming `stop` (R6); 1.1.0 discarded the experiment, closed the investigation `stopped` and answered `ok: true`.
- `intake` refuses a workflow of another methodology and runs through the rules like every other ceremony (R7); 1.1.0 could graft an investigation record and iteration onto a Scrum, Kanban or Waterfall state.
- Experimentation ceremonies accept an input property whose value is `undefined` (R2), as `JSON.stringify` drops it; a host forwarding `{ by, now: options.now, ...input }` was refused `ceremony input must be JSON-safe`.
- `validate` of a candidate the planner dispatched (`next`) is refused `invalid-input` while its item is still `in_progress`, with the fix naming `complete` (R3): validating first moved the item to `done`, so the builder's `complete` failed and its accounting was never recorded. A candidate the host started by ceremony (`start`) is validated as before.
- A closed experiment keeps the `endedAt` and `outcome` of its iteration (R5); in 1.1.0 every later ceremony (`cleanup`) re-stamped them.
- The two `item.dispatch` checks of the `experimentation-lifecycle` rule are removed (R4): no action of that type exists, so they never ran; `candidates()`, `provision` and `start` already refuse dispatch on a stopped or exhausted experiment.
- Internal: the investigation ceremonies build their methodology once per factory (R9); experimentation spent totals and config are computed once per ceremony instead of once per budget dimension (R8).
- Finding 10 (the investigation `roleFor` throws `missing-capability` from `next` when no independent deliver role exists) is kept: core `assignRole` throws the same code in the same situation for every methodology, and the error names the item and the fix.

Compatibility: no `state.json`, schema document, event kind, export or CLI change; `VERSION` is `"1.1.1"`. Behaviour changes, all for inputs 1.1.0 accepted and then lost or mis-recorded: an unknown key in an investigation record is refused; `preregister` when exhausted is refused instead of closing the investigation; `intake` on a foreign workflow is refused; `validate` of a planner-dispatched candidate waits for the builder's completion; `now: undefined` is accepted; `endedAt` no longer drifts after closure. Size budgets re-recorded at measured size.

## 1.1.0 (2026-10-28)

Two standalone methodologies, Investigation (#37) and Experimentation (#38); the decisions are in the design spec, section 24. The research reports in `docs/research/` were the input; the standalone decision supersedes their composition recommendation.

- Investigation (`ex-workflow/investigation`, #37): `investigation()` with config `{ question, maxRounds, budget }`, roles `investigator`, `replay-worker`, `conclusion-reviewer`, stages `intake`, `execute`, `observed`, and the ceremonies `intake`, `hypotheses`, `preregister`, `observe`, `update-belief`, `conclude`, `review-conclusion`, `stop`. Competing falsifiable hypotheses, preregistered runs executed as items through `next` and `complete`, recorded observations (invalid runs included), belief updates, independent replay and an independent conclusion review before a conclusion is `resolved`; `inconclusive` and `stopped` are first-class outcomes; rounds and budget are bounded.
- Experimentation (`ex-workflow/experimentation`, #38): `experimentation()` with config `{ objective, direction, tieBreak, concurrencyCap, maxCandidates, candidateBudget, totalBudget }`, roles `coordinator`, `builder`, `validator`, `integrator`, stages `candidate`, `building`, `validation` (gate `experiment-validation`), `done`, and the ceremonies `freeze`, `provision`, `start`, `submit`, `validate`, `compare`, `integrate`, `validate-integration`, `terminate`, `stop`, `cleanup`. Frozen baseline SHA and harness, isolated workspaces recorded by identity, bounded per-candidate and total budgets, independent validation at the exact submitted SHA, deterministic ranking (score, then candidate id), exact-SHA promotion and fresh validation of the integration SHA; all-fail produces no winner.
- CLI: `exwf init investigation` and `exwf init experimentation`; `ceremony`, `next`, `complete`, `status`, `metrics` and the persistence commands work unchanged.
- Schema: `investigationConfigSchema` and `experimentationConfigSchema` in `ex-workflow/schema`; `workflowStateSchema` covers the new optional lifecycle records, so `loadState` validates them.
- Planner: `PlannerOptions.reservedTokens` (optional) deducts tokens reserved for in-flight work from the iteration remainder; Experimentation sets it for running candidates; omitted, dispatch is unchanged.
- Examples: `scripts/example-investigation.ts` and `scripts/example-experimentation.ts`, synthetic and asserted, run with `pnpm exec tsx`.
- API-surface test: event kinds are now collected from the TypeScript AST instead of a regex; the 1.0.0 list carried one false positive (`needs-review`, a verdict string, never an event), so the real count moves from 51 to 69.

Compatibility: additive. `MethodologyName` gains `investigation` and `experimentation`; `WorkflowState` gains the optional `investigation` and `experimentation` records, written only by those methodologies; the schema documents go from eight to ten; 18 event kinds are added (`investigation.*` 7, `experimentation.*` 11); `PlannerOptions` gains `reservedTokens`. A `.workflow/state.json` written by 1.0.x loads unchanged. Scrum, Kanban and Waterfall behaviour, payloads and messages are unchanged; their minified single-entry bundles grow by 59 B each for the planner hook (budgets at measured). `VERSION` is `"1.1.0"`.

## 1.0.1 (2026-10-24)

Documentation release; no code, schema, CLI or `state.json` change.

- README rewritten for users of the package: a contents table, a methodology comparison (roles, flow, ceremonies, metrics), the run loop, quick starts for Scrum, Kanban and Waterfall, the `.workflow/` layout, the full CLI reference, configuration keys per methodology, every ceremony with its input shape, the item, brief, handoff and accounting contracts, the error shape with every code, the JSON Schema entry point, the package entry points, the compatibility promise and the known limitations written as what happens and what to do.
- Removed from the README: the workflowAI layer roadmap, the per-stage status history, the development gate, the publishing notes and the internal reasoning behind each accepted limitation; the design spec and CHANGELOG keep that history.
- `VERSION` is `"1.0.1"`.

## 1.0.0 (2026-10-24)

First stable release, published to `latest`. Phase 7 fixes the five engine gaps the workflowAI S2 dogfood raised (#23-#27) and closes the 1.0 definition; the decisions are in the design spec, section 23.

- Trace and reopen ids (#23): a Waterfall `item.add` or `item.edit` is refused (`rule-violation`) when a `traces` id does not name an existing, non-dropped item, or when a change-request's `impactAnalysis.reopen` names a phase that is not configured; the fix lists the ids or phases that are valid.
- Impact analysis at add (#24): with `changeControl.requiresImpactAnalysis: true`, a change-request without an impact analysis is refused at `item.add` and `item.edit`, and a present one is shape-checked (`summary`, `reopen`, `weight`).
- Coverage recount (#25): the traceability matrix no longer counts change-requests; `waterfallMetrics.requirementsTraced`, `requirementsTotal` and `requirementCoverage` are computed from the same matrix as `status.report.coverage`, so the two agree.
- `readyForGate` (#26): `readyForGate` is true as soon as the gate would pass; `PhaseReportRow` gains `missingTraces`, and the generated `traceability-matrix` counts as present for the last traced phase when nothing is missing.
- Kanban lessons (#27): `service-delivery-review` takes `lessons`, `adopt`, `dismiss` and `retire` with the Scrum retro semantics for agreements; the `cadence.service-delivery-review` payload gains five arrays (`lessons`, `adopted`, `dismissed`, `agreements`, `retired`).
- Shared lesson helper: the Scrum `retro`, the Waterfall `phaseRetrospective` and the Kanban review share one core helper (`src/lessons.ts`), so a malformed `lessons[]` or `adopt[]` entry on the Scrum retro is refused `invalid-input` (`retro.lessons entries need a text and a scope`) where it was silently accepted before; valid inputs, payloads and messages are unchanged.
- Compatibility test: `test/compat.test.ts` loads `state.json` fixtures written by the published 0.1.0, 0.2.0, 0.3.0, 0.4.0 and 0.6.0 stage releases (`test/fixtures/compat`, regenerated by `scripts/gen-compat-fixtures.mjs`) and runs `status`, `metrics` and `next` on each; 0.5.0-stage was never published.
- API-surface freeze: `test/api-surface.test.ts` compares the runtime exports of the five entry points, the CLI `USAGE` lines (10), the schema documents (8) and the event kinds (52) with `test/api-surface.json`; a removal is now a major version, an addition a minor one.

Migration: from any 0.N.0-stage a `.workflow/state.json` loads unchanged; the compatibility test proves it for every stage release. Coming from an earlier stage, the behaviour changes of 0.5.0 and 0.6.0 listed below apply. New in 1.0.0: a Waterfall `add` or `edit` is refused for an unknown `traces` or `reopen` id and for a change-request without an impact analysis when the config requires one (#23, #24); `status.report.coverage` and `metrics.requirements*` no longer count change-requests and agree with each other (#25); `readyForGate` is true as soon as the gate would pass (#26); Kanban `service-delivery-review` takes lessons (#27); a malformed `lessons[]`, `adopt[]` or `dismiss[]` entry on the Scrum `retro` is refused `invalid-input` (shared helper); `PhaseReportRow.missingTraces` is added and the `cadence.service-delivery-review` payload gains five arrays. No schema document, event kind or `state.json` change. Versioning from here: semver, `latest`.

## 0.6.0-stage (2026-10-24)

Pre-release under the `stage` dist-tag. Phase 6 (backlog zero) fixes or explicitly accepts all 24 items the 1.0 definition named; the decisions are in the design spec, section 22, and the accepted limitations are in the README.

- Stale-lock takeover (B01): the lock is re-stat'd (inode and mtime) immediately before `unlink`; a lock changed between the staleness check and the unlink is not taken over; the takeover is retried and the lock-held error follows after the retry cap. The residual window between the stat and the unlink is accepted.
- Completion rules (B02): `complete()` runs the methodology rules through `applyAction` with action type `item.complete` after validation, so rule hooks see completions; `checkGate` still answers `gate-unmet` for a conflict of interest.
- Gate approval (B05): `decide(approve)` honours a `needs-review` verdict from the item's last `item.completed` event and advances to the review stage.
- Scrum status (B04): `exwf status` reports a `report` for Scrum (`{ closing, sprint, reason, inFlight }`), so a sprint left in `closing` is flagged.
- Scrum closing (B07): the `sprint-closing` rule refuses `ceremony commit` into a closing sprint; `uncommit` stays allowed.
- Scrum stage ids (B06): `init` refuses a Scrum config whose stages lack `backlog`, `sprint` or `review` (`config-invalid`).
- CLI write order (B08): `next` and `complete` write briefs and handoff files before the state.
- Evidence freshness (B10, semantic change, own commit): policies and gates count only evidence recorded after the item's last `item.rework` event; revert that commit alone to restore append-only evidence.
- Test gaps (B15): `writeAtomic` failure path, `decide` reject and unknown-pending cases, and a usage exit-2 test per command group.
- Planner budgets (B20): `plan auto` applies the `tokens` and `turns` limits together.
- Carryover (B22): a carryover blocked or awaiting human in the review stage resumes at review, as `review` already did.
- Waterfall fallback (B18): `WaterfallConfig.fallbackTokensPerWeight` (optional) feeds the planner like Scrum's `fallbackTokensPerWeight`.
- Waterfall lessons (B21): phase retrospective lessons carry `from` and `item`, as in Scrum (`from` defaults to the retro's `by`).
- Valueless flags (B24): a value-taking flag given without a value is `invalid-input` naming the flag; `--estimate` is the only boolean flag.

Compatibility: no `state.json` schema change and no new event kind; every `.workflow/state.json` written by an earlier stage loads unchanged. The generated `WaterfallConfig` schema document gains one optional key, `fallbackTokensPerWeight`. Behaviour changes, all deliberate: rules run on `item.complete` (B02); custom rules on `item.complete` can refuse a completion (`rule-violation`) and their warnings are returned; `decide(approve)` honours `needs-review` (B05); `ceremony commit` is refused into a closing sprint (B07); a freshly reworked item needs fresh evidence before it passes (B10); a blocked or awaiting-human carryover in review resumes at review (B22); `plan auto` applies tokens and turns together (B20); a value-taking flag without a value is refused (B24); Scrum's `status.report` is no longer `null`.

## 0.5.0-stage (unreleased; never published, shipped inside 0.6.0-stage)

Pre-release under the `stage` dist-tag. Phase 5 closes the engine gaps the workflowAI scrum-master dogfood raised (issues #8–#21); the decisions are in the design spec, section 21.

- Planner budget gates and `closing` (#16): the planner gates on `turns` and `wallclockMs` as well as `tokens`; in-flight items are counted by the iteration's committed list as well as `item.iteration`; a spent dimension skips each ready item with reason `budget` and answers `budget-exhausted`; an iteration in `closing` answers `budget-exhausted`, not `no-candidates`. `ScrumConfig.autoClose: false` keeps an exhausted sprint in `closing` until `review` or `cancel` closes it.
- Estimate mode, fallback and CLI flag (#21): `ScrumConfig.estimateMode` (`per-weight` or `per-call`) and `ScrumConfig.fallbackTokensPerWeight`; `exwf next --fallback-tokens-per-weight n`.
- Zero accounting and `exwf account` (#9): `complete()` refuses 0 tokens unless the handoff is declared an estimate (`exwf complete --estimate`); `correctAccounting` and `exwf account` correct one line of an item's accounting, adjust the owning sprint or phase, and record `accounting.corrected`; Scrum metrics fold corrections made after a sprint closed into its frozen `spent`.
- `metrics.current` (#15): mid-sprint figures for the open sprint (spent, committed and done weight, cost per point, budget utilisation), all zero when no sprint is open.
- `changeConfig` / `exwf config set` (#8): change the methodology config between iterations, re-validated and recorded as `config.changed`; keys a methodology locks (Kanban `columns` and `classesOfService`, Waterfall `phases`, `traceability` and `humanGates`) are refused.
- `exwf unblock` (#17): clears a named blocker (`--blocker`) or every open one, with an optional `--note`.
- Open-questions warning and `status.openQuestions` (#14): a `done` or `needs-review` completion that carries open questions warns `open-questions-ignored`; `exwf status` lists the questions still open.
- Question brief `parent` (#19): a brief for a question item carries its parent's last completion (handoff, produced, open questions, do-not).
- Review carryover (#10): an item carried over from the review stage re-enters at `review` on the next `plan` or `commit` and is not re-estimated.
- `refine.reestimate` (#11): confirm a backlog item's weight without changing it; satisfies the carryover re-estimate rule.
- `plan auto` skipped (#18): `plan auto` skips a candidate that fails the backlog exit policy or does not fit the remaining budget, keeps walking, and reports each skip in `sprint.opened`.
- `dod-not-weakened` at retro (#20): a retro between sprints that drops a Definition of Done policy is refused unless `allowWeaken: true`; `dodChanges` replaces the whole list, `suggestedChange { kind: "dod" }` appends one.
- Agreements replace and retire (#12): a retro lesson's agreement may `replaces` an earlier one, and `retire` lists agreements to remove, matched by exact text; Waterfall's phase retrospective shares the helper.
- Lesson `from` and `item` (#13): a retro lesson is attributed to a role (or `human`) and may name an item; `from` defaults to the retro's `by`.
- Events and hooks: `Methodology.lockedConfigKeys` and `afterConfigChange`; `estimateTokens(state, weight, fallback, mode)`; new event kinds `agreement.retired` and `item.reestimated`; payload additions `item.completed.open_questions`, `sprint.opened.skipped` / `resumed`, `sprint.committed.resumed`, `blocker.cleared.note` and retro `retired`.

Compatibility: every `.workflow/state.json` written by an earlier stage loads unchanged (every new field is optional). Behaviour changes, all deliberate: a 0-token completion now needs `--estimate`; `plan auto` no longer aborts on an incomplete candidate and keeps walking past one that does not fit; a review-stage carryover re-enters at `review`; a retro that drops a DoD policy between sprints needs `allowWeaken: true`; `next` reports `budget-exhausted` for a spent turns budget and for a sprint in `closing`.

## 0.4.0-stage (2026-10-23)

- Schema entry (`ex-workflow/schema`): JSON Schema (draft-07) documents generated from the TypeScript types for `WorkflowState`, `Role` (manifest), `NewItem`, `Handoff`, `ScrumConfig`, `KanbanConfig`, `WaterfallConfig`, plus a dependency-free `validate` / `assertValid` for the subset the generator emits. `pnpm schema:check` fails the build when the types and the committed schema drift.
- Adapters: `loadState` validates `.workflow/state.json` and every `roles/*.json` manifest against the schema after the version check; a state that fails is never returned.
- CLI: `exwf add`, `exwf complete` and `exwf role add` validate their input file before the engine sees it; errors name the file, the JSON pointer and the expected shape.
- Compatibility: a `.workflow/state.json` written by any earlier stage loads unchanged (every field added since 0.1.0-stage is optional). Two inputs that used to be accepted are now refused, with the file and JSON pointer named: extra keys in `state.json` or in an item (every object is closed), and `roles/*.json` manifests that carry only an `id` (a manifest is a full `Role`). `saveState` refuses to write a state the loader would reject, and `exwf edit` / `exwf init --roles` validate their files.
- Size: `dist/schema/index.mjs` and `schema` budgeted at measured size; `core+scrum`, `core+kanban`, `core+waterfall` unchanged.

## 0.3.0-stage (2026-10-23)

Pre-release under the `stage` dist-tag.

- Waterfall module (`ex-workflow/waterfall`): ordered phases with deliverables and gates, kickoff / gateReview / changeControlBoard / phaseRetrospective ceremonies, human-approved baselines with versions (`state.baselines`), change-requests with impact analysis that reopen exactly the listed phases (and suspend a later open phase), bidirectional traceability with an engine-generated `traceability-matrix`, seven rules, and phase metrics from events (completion, budget variance, requirement coverage, defects per phase, change-request counts, rework weight).
- Core: `WorkItem.phase` / `impactAnalysis`, `Phase.budget` / `produced`, `WorkflowState.baselines`, planner hook `roleFor`, `Methodology.afterDecide` with `decide(..., methodology?)`, `item.added` payload carries `phase` and `parent`.
- CLI: `exwf init waterfall`; `add` and `edit` run through the methodology rules; `decide` runs the methodology's `afterDecide`; `status` prints the phase report.
- Size: `core+waterfall` measured and budgeted next to `core+scrum` and `core+kanban` (set at measured size; see size-budget.json).

## 0.2.0-stage (2026-10-22)

Pre-release under the `stage` dist-tag.

- Kanban module (`ex-workflow/kanban`): configurable columns with WIP limits and explicit policies, commitment and delivery points, classes of service (expedite with WIP bypass, fixed-date, standard, intangible), six cadences, seven rules, a board view, cadences-due report, and flow metrics from events (lead and cycle time, throughput, WIP, flow efficiency, aging WIP, cumulative flow, SLE compliance, blocker time).
- Core: planner hooks `dispatchStage` (per-item function), `priorityOf`, `tieBreaker`, `wipCounts`, `wipLimitOf`; `Methodology.report`; `canDo` / `requireCap` exported.
- Core: `blocker.raised` / `blocker.cleared` events carry the item transition they made (`transition`, or `null`).
- Core: `plan()` / `next()` report `skipped` (ready cards not pulled, with reason and detail) and the same list is in the `planner.resolved` payload; the CLI `next` output includes it. New plan reason `policy-blocked`.
- Kanban: class-band ordering (question, expedite, fixed-date, standard, intangible) with aging promotion governed by `fairness.maxDeferralRounds` (default 5); the commitment column's policies gate the pull out of it.
- CLI: `exwf init kanban`; `exwf status` prints the methodology report.
- Size: `core+kanban` measured and budgeted next to `core+scrum` (both set at measured size; see size-budget.json).

## 0.1.0-stage (2026-10-19)

Pre-release for integration testing, published under the `stage` dist-tag.

- Core: data-driven methodology engine (state, roles, items, gates, budgets, handoffs, escalation) on top of ex-flow.
- Scrum: sprint planning, daily, review, retro, carryover, DoD and agreements, velocity and cost-per-point metrics.
- Adapters subpath (`ex-workflow/adapters`): file-based state, briefs and handoffs with atomic writes and locking.
- `exwf` CLI (`ex-workflow/cli`): drive a workflow from the shell.
- 112 tests covering core, Scrum, adapters and CLI.
- Known backlog: see the "Known backlog" section of the README.
