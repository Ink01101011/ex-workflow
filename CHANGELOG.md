# Changelog

## 0.2.0-stage (unreleased)

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
