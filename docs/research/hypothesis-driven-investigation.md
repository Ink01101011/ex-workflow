# Hypothesis-driven agent investigation — #37

Issue: [#37](https://github.com/Ink01101011/ex-workflow/issues/37), P3 — Exploratory.
Status: investigation complete; proposed pilot, no implementation approval.
See [shared implementation evidence](README.md#shared-implementation-evidence).

## Decision and scope

Recommend a composable investigation protocol over Scrum, Kanban or Waterfall,
with artifact validation in the host. Investigation addresses an unknown cause;
the existing DAG organizes work whose dependencies are already known. A protocol
can generate the next experiment after each observation without replacing the
delivery lifecycle. A standalone methodology would duplicate planning, roles,
accounting and review before there is evidence that a new lifecycle is necessary.

Use it for uncertain incidents and performance investigations. Skip it for a
well-understood mechanical change. Reconsider a standalone methodology only if
pilots show that investigation-specific scheduling and typed belief state cannot
be expressed cleanly through ordinary tasks and host artifacts.

The issue's [scientific-method reference](https://en.wikipedia.org/wiki/Scientific_method)
motivates the proposal. The predictions, records and thresholds below are design
choices for this repository, not claims of scientific proof or calibrated Bayesian inference.

## Roles and artifacts

| Responsibility | Owner | Required artifact |
| --- | --- | --- |
| Bound the symptom and risk | Investigation lead | Case: reproducer, environment, known observations, exclusions and budget |
| Propose alternatives and predictions | Investigator | Hypothesis register with stable IDs, causal claim, disconfirming observation and initial rationale |
| Design a discriminating check | Experiment designer (may be investigator) | Plan: competing predictions, control, command, expected outputs and stop limits |
| Execute and preserve raw observations | Host runner | Result: input/version hashes, command, exit code, raw output refs, timing and deviations |
| Challenge inference and authorize conclusion | Reviewer distinct from investigator | Belief update and conclusion: supported/refuted/unresolved, evidence refs, alternatives and residual uncertainty |

These are responsibility names, not new built-in roles or capabilities. A pilot
can register existing-capability roles and assign tasks explicitly. An automated
runner must never equate a role ID with an independently authenticated person.

The hypothesis register records qualitative belief before and after each test,
why it changed and which result caused the change. No numeric probability is
required. Preserve previous versions; a changed hypothesis gets a new revision.
Artifact refs should identify immutable content and the case/attempt they belong to.

## Proposed transitions

The following states live in a host-owned case artifact, not `ItemStatus`.

| From → to | Preconditions and action | Existing engine mapping |
| --- | --- | --- |
| Intake → hypotheses | Reproducer or bounded observation captured; lead sets limits | Complete intake task; dependent hypothesis task becomes eligible |
| Hypotheses → experiment-ready | At least two plausible explanations, or explicit reason only one is testable; preregister differing predictions | Complete design task with plan ref |
| Experiment-ready → observing | Reviewer accepts discriminating plan and runner checks limits | Host starts experiment after its task is dispatched |
| Observing → updating | Preserve output even on failure; classify invalid run separately | Complete experiment task with result ref and accounting |
| Updating → hypotheses | Evidence inconclusive or alternatives remain; revise register | Lead adds next task chain; do not introduce dependency cycles |
| Updating → conclusion-review | Causal claim has a discriminating result and independent replay | Reviewer receives conclusion task depending on completed experiments |
| Conclusion-review → resolved | Reviewer accepts bounded conclusion and remaining uncertainty | Complete normal conclusion task; create separate remediation backlog item |
| Any active state → inconclusive/stopped | Limit reached, unsafe check, missing access or no discriminating experiment | Host stops execution, records stop reason; block/escalate when intervention is required |

`done` on a conclusion task means the investigation report is complete, including
an inconclusive report. It does not mean the cause is proven or a fix has shipped.
Use an artifact `outcome` to distinguish these cases. Rework requires fresh
evidence under existing engine rules; do not assume an old result ref is valid
for a revised plan. Never allow `question` completion to authorize remediation.

## Enforcement and stop conditions

Evidence policies can require `hypothesis-register`, `experiment-plan`,
`experiment-result` and `conclusion-review` kinds. They cannot ensure an experiment
discriminates, parse a result file or verify its provenance. The host checks
required fields, case/attempt IDs, content hashes and prediction/result linkage
before submitting a handoff. A future pure rule may check an in-memory validated
summary; the current handoff has no typed hypothesis payload.

The pilot lead preregisters a maximum of three experiments, 60 minutes elapsed
and 60,000 total input/output tokens per case, including review and invalid runs.
These are proposed pilot limits. Stop on the first exhausted limit, record all
usage, and produce an inconclusive conclusion if unresolved. The engine's planner
budget checks do not interrupt already-running commands; the host enforces process
timeouts and cancellation. New rounds require a recorded decision and new budget.

Stop early when an independently replayed experiment discriminates among the
registered explanations and the reviewer accepts the scope of the conclusion.
Unsupported access or a potentially disruptive experiment pauses for lead action.

## End-to-end example (illustrative)

Case: a second identical API request remains slow. This is a hypothetical target
application, not a reproduced defect in ex-workflow.

1. `I-intake` captures a fixed dataset, two requests, environment and timings.
2. `I-hypotheses`, depending on intake, records H1: cache key changes per request;
   H2: requests share a key but the entry expires before reuse. Initial belief is
   unresolved for both; no change is prescribed.
3. `I-plan-1` preregisters logging key hashes, write/read times and expiry under a
   fixed clock. H1 predicts differing hashes; H2 predicts equal hashes and an
   expired entry. The reviewer checks that logging itself does not change keys.
4. `I-run-1` produces immutable logs: equal hashes, entry expired immediately.
   The update refutes H1 for this reproducer and supports H2, with a milliseconds
   versus seconds conversion as a narrower candidate explanation.
5. `I-plan-2` specifies boundary checks around the intended TTL. `I-run-2` and
   an independent replay identify the conversion boundary. Failed or contradictory
   checks would return the case to hypothesis revision instead.
6. `I-conclusion`, depending on both runs and replay, records evidence and limits.
   Reviewer accepts the report; the lead creates a separate TTL remediation task
   with regression acceptance. The case stops after two experiments. A fix and
   production effect still need their own validation.

## Evaluation before design approval

Compare the protocol with the existing brief/handoff workflow on ten seeded,
replayable cases covering known causes and inconclusive cases. Counterbalance
case order and use the same models, environment and per-case limits. Have a
reviewer blind to the arm compare conclusions with the hidden seeded cause.

| Measure | Proposed pilot acceptance |
| --- | --- |
| Falsifiability | Every executed valid experiment has predictions recorded before execution |
| Traceability | Every belief change links to a preserved result and prior register revision |
| Correctness | At least 8/10 case outcomes correct; no more wrong causal conclusions than baseline |
| Uncertainty handling | No confident causal conclusion on intentionally inconclusive cases |
| Replay | Every accepted resolved conclusion independently reproduces its discriminating observation |
| Cost and stopping | Zero unrecorded limit overruns; median tokens and elapsed time at most 1.5× baseline |

Report raw per-case outcomes, invalid experiments and total costs, not just the
aggregate. Ten cases are a screening pilot, not statistical validation. If the
protocol fails a threshold, revise or retain it as optional guidance; do not add
a built-in methodology on the strength of these illustrative examples.
