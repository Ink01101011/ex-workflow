import { fail } from "../errors.ts";
import { executionActors } from "./execution.ts";
import { closeInvestigation, investigationCeremonies } from "./ceremonies.ts";
import { investigationRules } from "./rules.ts";
import { investigationRoles } from "./roles.ts";
import { investigationStages } from "./stages.ts";
import { isExhausted } from "../budget.ts";
import type { Methodology } from "../types.ts";
import { validateInvestigationConfig, type InvestigationConfig } from "./config.ts";
export { validateInvestigationConfig };
export type { InvestigationConfig };
export type * from "./state.ts";
export function investigation(): Methodology<InvestigationConfig> {
  return {
    name: "investigation",
    validateConfig: validateInvestigationConfig,
    lockedConfigKeys: ["question", "maxRounds", "budget"],
    vocabulary: {
      backlog: "Questions",
      item: "Investigation artifact",
      stage: "Investigation phase",
      iteration: "Investigation budget",
      increment: "Conclusion",
      ceremony: "Investigation ceremony",
      gate: "Independent conclusion review",
    },
    defaultStages: investigationStages,
    defaultRoles: investigationRoles,
    requiredCapabilities: ["facilitate", "define-acceptance", "deliver", "verify", "review"],
    exclusiveCapabilities: [],
    humanDefaults: { gates: "none" },
    ceremonies: investigationCeremonies(investigation),
    plannerOptions: (state) => ({
      schedulerMode: "level",
      concurrencyCap: 1,
      roleFor: (item) => {
        const r = state.investigation?.rounds.find((candidate) => candidate.item === item.id);
        const prior = state.investigation?.rounds.find(
          (p) => p.experiment.id === r?.experiment.replayOf,
        );
        const excluded = prior ? executionActors(state, prior.item) : [];
        const roles = Object.values(state.roles);
        const selected =
          (!prior
            ? roles.find(
                (role) =>
                  role.capabilities.includes("deliver") &&
                  role.capabilities.includes("define-acceptance"),
              )
            : undefined) ??
          roles.find(
            (role) => role.capabilities.includes("deliver") && !excluded.includes(role.id),
          );
        if (!selected)
          fail(
            "missing-capability",
            `No eligible executor for experiment item "${item.id}"`,
            prior
              ? `register an independent deliver-capable role that did not execute "${prior.item}"`
              : "register a role with deliver capability",
            { items: [item.id] },
          );
        return selected.id;
      },
      estimateMode: "per-call",
      fallbackTokensPerWeight: 1,
    }),
    candidates: (s) =>
      s.investigation?.phase === "observe" &&
      !isExhausted(
        (s.config as InvestigationConfig).budget,
        s.iterations.find((it) => it.id === "investigation")!.spent,
      )
        ? Object.values(s.items).filter(
            (i) =>
              i.id === s.investigation!.rounds.at(-1)?.item &&
              i.stage === "execute" &&
              i.status === "todo",
          )
        : [],
    afterComplete: (state, item, now) => {
      const x = state.investigation;
      const iteration = state.iterations.find((it) => it.id === "investigation");
      if (
        x?.phase !== "observe" ||
        x.rounds.at(-1)?.item !== item ||
        state.items[item]?.status === "done" ||
        !iteration ||
        !isExhausted(iteration.budget, iteration.spent)
      )
        return state;
      return closeInvestigation(
        state,
        x,
        { by: "investigation", now },
        "stopped",
        `budget exhausted before experiment item "${item}" completed; start a new investigation with sufficient budget`,
      );
    },
    invariants: (s) => [
      `Question: ${(s.config as InvestigationConfig).question}`,
      "Execute only the preregistered procedure; retain raw observation provenance; report invalid runs.",
    ],
    rules: investigationRules(),
    metrics: (s) => ({
      rounds: s.investigation?.rounds.length ?? 0,
      validRuns: s.investigation?.rounds.filter((r) => r.result?.valid).length ?? 0,
      invalidRuns: s.investigation?.rounds.filter((r) => r.result && !r.result.valid).length ?? 0,
    }),
    report: (s) => ({
      phase: s.investigation?.phase ?? "intake",
      outcome: s.investigation?.outcome ?? null,
      rounds: s.investigation?.rounds.length ?? 0,
      conclusion: s.investigation?.conclusion ?? null,
      stopReason: s.investigation?.stopReason ?? null,
    }),
  };
}
