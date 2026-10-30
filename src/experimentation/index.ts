import type { Methodology } from "../types.ts";
import {
  experimentationCeremonies,
  candidateExhausted,
  exhausted,
  runningCount,
  assignedAuthor,
  synchronizeBudget,
  reservedTokens,
} from "./ceremonies.ts";
import { validateExperimentationConfig, type ExperimentationConfig } from "./config.ts";
import { experimentationMetrics, experimentationReport } from "./metrics.ts";
import { experimentationRoles } from "./roles.ts";
import { experimentationRules } from "./rules.ts";
import { experimentationStages } from "./stages.ts";
export {
  validateExperimentationConfig,
  experimentationCeremonies,
  experimentationMetrics,
  experimentationReport,
  experimentationRoles,
  experimentationRules,
  experimentationStages,
};
export type { ExperimentationConfig } from "./config.ts";
export type { ExperimentationState, ExperimentCandidate } from "./state.ts";
export function experimentation(): Methodology<ExperimentationConfig> {
  return {
    name: "experimentation",
    vocabulary: {
      backlog: "Candidate pool",
      item: "Candidate work item",
      stage: "Experiment stage",
      iteration: "Experiment run",
      increment: "Validated integration",
      ceremony: "Experiment control",
      gate: "Independent validation",
    },
    validateConfig: validateExperimentationConfig,
    defaultStages: experimentationStages,
    defaultRoles: experimentationRoles,
    requiredCapabilities: ["facilitate", "manage-flow", "deliver", "verify", "control-change"],
    exclusiveCapabilities: [],
    plannerOptions(s) {
      const cfg = validateExperimentationConfig(s.config);
      return {
        schedulerMode: "throughput",
        dispatchStage: "building",
        concurrencyCap: Math.max(1, cfg.concurrencyCap - runningCount(s)),
        fallbackTokensPerWeight: 1,
        reservedTokens: reservedTokens(s),
        roleFor(item) {
          return Object.values(s.experimentation?.candidates ?? {}).find(
            (candidate) => candidate.item === item.id,
          )?.author;
        },
      };
    },
    candidates(s) {
      const e = s.experimentation;
      if (!e || e.status !== "running") return [];
      const cfg = validateExperimentationConfig(s.config);
      if (exhausted(s) || runningCount(s) >= cfg.concurrencyCap) return [];
      return Object.values(e.candidates)
        .filter(
          (c) =>
            c.status === "ready" &&
            assignedAuthor(s, c) &&
            s.items[c.item]?.status === "todo" &&
            !candidateExhausted(s, c),
        )
        .map((c) => s.items[c.item]!);
    },
    afterComplete(s, _item, now) {
      return synchronizeBudget(s, now);
    },
    invariants(s, item) {
      const e = s.experimentation;
      const c = Object.values(e?.candidates ?? {}).find((candidate) => candidate.item === item.id);
      return [
        `Frozen base SHA: ${e?.baseSha ?? "unfrozen"}; harness: ${e?.harness ?? "unfrozen"}`,
        `Candidate: ${c?.id ?? "unregistered"}; isolated workspace: ${c?.workspace ?? "not provisioned"}`,
        `Objective and budget: ${JSON.stringify(s.config)}`,
        "Submit an exact commit SHA and harness benchmark before completion; independent validation is mandatory.",
        "Host owns process execution, Git integration and workspace cleanup.",
      ];
    },
    ceremonies: experimentationCeremonies(),
    rules: experimentationRules(),
    metrics: experimentationMetrics,
    report: experimentationReport,
    humanDefaults: { gates: "none" },
    lockedConfigKeys: [
      "objective",
      "direction",
      "tieBreak",
      "concurrencyCap",
      "maxCandidates",
      "candidateBudget",
      "totalBudget",
    ],
  };
}
