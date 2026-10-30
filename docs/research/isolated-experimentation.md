# Isolated multi-agent experimentation — #38

Issue: [#38](https://github.com/Ink01101011/ex-workflow/issues/38), P3 — Exploratory.
Status: investigation complete; proposed pilot, no execution adapter implemented.
See [shared implementation evidence](README.md#shared-implementation-evidence).

## Decision and scope

Recommend a host execution adapter plus composable validation/promotion policy.
Competing solutions are execution topology: they can serve any delivery method
and can implement experiments from [#37](hypothesis-driven-investigation.md).
The engine already dispatches parallel tasks with dependencies and limits. It
does not create worktrees, manage processes, compare results or merge changes.
Those operations belong outside its pure state transitions.

The [Git worktree manual](https://git-scm.com/docs/git-worktree) describes linked
working trees with separate working files and indexes but shared repository data.
Consequently, this proposal treats worktrees as checkout separation. Process,
network, credential and resource isolation require the host's sandbox/container.
Use separate writable caches, build outputs and services per candidate.

A standalone methodology is deferred unless measured pilots require a distinct
portfolio lifecycle that existing task dependencies and host comparison cannot
express. Do not extend public methodology names just to select an executor.

## Roles and artifact contract

| Responsibility | Owner | Artifact |
| --- | --- | --- |
| Freeze objective and comparison rules | Experiment lead | Manifest: base commit, lockfile/toolchain hashes, common tests, seeds, limits, ranking and tie-break |
| Try one approach | Candidate worker per attempt | Patch/commit plus strategy, candidate ID, attempt ID and execution logs |
| Provision and terminate execution | Host runner | Workspace/sandbox identity, command/env manifest, exit code, timeout and usage record |
| Validate candidates independently | Validator distinct from candidate authors | Validation records bound to exact candidate SHA and common test harness hash |
| Select and integrate | Integrator/reviewer | Comparison report, selected SHA or no-winner decision, integration SHA and final validation |

Responsibilities map to registered roles with existing capabilities in a pilot;
they do not add built-in role names. The host binds actors to authenticated runners.
Logs include all failures and discarded attempts. Artifacts are immutable and
include experiment ID, candidate/attempt ID and content hash. Redact secrets at
capture time, without discarding command, environment or failure provenance.

## Proposed transitions

Candidate states below are host artifact states, not new engine statuses.

| From → to | Guard/action | Engine mapping |
| --- | --- | --- |
| Planned → provisioned | Freeze base/harness; create unique checkout and sandbox; record identity | Lead task completes; host provisions before worker execution |
| Provisioned → running | Candidate task dispatched within concurrency/resource limits | `next()` gives brief; host starts runner |
| Running → submitted | Persist patch, logs and accounting at exact candidate SHA | Complete worker task; validator task depends on it |
| Running → failed/timed-out/cancelled | Capture partial logs, terminate process tree and retain attempt record | Host records terminal attempt; report task can finish with failed outcome |
| Submitted → valid/invalid | Validator runs frozen common harness in fresh environment | Complete validation task with explicit outcome artifact |
| All attempts terminal → compared | Every planned candidate has a result or recorded terminal failure | Comparison task depends on all candidate-result tasks |
| Compared → integration-ready/no-winner | Apply eligibility, ranking and tie-break rules fixed before execution | Normal selection task records decision; no code merge by core |
| Integration-ready → integrated | Integrator applies selected patch to current target and reruns required checks | Integration task records new SHA and final validation |
| Terminal → retained/cleaned | Persist artifacts; cleanup only owned, unchanged resources | Host lifecycle action; no workflow-state mutation needed |

An unsuccessful attempt must not leave the comparison permanently waiting on a
blocked dependency. Finish a normal result-report task once the failure is
recorded, marking its artifact `outcome: failed`; `done` means reporting finished,
not candidate eligibility. Block only when human intervention is needed. Never
use a question item as the promotion gate, since questions bypass policies/gates.

If a selected patch conflicts or the target changes, mark the old integration
validation obsolete. Resolve on the integration branch, record the resulting SHA
and rerun checks. Candidate success alone never authorizes promotion of a changed
SHA. Require a reviewer distinct from the candidate author; existing gates can
enforce role-level separation but do not authenticate real-world identities.

## Comparison and stop conditions

Preregister two candidates, a shared base and regression harness, concurrency two,
30 minutes and 40,000 tokens per candidate, and a total 100,000-token/60-minute
experiment limit including validation and integration. These are pilot settings,
not defaults shipped in the package. The host enforces elapsed time, process and
resource limits; engine budget/concurrency checks only govern dispatch.

Eligibility requires all common checks, unchanged protected harness, complete
provenance and no disallowed scope changes. Candidate-authored tests are retained
as supplemental evidence and independently reviewed. Rank eligible candidates by
the preregistered objective (for example, median benchmark latency over five
runs), then smaller changed-line count on an exact tie. Pick no winner if none
qualifies or if the apparent gain is within a preregistered noise tolerance.

Stop after the candidate set finishes or the global limit expires. Cancel timed
out attempts, retain evidence, and report no winner rather than expanding the
search silently. A retry is a new attempt with explicit remaining budget. Cleanup
must not force-remove dirty/unowned worktrees; preserve unexpected edits and report
the cleanup failure. Repeated result delivery should be idempotent by attempt ID.

Evidence-kind/custom policies can require `candidate-result`, `comparison` and
`integration-validation` refs. As implemented, they check presence only. The host
must verify hashes, eligibility and tested-SHA binding before handing off; there
is no current CLI facility to install this adapter or inspect artifact contents.

## End-to-end example (illustrative)

Objective: optimize a hypothetical JSON parser while preserving its public API.
No candidate implementation or benchmark result is claimed by this research.

1. Lead freezes base SHA B, toolchain, common conformance tests and five-run
   benchmark; minimum eligible speedup is 10%, with a 3% noise tolerance.
2. Host creates candidates A (allocation reduction) and C (lookup table) from B
   in separate checkouts and sandboxes. Both receive identical inputs and limits.
   Engine task dependencies make `validate-A` wait for `result-A`, and likewise C.
3. A submits SHA A1. C submits C1. Independent validators run the frozen harness,
   preserving command outputs and usage for both candidates.
4. Illustrative results: A1 passes conformance with 15% lower median latency;
   C1 is 25% faster but fails a Unicode case. C1 is ineligible regardless of speed.
5. Comparison, depending on both validation reports, selects A1 with the failure
   retained in the record. If A1 also failed or missed the threshold, choose no winner.
6. Integrator applies A1 to current target T, producing I1. Fresh conformance,
   benchmark and repository-required checks run on I1. Only reviewed I1 can be
   promoted; a conflict or failed check returns integration for rework.
7. Host archives manifests, patches, raw logs and comparison, then removes owned
   clean candidate resources. Timeouts or a dirty checkout remain explicit outcomes.

## Evaluation before design approval

Pilot ten replayable tasks: known bug fixes, dependency upgrades and refactors,
including injected all-fail, timeout, target-drift and cross-workspace contamination
cases. Compare two-candidate execution with one sequential candidate using the
same total token/time budget, toolchain and validation harness. Counterbalance
task order and have an independent reviewer score outcomes.

| Measure | Proposed pilot acceptance |
| --- | --- |
| Provenance | Every attempt has base/candidate/harness hashes, terminal outcome, logs and usage |
| Isolation | Zero cross-candidate file/output contamination in injected probes |
| Promotion correctness | Zero failed, untested or changed-SHA promotions; all-fail yields no winner |
| Lifecycle | Every timeout terminates its process tree; every owned resource is cleaned or explicitly retained |
| Repeatability | Independent replay reproduces pass/fail for every selected candidate |
| Benefit | At least baseline accepted-task count within equal total budget; report median elapsed time and total tokens |

Record both total work and wall time: parallel execution may shorten latency
while increasing cost. A ten-task pilot screens feasibility; it cannot establish
general performance superiority. Failed isolation, provenance or promotion checks
block implementation approval even if candidate throughput improves.
