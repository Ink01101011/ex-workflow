# Engine principles

**Status:** current for ex-workflow 1.2.0 (2026-11-03). Every rule below names the file that enforces it and the test that pins it. A change to one of these files that changes the rule updates this page in the same pull request; a new invariant gets a new number. The decisions behind the rules are in the [design spec](superpowers/specs/2026-10-19-ex-workflow-design.md); the layer and file conventions are in [CONTRIBUTING.md](../CONTRIBUTING.md), section 9.

Paths are relative to the repository root. "Test" names the file and the test title.

## 1. Core is pure

`src/core`, `src/common`, `src/interface` and `src/methodologies` perform no I/O and draw no random numbers. The only clock read is `nowOf` in `src/core/state.ts`, used when the caller passes no `now`; pass `now` for byte-identical output. Files are touched only by `src/adapters` (and the CLI built on it), which the layer rule keeps out of reach of every lower layer.

- Enforced by, for imports: `scripts/check-layers.mjs`, on every `.ts`, `.mts`, `.cts`, `.tsx`, `.js`, `.mjs` and `.cjs` file in those four directories (tests and declaration files excepted): nothing there may import `src/adapters` or `src/cli`, and the only bare specifiers allowed are the runtime dependencies `ex-flow` and `exsorted` and their real subpaths, so no `node:` built-in or other package is reachable (spec 26, "Bare specifiers"). For globals: the `.oxlintrc.json` overrides for the same four directories (tests excepted) fail `pnpm lint` on `Date.now`, `Math.random`, `fetch`, `process`, `crypto`, `performance`, `setTimeout` and `setInterval`. The clock: `src/core/state.ts` (`nowOf`, the one `new Date()` without an argument). Not checked mechanically: a zero-argument `new Date()` elsewhere and a global reached through `globalThis` or an alias; review catches those.
- Test: `test/check-layers.test.ts` "the repository itself passes", "inner layers may import only relative paths, ex-flow and exsorted" and "every source extension under src is checked: .mts, .cts, .tsx, .js, .mjs, .cjs (U11 N2)"; `test/purity-lint.test.ts` "inner layers may not read the clock, draw random numbers or reach I/O globals"; `src/core/state.test.ts` "nowOf returns the given time or a valid ISO string".

## 2. State is plain JSON; every operation is `(state, action) -> state`

A `WorkflowState` holds only JSON values. Engine functions take a state and return a new one; they never mutate their input, and a refused operation throws without touching the caller's state. The file adapter validates a state against the schema before it writes it and after it reads it.

- Enforced by: `src/core/state.ts` (`appendEvent` copies), `src/core/methodology.ts` (`applyAction` validates, then reduces to a new state), `src/interface/ext.ts` (`writeExt` returns a new state), `src/adapters/file.ts` (`saveState`, `loadState`).
- Test: `src/core/state.test.ts` "appendEvent is immutable and increments seq"; `src/core/complete.test.ts` "gate-unmet throws and leaves the caller's state untouched"; `src/methodologies/experimentation/index.test.ts` "E8 malformed extra payloads cannot make successful state non-JSON or mutate input"; `src/adapters/file.test.ts` "saveState refuses a state that fails the schema and writes nothing".

## 3. Every error names the rule, the item and a fix

Every failure is a `WorkflowError` with a `code`, a `message` and a non-empty `fix`; it carries `rule` and `items` whenever a rule or an item is involved. A rule violation is reported with the id of the first failing rule, the items named by every failing rule and every rule's fix.

- Enforced by: `src/core/errors.ts` (`WorkflowError` refuses an empty fix), `src/core/methodology.ts` (`applyAction` folds violations into `rule-violation`).
- Test: `src/core/errors.test.ts` "WorkflowError requires a non-empty fix" and "fail throws a WorkflowError carrying code, fix and items"; `src/core/policies.test.ts` "every policy kind reports when unmet, with a fix"; `src/core/accounting.test.ts` "every correctAccounting refusal carries a fix".

## 4. Rules see every action before it applies

