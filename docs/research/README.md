# Methodology research

> **Status (2026-10-28): superseded.** These reports recommended composing both protocols on an existing methodology for a pilot. The owner chose standalone methodologies instead, shipped in 1.1.0 as `ex-workflow/investigation` and `ex-workflow/experimentation`; see the [design spec, section 24](../superpowers/specs/2026-10-19-ex-workflow-design.md#24-phase-8-implementation-addenda-110-investigation-37-and-experimentation-38). Kept as the research record; the walkthroughs below describe the proposals, not the shipped API.

Research against local revision `a8bd646` (1.0.1), 2026-10-28. These reports
complete the investigation deliverables, not design approval or runtime implementation.
The examples are proposed walkthroughs; their outcomes are illustrative, not measured results.

| Priority | Issue | Report | Recommendation |
| --- | --- | --- | --- |
| P3 — Exploratory | [#37](https://github.com/Ink01101011/ex-workflow/issues/37) | [Hypothesis-driven investigation](hypothesis-driven-investigation.md) | Composable investigation protocol, validated by the host |
| P3 — Exploratory | [#38](https://github.com/Ink01101011/ex-workflow/issues/38) | [Isolated experimentation](isolated-experimentation.md) | Composable execution adapter and promotion policy |

Both reports cover implementation/test/documentation fit, transitions, roles,
artifacts, stop conditions, an end-to-end example, evaluation criteria and a
standalone-versus-composition decision. No new methodology name, CLI command,
schema field or public export is proposed for the initial pilot.

## Shared implementation evidence

| Existing behavior | Source | Existing validation | Consequence for research |
| --- | --- | --- | --- |
| Dependencies must finish before dispatch; concurrency and budget constrain dispatch | [planner.ts](../../src/planner.ts) | [planner.test.ts](../../src/planner.test.ts): dependency, resource/concurrency caps and remaining-budget tests | Can order experiments and bound engine dispatch; cannot kill a running process |
| Briefs include upstream refs, prior handoffs and agreements | [brief.ts](../../src/brief.ts) | [brief.test.ts](../../src/brief.test.ts): upstream and prior-handoff tests | Can carry experiment instructions and earlier findings |
| Evidence policies match kinds; custom policies match `policy:<id>` | [policies.ts](../../src/policies.ts) | [policies.test.ts](../../src/policies.test.ts): every policy kind and satisfied policies | A matching ref is an assertion, not validation of the referenced contents |
| Completion records evidence/accounting; rework, blockers and escalation have distinct paths | [complete.ts](../../src/complete.ts) | [complete.test.ts](../../src/complete.test.ts): verdicts, follow-ups and escalation | Can record investigation outcomes without adding statuses; question items bypass policies/gates |
| Completion rules inspect the handoff before reduction | [methodology.ts](../../src/methodology.ts), [complete.ts](../../src/complete.ts) | [complete.test.ts](../../src/complete.test.ts): `item.complete` rule rejection (B02) | A future SDK wrapper can add pure validation; rules cannot read external files in core |
| Gates enforce evidence and approver capability; rework invalidates earlier evidence | [gates.ts](../../src/gates.ts), [items.ts](../../src/items.ts) | [gates.test.ts](../../src/gates.test.ts): author conflict, human decision and B10 freshness | Separate approval from authorship; do not reuse evidence from a previous attempt |
| Methodology names and CLI factory selection are fixed | [types.ts](../../src/types.ts), [commands.ts](../../src/cli/commands.ts) | [API freeze](../../test/api-surface.test.ts), [compatibility](../../test/compat.test.ts) | A new built-in methodology entails wider API/schema/CLI work |

The [README](../../README.md) documents the engine/host split, handoff contracts,
custom roles, persistence and known limitations. The [design record](../superpowers/specs/2026-10-19-ex-workflow-design.md)
provides the original architecture. None of the existing tests establishes the
effectiveness of the two proposed protocols; the pilots below must do that.

## Pilot boundary

Use SDK orchestration with an existing methodology for a pilot. A configured
Kanban board can require evidence kinds, but the CLI cannot install arbitrary
rules or execution adapters. The host must validate artifacts and own execution.
Do not treat a `question` item as a guarded deliverable: complete it only for
escalation, and keep the reviewed conclusion/promotion on a normal task item.

Before implementation approval, agree the artifact contracts and pilot thresholds,
then run the pilots and record actual results. GitHub issue status is unchanged
by these local reports.
