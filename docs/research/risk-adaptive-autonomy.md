# Risk-adaptive agent autonomy — #35

Issue: [#35](https://github.com/Ink01101011/ex-workflow/issues/35), P2 — Strong interest.
Status: adopted in 1.3.0 (spec section 27) for the `risk-assessment` evidence, the escalation-only gate resolver (opt-in per gate, via `withRiskGate`) and the `gate.resolved` event; not adopted: a second human for `critical`, a dedicated `risk-assessor` capability (a role with `verify` assesses), the pilot measurements. File links below predate 1.2; the code is under `src/core/`.
Reference: [PMLR v306, pan26a](https://proceedings.mlr.press/v306/pan26a.html).
See [shared implementation evidence](README.md#shared-implementation-evidence).

## Decision and scope

Recommend a **composable gate policy**, usable by every methodology. Today
`Gate.requires` is a fixed list (`"human"` or `{ capability }`) checked by
`checkGate` in [gates.ts](../../src/gates.ts). The proposal makes the human
requirement a *function of recorded risk and evidence*, resolved at gate time
by a pure function: same state, same decision.

Not a standalone methodology: risk does not change the delivery flow (sprint,
board, phases), only who must approve a transition.

## Fit with the current engine (1.1.1, `75e2af5`)

| Need | Already there | Gap |
| --- | --- | --- |
| Approval routing | `Gate.requires`, `approverIds`, `pending` + `decide` | requirement is static per gate |
| Evidence before approval | gate `evidence` kinds, `freshEvidence` (rework invalidates) | no confidence value, presence only |
| Item risk signal | `tags`, `classOfService`, `affects` | no risk field or scoring rule |
| Separation of duties | `authorOf` excludes the author | none |
| Audit | events log every gate outcome | the reason a gate auto-passed is not recorded |

## Proposed design

- **Risk assessment artifact** (evidence kind `risk-assessment`): `level:
  low | medium | high | critical`, factors (touches CI/CD, prod infra, secrets,
  blast radius, reversibility), assessor role, item SHA/ref.
- **Policy** `riskGate`: a table from level to requirement, for example
  `low → { capability: "review" }`, `medium → review + test evidence`,
  `high → human`, `critical → human + second human`.
- **Escalation-only rule**: the resolved requirement may only be *stricter*
  than the static gate. Missing or stale assessment resolves to the strictest
  level. An agent can never lower its own risk; the assessor must not be the
  item's author.
- **Event**: `gate.resolved { level, requirement, assessment }` so every
  autonomous pass is explainable later.

Transitions are unchanged (`review → done`, or `return-to`). Roles: one new
capability-holder `risk-assessor` (may be a role with `verify`); a human stays
the final approver for `high` and `critical`.

## Stop conditions

Rework invalidates the assessment (existing freshness rule). A `critical` item
rejected twice blocks with a human-owned blocker. Budget exhaustion keeps the
existing behaviour.

## End-to-end example (illustrative)

1. Kanban board with gate `release` (static: `review`).
2. Item A "fix README typo": assessor records `low`; reviewer approves; done,
   no human. Event shows `level: low`.
3. Item B "change deploy workflow": factors `ci-cd, prod`; level `high`;
   gate raises a `pending` human decision even though the static gate did not.
4. Worker reworks B: assessment is stale; the gate resolves to `critical`
   until a fresh assessment is attached.

## Evaluation criteria for the pilot

| Measure | Acceptance |
| --- | --- |
| Safety | Zero `high`/`critical` items closed without a human decision (seeded set of 20 risky items) |
| Autonomy gain | ≥ 40% fewer human decisions than "human on every gate" on the same 50 items |
| Monotonicity | Property test: resolved requirement ⊇ static requirement for every state |
| Explainability | Every gate pass has a `gate.resolved` event naming level and assessment |

## Decision

Composable policy (gate requirement resolver + `risk-assessment` evidence),
opt-in per gate. It touches the shared `Gate` type, so it is a minor-version
addition with an API-surface and schema update.