`applyAction` runs the core rules and the methodology's rules on the action first; an `error` violation aborts the action, `warning` violations are returned with the new state. `complete()` passes through the rules as action type `item.complete`. `addItem` and `editItem` called directly are primitives and do not run the rules; `applyAction` and the CLI do.

- Enforced by: `src/core/methodology.ts` (`validateAction`, `applyAction`), `src/core/rules.ts` (`coreRulesFor`), `src/core/complete.ts`.
- Test: `src/core/methodology.test.ts` "applyAction aborts on error rules and surfaces warnings"; `src/core/complete.test.ts` "complete runs methodology rules for action type item.complete without appending an action event (B02)".

## 5. Evidence before transition; freshness after rework

An item leaves a stage only when the stage's exit policies hold, and passes a gate only with the evidence kinds the gate names. Only evidence recorded after the item's last `item.rework` event counts (event order, not timestamps); older evidence stays stored but no longer satisfies a policy or a gate. A context snapshot (evidence `context-snapshot`, `ex-workflow/policies`) also goes stale when a later `repo.changed` event lists a path it cites, again by event order.

- Enforced by: `src/core/policies.ts` (`evaluatePolicies`, `assertPolicies`), `src/core/gates.ts` (`checkGate`), `src/core/items/evidence.ts` (`freshEvidence`), `src/core/complete.ts` (exit policies on `done` and `needs-review`), `src/common/context/snapshot.ts` (`contextOf`).
- Test: `src/core/complete.test.ts` "complete done fails when exit policy is unmet"; `src/core/policies.test.ts` "B10: freshness follows event order, not timestamps: evidence before the rework event is stale even at the same instant, evidence after it counts"; `src/core/gates.test.ts` "B10: gate evidence recorded before the last rework no longer counts; fresh evidence does; second rework resets"; `src/common/context/snapshot.test.ts` "property: staleness follows event order and is deterministic (300 seeded runs)".

## 6. The author does not approve its own work

A capability gate refuses an approval by the role that did the work (`conflict-of-interest`); the author is the role of the last dispatch from a stage before the gated one, so a reviewer dispatched into the gated stage is not the author. The planner gives a review to a reviewer other than the author when one exists.

- Enforced by: `src/core/gates.ts` (`checkGate` refuses with `conflict-of-interest`, judging the author with `authorOf`), which `complete()` runs on every gated completion; `src/core/planner.ts` (`assignRole`). The `conflict-of-interest` entry in `src/core/rules.ts` matches action type `complete`, which the engine never dispatches (completions reach the rules as `item.complete`), so it applies only to an action of type `complete` passed to `validateAction` directly.
- Test: `src/core/gates.test.ts` "checkGate reports conflict of interest when author approves own work" and "a reviewer dispatched into the gated stage is not the author; the earlier-stage worker is"; `src/core/planner.test.ts` "assignRole prefers the item's role, else deliver/review by status, never the author for review".

## 7. Roles are data; capabilities decide

A role is a manifest of capabilities and `canApprove` gates, not a name the engine knows. A ceremony or decision checks the caller's capability; `human` may do anything; an unknown role id may do nothing. `init` refuses a methodology whose required capabilities no role holds, or whose exclusive capability more than one role holds, and warns when one role holds every required capability (`separation-lost`).

- Enforced by: `src/core/roles/guards.ts` (`requireCap`, `canDo`, `requireCapabilities`, `separationLost`), `src/core/roles/lookup.ts` (`approverIds`), `src/core/rules.ts` (`separation-lost`).
- Test: `src/core/roles/guards.test.ts` "canDo and requireCap: human may do anything, roles need one of the capabilities"; `src/core/methodology.test.ts` "init validates config, builds defaults and checks capabilities" and "init warns on separation-lost".

## 8. Verification is independent of the work

