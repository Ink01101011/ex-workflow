import { executionActors, freshOutputRefs } from "./execution.ts";
import { fail } from "../errors.ts";
import { roleOf } from "../roles.ts";
import { addItem, moveItem } from "../items.ts";
import { applyAction } from "../methodology.ts";
import { appendEvent, nowOf } from "../state.ts";
import { isExhausted } from "../budget.ts";
import type { Capability, Ceremony, CeremonyInput, Methodology, WorkflowState } from "../types.ts";
import { validateInvestigationConfig, type InvestigationConfig } from "./config.ts";
import type {
  BeliefUpdate,
  Experiment,
  Hypothesis,
  InvestigationConclusion,
  InvestigationState,
  Observation,
} from "./state.ts";
function reject(s: WorkflowState, name: string, message: string, fix: string): never {
  const x = s.investigation;
  return fail("invalid-input", `${name} (phase ${x?.phase ?? "intake"}): ${message}`, fix, {
    items: x ? [x.item, ...(x.rounds.at(-1) ? [x.rounds.at(-1)!.item] : [])] : [],
  });
}
const sameHypothesis = (a: Hypothesis | undefined, b: Hypothesis | undefined) =>
  !!a && !!b && a.id === b.id && a.claim === b.claim && a.falsifiedBy === b.falsifiedBy;
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const refs = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every(text) && new Set(v).size === v.length;
function authorize(s: WorkflowState, by: string, cap: Capability) {
  if (!roleOf(s, by)?.capabilities.includes(cap))
    fail(
      "missing-capability",
      `${by} needs ${cap}`,
      "use a registered role with the required capability",
    );
}
function save(s: WorkflowState, x: InvestigationState, i: CeremonyInput, name: string) {
  return appendEvent(
    { ...s, investigation: x },
    `investigation.${name}`,
    i.by,
    { ...x },
    nowOf(i.now),
  );
}
export function closeInvestigation(
  s: WorkflowState,
  x: InvestigationState,
  i: CeremonyInput,
  outcome: "stopped" | "resolved" | "inconclusive",
  reason?: string,
) {
  const at = nowOf(i.now);
  let n = save(
    s,
    { ...x, phase: "closed", outcome, ...(reason ? { stopReason: reason } : {}) },
    i,
    outcome,
  );
  n = {
    ...n,
    iterations: n.iterations.map((it) =>
      it.id === "investigation"
        ? { ...it, endedAt: at, outcome: outcome === "stopped" ? "cancelled" : "completed" }
        : it,
    ),
  };
  for (const item of Object.values(n.items).filter(
    (candidate) => candidate.id === x.item || x.rounds.some((r) => r.item === candidate.id),
  ))
    if (item.status !== "done" && item.status !== "dropped")
      n = moveItem(
        n,
        item.id,
        { status: outcome === "resolved" && item.id === x.item ? "done" : "dropped" },
        i.by,
        at,
      );
  return n;
}
export function investigationCeremonies(
  factory: () => Methodology<InvestigationConfig>,
): Record<string, Ceremony> {
  const make =
    (
      name: string,
      cap: Capability,
      phase: string | undefined,
      fn: (
        s: WorkflowState,
        x: InvestigationState,
        i: CeremonyInput,
        bad: (message: string, fix: string) => never,
      ) => WorkflowState,
    ): Ceremony =>
    (s, i) => {
      authorize(s, i.by, cap);
      const x = s.investigation;
      if (!x || x.phase === "closed")
        reject(s, name, "no active investigation", "start a new investigation with intake {item}");
      if (phase && x.phase !== phase && !(name === "hypotheses" && x.phase === "preregister"))
        reject(
          s,
          name,
          `expected ${phase}, got ${x.phase}`,
          `finish phase ${x.phase} before calling ${name}; ${name} requires phase ${phase}`,
        );
      return applyAction(s, factory(), { type: `ceremony.${name}`, by: i.by, payload: i }, () =>
        fn(s, x, i, (message, fix) => reject(s, name, message, fix)),
      );
    };
  return {
    intake(s, i) {
      authorize(s, i.by, "facilitate");
      const bad = (message: string, fix: string) => reject(s, "intake", message, fix);
      if (s.investigation)
        bad(
          "investigation already started",
          "use the existing investigation or initialize a new workflow",
        );
      if (!text(i.item))
        bad("item is required", "set intake.item to a unique investigation item ID");
      const c = validateInvestigationConfig(s.config);
      let n = addItem(
        s,
        {
          id: i.item as string,
          title: c.question,
          acceptance: ["Independent evidence-based conclusion"],
          stage: "intake",
        },
        i.by,
        i.now,
      );
      n = {
        ...n,
        iterations: [
          ...n.iterations,
          {
            id: "investigation",
            goal: c.question,
            budget: { ...c.budget },
            spent: { tokens: 0, turns: 0, wallclockMs: 0 },
            startedAt: nowOf(i.now),
            committed: [],
            carryover: [],
          },
        ],
      };
      return {
        state: save(
          n,
          {
            item: i.item as string,
            phase: "hypotheses",
            hypotheses: [],
            rounds: [],
            contributors: [i.by],
          },
          i,
          "intake",
        ),
        warnings: [],
      };
    },
    hypotheses: make("hypotheses", "define-acceptance", "hypotheses", (s, x, i, bad) => {
      const h = i.hypotheses as Hypothesis[];
      if (
        !Array.isArray(h) ||
        !h.length ||
        h.some((v) => !v || !text(v.id) || !text(v.claim) || !text(v.falsifiedBy)) ||
        new Set(h.map((v) => v.id)).size !== h.length ||
        (h.length < 2 && !text(i.singleHypothesisRationale))
      )
        bad(
          "provide competing falsifiable hypotheses or single-testable rationale",
          "set hypotheses to unique {id, claim, falsifiedBy} entries; supply singleHypothesisRationale when there is only one",
        );
      return save(
        s,
        {
          ...x,
          hypotheses: structuredClone(h),
          ...(text(i.singleHypothesisRationale)
            ? { singleHypothesisRationale: i.singleHypothesisRationale }
            : {}),
          contributors: [...new Set([...x.contributors, i.by])],
          phase: "preregister",
        },
        i,
        "hypotheses",
      );
    }),
    preregister: make("preregister", "define-acceptance", "preregister", (s, x, i, bad) => {
      const c = validateInvestigationConfig(s.config),
        it = s.iterations.find((v) => v.id === "investigation");
      if (x.rounds.length >= c.maxRounds || !it || isExhausted(c.budget, it.spent))
        return closeInvestigation(s, x, i, "stopped", "budget or round limit exhausted");
      const e = i.experiment as Experiment;
      if (
        !e ||
        !text(e.id) ||
        !text(e.procedureRef) ||
        x.rounds.some((r) => r.experiment.id === e.id) ||
        !Array.isArray(e.predictions) ||
        e.predictions.length !== x.hypotheses.length ||
        x.hypotheses.some(
          (h) =>
            e.predictions.filter((p) => p?.hypothesis === h.id && text(p.prediction)).length !== 1,
        ) ||
        new Set(e.predictions.map((p) => p.prediction)).size !== e.predictions.length
      )
        bad(
          "preregister unique experiment with differing predictions for every hypothesis",
          "set experiment.id to a new ID, experiment.procedureRef, and one distinct experiment.predictions entry per hypothesis",
        );
      if (e.replayOf) {
        const prior = x.rounds.find((r) => r.experiment.id === e.replayOf && r.result?.valid);
        if (
          !prior ||
          prior.experiment.procedureRef !== e.procedureRef ||
          prior.hypotheses.length !== x.hypotheses.length ||
          x.hypotheses.some(
            (h) =>
              !sameHypothesis(
                h,
                prior.hypotheses.find((p) => p.id === h.id),
              ),
          ) ||
          e.predictions.some(
            (p) =>
              !prior.experiment.predictions.some(
                (q) => q.hypothesis === p.hypothesis && q.prediction === p.prediction,
              ),
          )
        )
          bad(
            "replay must repeat the procedure, predictions and hypotheses of a prior valid experiment",
            "set experiment.replayOf to a valid prior experiment with identical procedureRef, predictions and hypothesis definitions",
          );
      }
      const id = `${x.item}-run-${x.rounds.length + 1}`;
      let n = addItem(
        s,
        {
          id,
          title: `Experiment ${e.id}`,
          stage: "execute",
          acceptance: [e.procedureRef],
          iteration: "investigation",
        },
        i.by,
        i.now,
      );
      n = {
        ...n,
        iterations: n.iterations.map((iteration) =>
          iteration.id === "investigation"
            ? { ...iteration, committed: [...iteration.committed, id] }
            : iteration,
        ),
      };
      return save(
        n,
        {
          ...x,
          phase: "observe",
          rounds: [
            ...x.rounds,
            {
              experiment: structuredClone(e),
              hypotheses: structuredClone(x.hypotheses),
              item: id,
              by: i.by,
            },
          ],
          contributors: [...new Set([...x.contributors, i.by])],
        },
        i,
        "preregister",
      );
    }),
    observe: make("observe", "verify", "observe", (s, x, i, bad) => {
      const r = x.rounds.at(-1)!,
        o = i.result as Observation;
      if (
        i.experiment !== r.experiment.id ||
        !o ||
        !text(o.id) ||
        typeof o.valid !== "boolean" ||
        !text(o.summary) ||
        !refs(o.provenanceRefs) ||
        x.rounds.some((prior) => prior.result?.id === o.id)
      )
        bad(
          "observation needs current experiment, unique result and provenance",
          "set experiment to the active experiment ID and result to {id, valid, summary, provenanceRefs} with a new result.id",
        );
      if (s.items[r.item]?.status !== "done")
        bad(
          "complete experiment execution before recording observations",
          "dispatch and complete the active experiment item before calling observe",
        );
      if (!freshOutputRefs(s, r.item).some((ref) => o.provenanceRefs.includes(ref)))
        bad(
          "observation must link fresh experiment-output evidence from the latest completion",
          `include an experiment-output ref produced by the latest successful completion of item "${r.item}" in result.provenanceRefs`,
        );
      return save(
        s,
        {
          ...x,
          phase: "update-belief",
          rounds: x.rounds.map((v) => (v === r ? { ...v, result: structuredClone(o) } : v)),
          contributors: [...new Set([...x.contributors, i.by, ...executionActors(s, r.item)])],
        },
        i,
        "observe",
      );
    }),
    "update-belief": make("update-belief", "define-acceptance", "update-belief", (s, x, i, bad) => {
      const r = x.rounds.at(-1)!,
        a = i.assessments as BeliefUpdate["assessments"];
      if (
        i.result !== r.result?.id ||
        !Array.isArray(a) ||
        a.length !== x.hypotheses.length ||
        x.hypotheses.some(
          (h) =>
            a.filter(
              (v) =>
                v?.hypothesis === h.id &&
                ["supported", "refuted", "uncertain"].includes(v.assessment) &&
                text(v.reason),
            ).length !== 1,
        ) ||
        !["round", "conclusion"].includes(i.next as string)
      )
        bad(
          "belief update must assess every hypothesis against current result",
          "set result to the latest result ID, assessments to one {hypothesis, assessment, reason} per hypothesis, and next to round or conclusion",
        );
      if (!r.result!.valid && a.some((v) => v.assessment !== "uncertain"))
        bad(
          "invalid experiments cannot support beliefs",
          "set every assessment to uncertain for an invalid experiment result",
        );
      let n = save(
        s,
        {
          ...x,
          phase: i.next === "round" ? "preregister" : "conclusion",
          rounds: x.rounds.map((v) =>
            v === r
              ? { ...v, update: { result: i.result as string, assessments: structuredClone(a) } }
              : v,
          ),
          contributors: [...new Set([...x.contributors, i.by])],
        },
        i,
        "belief-updated",
      );
      const it = n.iterations.find((v) => v.id === "investigation")!;
      if (
        i.next === "round" &&
        (x.rounds.length >= validateInvestigationConfig(s.config).maxRounds ||
          isExhausted(it.budget, it.spent))
      )
        n = closeInvestigation(
          n,
          n.investigation!,
          i,
          "stopped",
          "budget or round limit exhausted",
        );
      return n;
    }),
    conclude: make("conclude", "define-acceptance", "conclusion", (s, x, i, bad) => {
      const c = i as unknown as InvestigationConclusion;
      if (
        !["resolved", "inconclusive"].includes(c.outcome) ||
        !text(c.summary) ||
        !refs(c.evidenceRefs) ||
        c.evidenceRefs.some((ref) => !x.rounds.some((r) => r.result?.provenanceRefs.includes(ref)))
      )
        bad(
          "conclusion needs observed evidence references",
          "set outcome, summary and evidenceRefs to references preserved in recorded observations",
        );
      if (
        c.outcome === "resolved" &&
        (!text(c.supportedHypothesis) ||
          !x.rounds
            .slice(-1)
            .some(
              (r) =>
                r.result?.valid &&
                r.update?.assessments.some(
                  (a) => a.hypothesis === c.supportedHypothesis && a.assessment === "supported",
                ),
            ))
      )
        bad(
          "resolved conclusion needs a supported hypothesis",
          "set supportedHypothesis to a hypothesis supported by the latest valid round, or choose outcome inconclusive",
        );
      return save(
        s,
        {
          ...x,
          phase: "review",
          conclusion: {
            outcome: c.outcome,
            summary: c.summary,
            evidenceRefs: [...c.evidenceRefs],
            ...(c.supportedHypothesis ? { supportedHypothesis: c.supportedHypothesis } : {}),
            by: i.by,
          },
          contributors: [...new Set([...x.contributors, i.by])],
        },
        i,
        "conclusion",
      );
    }),
    "review-conclusion": make("review-conclusion", "review", "review", (s, x, i, bad) => {
      if (x.contributors.includes(i.by))
        bad(
          "conclusion reviewer must be independent of investigation contributors",
          "use a review-capable role that did not contribute to or execute this investigation",
        );
      if (typeof i.approve !== "boolean" || !text(i.reason))
        bad(
          "review needs approval and reason",
          "set approve to a boolean and reason to a nonempty review explanation",
        );
      if (!i.approve) {
        const target = i.next ?? "conclusion";
        if (target !== "round" && target !== "conclusion")
          bad(
            "review rejection next must be round or conclusion",
            "set next to round for more evidence or conclusion for a revised conclusion",
          );
        const n = save(
          s,
          {
            ...x,
            phase: target === "round" ? "preregister" : "conclusion",
            reviewHistory: [
              ...(x.reviewHistory ?? []),
              {
                by: i.by,
                reason: i.reason as string,
                approve: false,
                next: target as "round" | "conclusion",
                replayRefs: [],
              },
            ],
          },
          i,
          "review-rejected",
        );
        const iteration = s.iterations.find((it) => it.id === "investigation")!;
        if (
          target === "round" &&
          (x.rounds.length >= validateInvestigationConfig(s.config).maxRounds ||
            isExhausted(iteration.budget, iteration.spent))
        )
          return closeInvestigation(
            n,
            n.investigation!,
            i,
            "stopped",
            "budget or round limit exhausted after review requested another round",
          );
        return n;
      }
      const replayRefs = Array.isArray(i.replayRefs) ? i.replayRefs : [];
      if (
        x.conclusion!.outcome === "resolved" &&
        (!refs(replayRefs) ||
          !x.rounds.some(
            (r) =>
              r.experiment.replayOf &&
              !executionActors(s, r.item).some((actor) =>
                executionActors(
                  s,
                  x.rounds.find((p) => p.experiment.id === r.experiment.replayOf)!.item,
                ).includes(actor),
              ) &&
              sameHypothesis(
                r.hypotheses.find((h) => h.id === x.conclusion!.supportedHypothesis),
                x.rounds.at(-1)!.hypotheses.find((h) => h.id === x.conclusion!.supportedHypothesis),
              ) &&
              r.result?.valid &&
              replayRefs.includes(r.result.id) &&
              r.update?.assessments.some(
                (a) =>
                  a.hypothesis === x.conclusion!.supportedHypothesis &&
                  a.assessment === "supported",
              ),
          ))
      )
        bad(
          "resolved conclusion requires valid replay result and supporting belief update",
          "set replayRefs to a valid independent replay result supporting the latest supported hypothesis definition, or reject with next round",
        );
      return closeInvestigation(
        s,
        {
          ...x,
          review: { by: i.by, reason: i.reason as string, replayRefs: replayRefs as string[] },
          reviewHistory: [
            ...(x.reviewHistory ?? []),
            {
              by: i.by,
              reason: i.reason as string,
              approve: true,
              replayRefs: replayRefs as string[],
            },
          ],
        },
        i,
        x.conclusion!.outcome,
      );
    }),
    stop: make("stop", "facilitate", undefined, (s, x, i, bad) => {
      if (!text(i.reason))
        bad(
          "stop needs reason",
          "set reason to a nonempty explanation for stopping this investigation",
        );
      return closeInvestigation(s, x, i, "stopped", i.reason as string);
    }),
  };
}
