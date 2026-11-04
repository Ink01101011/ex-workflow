# Eval-driven workflow improvement — #34

Issue: [#34](https://github.com/Ink01101011/ex-workflow/issues/34), P2 — Strong interest.
Status: investigation complete; proposed pilot, nothing implemented.
Reference: [doi:10.1007/s10462-026-11571-0](https://doi.org/10.1007/s10462-026-11571-0).
See [shared implementation evidence](README.md#shared-implementation-evidence).

## Decision and scope

Recommend **no new methodology**. Treat an evaluation as an Experimentation run
where the candidates are methodology *variants* (config, roles, model tiers,
policies) and the frozen harness is a scenario suite. Add a small, pure
`compareRuns` helper (SDK, not core state) that reduces two or more finished
`WorkflowState`s to the same metric vector.

Why: the problem has the shape Experimentation already ships (frozen baseline
and harness, isolated candidates, independent validation, deterministic
selection, no-winner outcome). What is missing is (a) a scenario-suite artifact
and (b) a quality score; delivery flow metrics alone measure cost, not output
quality. Neither needs a new lifecycle.

## Fit with the current engine (1.1.1, `75e2af5`)

| Need | Already there | Gap |
| --- | --- | --- |
| Cost per run | `state.accounting` lines, per-methodology `metrics()` | none |
| Latency | accounting `durationMs`, Kanban lead/cycle time | none |
| Human interventions | `state.pending` and `gate.*` / `decide` events | a count is not exported as a metric |
| Regressions / task success | none | needs scenario expectations and a scorer |
| Variant isolation and fair comparison | [Experimentation](../../src/experimentation/) freeze → validate → compare | candidate is a code SHA, not a config variant |
| Replay | state is plain JSON; `(state, action) -> state` | host must replay agent outputs, not only engine actions |

## Roles, artifacts, transitions

Roles reuse Experimentation: `coordinator` freezes the suite, `builder` runs one
variant against the whole suite, `validator` (distinct from the builder) scores
the outputs, `integrator` adopts the winning variant into the real config.

| Artifact | Content |
| --- | --- |
| Suite manifest | scenario ids, inputs, expected outcomes or rubric, seeds, suite hash |
| Variant manifest | methodology name, config/roles hash, model per role |
| Run record | final `state.json` per scenario, host logs, usage |
| Score record | per scenario: success, regression flag, tokens, wall time, interventions |
| Comparison | metric vector per variant, ranking, noise tolerance, winner or no-winner |

Transitions are the Experimentation stages unchanged: `candidate → building →
validation → done`, with `harness` = suite hash and the variant manifest hash in
place of the candidate SHA. Stop conditions: suite finished, total budget spent,
or every variant ineligible (any regression on a "must-pass" scenario).

## End-to-end example (illustrative)

1. Freeze suite S (12 Kanban scenarios: 8 bug fixes, 4 refactors, 2 with an
   injected ambiguous spec) and baseline variant V0 (current roles).
2. V1 swaps the `worker` model tier `medium → small`. Each variant runs S in
   its own `.workflow/` per scenario.
3. Validator scores both. Illustrative: V0 11/12 pass, 1.9M tokens; V1 10/12
   pass, 0.9M tokens, one regression on a must-pass scenario.
4. Comparison: V1 is ineligible (must-pass regression); no change adopted. If
   it had kept 11/12 within noise, V1 would win on cost.

## Evaluation criteria for the pilot

| Measure | Acceptance |
| --- | --- |
| Reproducibility | Same variant, same suite, two runs: pass/fail differ on ≤ 1 of 12 scenarios |
| Sensitivity | A deliberately broken variant (e.g. reviewer role removed) is ranked last |
| Coverage | Every score row links suite hash, variant hash and the run's `state.json` |
| Cost of evaluation | Suite run ≤ 3× one normal sprint budget |

## Decision

Composable: Experimentation + a scenario-suite artifact + `compareRuns`. Revisit
only if pilots need a lifecycle Experimentation cannot express, such as
continuous evaluation on every config change.