A verifying role must not be one that did the work, judged by recorded role id. Investigation: a replay is executed by a role that ran no attempt of the original (`independent-replay` rule and the planner's `roleFor`), and the conclusion reviewer contributed no run. Experimentation: the validator is not the candidate's author, and the integration validator is neither the author nor the integrator. Every one of these checks goes through one function.

- Enforced by: `src/common/independence.ts` (`independenceConflicts`), called from `src/methodologies/investigation/rules.ts`, `src/methodologies/investigation/index.ts`, `src/methodologies/investigation/ceremonies.ts` and `src/methodologies/experimentation/ceremonies.ts`.
- Test: `src/common/independence.test.ts`; `src/methodologies/investigation/index.test.ts` "replay execution uses an actor independent from the original execution" and "review independence includes real execution actors despite spoofed accounting"; `src/methodologies/experimentation/index.test.ts` "independent authorization follows capabilities and an author with verify still cannot validate".

## 9. Frozen inputs stay frozen

What was frozen or preregistered is compared by identity against every later input that claims it: Experimentation's base SHA, harness, workspace and submitted SHA; Investigation's hypothesis definitions, a replay's procedure and predictions. A Waterfall baseline (an approved gate) changes only through an approved change-request.

- Enforced by: `src/common/frozen.ts` (`frozenChanges`), called from `src/methodologies/experimentation/ceremonies.ts` and `src/methodologies/investigation/ceremonies.ts`; `src/methodologies/waterfall/rules.ts` (`baseline-immutable`).
- Test: `src/common/frozen.test.ts`; `src/methodologies/experimentation/index.test.ts` "requires host provenance matching the frozen workspace and harness"; `src/methodologies/investigation/index.test.ts` "a replay cannot change the preregistered procedure or predictions"; `src/methodologies/waterfall/rules.test.ts` "baseline-immutable refuses edits to and adds into a baselined phase".

## 10. Budget bounds dispatch

The planner dispatches only within the open iteration's remaining budget, on every dimension set (tokens, turns, wall-clock), counting work in flight; a spent dimension answers `budget-exhausted` and reports each skipped item with reason `budget`. Investigation refuses a new round once the round limit or the budget is spent; Experimentation stops admitting candidates at its concurrency cap and budgets. A completion with zero tokens is refused unless it is a declared estimate, so the budget is not undercounted.

- Enforced by: `src/core/planner.ts` (`plan`), `src/core/budget.ts` (`remaining`, `isExhausted`), `src/core/complete.ts` (zero-token check), `src/methodologies/investigation/ceremonies.ts` (`preregister`), `src/methodologies/experimentation/ceremonies.ts`.
- Test: `src/core/planner.test.ts` "plan stops at the open iteration's remaining budget" and "a turns budget gates dispatch: remaining turns minus in-flight, then budget-exhausted"; `src/core/complete.test.ts` "a completion with 0 tokens is refused unless it is a declared estimate"; `src/methodologies/investigation/index.test.ts` "R6 preregister refuses when the budget is spent instead of closing silently"; `src/methodologies/experimentation/index.test.ts` "concurrency limit and budget exhaustion stop new candidates".

## 11. A human owns blockers and human gates

The engine raises blockers (a `blocked` verdict, a rejected human gate) but never clears one: no completion, follow-up or ceremony does; only an explicit `clearBlocker` (`exwf unblock`) does. A gate that requires `human` goes to `pending`, and only `human` can decide it.

- Enforced by: `src/core/items/blockers.ts` (`raiseBlocker`, `clearBlocker`; the engine calls `clearBlocker` nowhere), `src/core/gates.ts` (`checkGate`, `raisePending`, `decide`).
- Test: `src/core/items/blockers.test.ts` "blockers"; `src/core/complete.test.ts` "a rejected human gate (onFail block) can be cleared and the item is dispatched again" and "decide return-to clears the role; only human or a qualifying role may decide"; `src/core/gates.test.ts` "human gates go to pending and decide resolves them".

## 12. One `.workflow` per run

A state belongs to one methodology. Investigation and Experimentation refuse to start on a workflow of another methodology, so neither nests inside, migrates into or coordinates another run. The file adapter keeps one `state.json` under each `.workflow/` directory.

- Enforced by: `src/methodologies/investigation/ceremonies.ts` (`intake`), `src/methodologies/experimentation/ceremonies.ts` (`experimentOf`, `freeze`), `src/adapters/file.ts`.
- Test: `src/methodologies/investigation/index.test.ts` "R7 intake refuses a workflow of another methodology". No test calls an Experimentation ceremony on a foreign workflow.

## 13. The host executes; the engine records

The engine never calls an LLM, runs a procedure, benchmark or Git command, or creates a workspace. It hands out briefs and records what the host reports (handoffs, accounting, workspaces, SHAs, logs), checking shape and linkage, not the contents behind a reference.

- Enforced by: rule 1 (no I/O below the outer layer); `src/core/brief.ts` (`next` returns briefs), `src/core/complete.ts` (records handoff and accounting), `src/methodologies/experimentation/ceremonies.ts` (`provision`, `submit`, `integrate`, `cleanup` record host results).
- Test: `src/core/brief.test.ts` "next plans and returns one brief per dispatched item"; `src/core/complete.test.ts` "complete done: records accounting, evidence, spent, advances to review"; `src/methodologies/experimentation/index.test.ts` "requires host provenance matching the frozen workspace and harness".

## 14. Extension state goes through the accessors

A methodology's own record lives in `state.ext`, keyed by its name, and is read and written only through `readExt` / `writeExt`. For Investigation and Experimentation the accessor mirrors the record to the deprecated top-level field in memory and reads that field on a state that has no `ext`; the file adapter stores only `ext` and restores the mirror on load (`ext` wins when a file carries both).

- Enforced by: `src/interface/ext.ts` (`withoutLegacyMirrors`, `withLegacyMirrors`, used by `src/adapters/file.ts`); `src/methodologies/investigation/record.ts` and `src/methodologies/experimentation/record.ts` (thin wrappers).
- Test: `src/interface/ext.test.ts` "no source outside src/interface/ext.ts touches ext or the legacy fields directly" and "readExt reads ext first and falls back to the legacy field of a 1.1 state"; `test/compat.test.ts` "1.1.1/<name>: a ceremony after load writes ext.<name> and the equal legacy mirror" (also: no top-level legacy key on disk, and `ext` wins over a hand-edited one).

## 15. Earlier states load unchanged

A `.workflow/state.json` written by any earlier release loads unchanged; every state field added since is optional. A state with another schema `version` is refused `state-version`.

- Enforced by: `src/core/types.ts` (optional fields), `src/adapters/file.ts` (`loadState` version check and schema validation).
- Test: `test/compat.test.ts` (fixtures from every published release in `test/fixtures/compat`); `src/adapters/file.test.ts` "loadState merges role manifests and reports missing or wrong-version files".

## 16. Imports go down the layers

`core` → `common` → `interface` → `methodologies`, lowest first; an import, runtime or `import type`, goes only to the same or a lower layer. `src/adapters`, `src/cli`, `src/schema` and the root files are outer.

- Enforced by: `scripts/check-layers.mjs` (in `pnpm run ci` and the pre-commit hook).
- Test: `test/check-layers.test.ts` "a runtime import to a higher layer fails and names both layers" and "a type-only import to a higher layer also fails".

## 17. Gate escalation only tightens

A methodology's `escalateGate` hook (for example the risk-adaptive gate of `ex-workflow/policies`) can add requirements and evidence kinds to a static gate, never remove or replace one. `complete()` records the gate it checked as `gate.resolved`, and `decide()` judges the pending against that recorded gate, so an escalation to a human cannot be approved by a role.

- Enforced by: `src/core/gate-escalation.ts` (`widenGate` appends only, skipping malformed entries; `resolvedGate` reads the last `gate.resolved`), `src/core/complete.ts`, `src/core/gates.ts` (`decide`).
- Test: `src/core/gate-escalation.test.ts` "property: a widened gate never answers pass where the static gate does not (500 seeded cases)"; `src/common/risk/escalation.test.ts` (the resolved level is monotone in the evidence); `src/core/gates.test.ts` "decide judges an escalated pending against the recorded gate.resolved (spec 27, #35)".
