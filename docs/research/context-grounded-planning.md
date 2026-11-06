# Context-grounded planning — #36

Issue: [#36](https://github.com/Ink01101011/ex-workflow/issues/36), P2 — Strong interest.
Status: adopted in 1.3.0 (spec section 27) for the `context-snapshot` evidence, the `context-grounded` entry policy, the `repo.changed` stale rule and the brief `context` field; not adopted: blocking after three snapshots cite a missing source, the pilot measurements. File links below predate 1.2; the code is under `src/core/`.
Reference: [arXiv:2604.05278](https://arxiv.org/abs/2604.05278).
See [shared implementation evidence](README.md#shared-implementation-evidence).

## Decision and scope

Recommend a **composable entry policy plus a stale-context rule**. Planning or
implementation may start only when the item has a fresh, source-backed context
snapshot; the snapshot goes stale when the code it cites changes.

Not a standalone methodology: reconnaissance is a precondition of work in any
flow (a Scrum story, a Kanban card, a Waterfall design item), not a lifecycle
of its own.

## Fit with the current engine (1.1.1, `75e2af5`)

| Need | Already there | Gap |
| --- | --- | --- |
| Precondition before a stage | `Stage.entryPolicy`, custom policy `policy:<id>` evidence | presence only; no content check |
| Context in the brief | `synthesizeBrief`: upstream handoffs, prior handoffs, agreements, related bugs ([brief.ts](../../src/brief.ts)) | no list of verified assumptions or their sources |
| Invalidation | rework invalidates earlier evidence (`freshEvidence`) | nothing invalidates on repository change |
| Pure core | no I/O; host owns Git | the host must compute hashes; core can only compare them |

## Proposed design

- **Context snapshot artifact** (evidence kind `context-snapshot`): repo
  revision, and a list of assumptions, each `{ claim, source: { path, lines?,
  hash } }`. Unsourced claims are marked `unverified`.
- **Entry policy** `context-grounded` on the planning or work stage: needs a
  fresh `context-snapshot` with zero `unverified` assumptions marked
  `required`.
- **Stale rule**: the host reports changed files (`repo.changed { revision,
  paths }` action). A pure rule marks every snapshot citing a changed path as
  stale; an in-progress item whose snapshot went stale gets a warning, a `todo`
  item cannot be dispatched.
- **Brief**: `synthesizeBrief` adds the snapshot's assumptions as `context`
  so the worker sees what was verified and where.

Roles: a `scout` (deliver + verify, read-only intent in `do_not`) writes the
snapshot; the worker may not write its own snapshot for `required` claims.

## Transitions and stop conditions

`todo → (scout writes snapshot) → todo [grounded] → in_progress`. Stale → back
to needing a snapshot, no status change, only the policy fails again. Stop if
three consecutive snapshots cite a missing source: block with a human-owned
blocker ("repository does not match spec").

## End-to-end example (illustrative)

1. Story S "add retry to `fetchUser`" in a monorepo.
2. Scout records: `fetchUser` is in `pkg/api/user.ts:40-72` (hash h1); callers
   in 3 packages; no retry helper exists (`unverified` → searched, none found,
   now sourced by the grep record).
3. Policy passes; developer gets a brief with these assumptions.
4. Before S finishes, another item edits `pkg/api/user.ts`. Host sends
   `repo.changed`; S's snapshot is stale; a warning reaches the host; review
   requires a refreshed snapshot.

## Evaluation criteria for the pilot

| Measure | Acceptance |
| --- | --- |
| Grounding | ≥ 95% of plan assumptions cite a source that resolves at the snapshot revision |
| Staleness | 100% of injected conflicting edits mark the dependent snapshot stale |
| Outcome | Fewer rework verdicts caused by wrong assumptions than the same 20 tasks without the policy |
| Cost | Scout tokens ≤ 20% of the item's total tokens |

## Decision

Composable policy (`context-snapshot` evidence, entry policy, `repo.changed`
stale rule, brief field). The brief field and new action are a minor-version
addition with an API-surface and schema update.
