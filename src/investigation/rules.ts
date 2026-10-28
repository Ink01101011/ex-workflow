import { executionActors } from "./execution.ts";
import type { Rule } from "../types.ts";
export function investigationRules(): Rule[] {
  return [
    {
      id: "independent-replay",
      severity: "error",
      check(s, a) {
        if (a.type !== "item.complete") return [];
        const round = s.investigation?.rounds.find(
          (r) => r.item === (a.payload as { item?: string })?.item,
        );
        const prior = s.investigation?.rounds.find(
          (r) => r.experiment.id === round?.experiment.replayOf,
        );
        return prior && executionActors(s, prior.item).includes(a.by)
          ? [
              {
                rule: "independent-replay",
                item: round!.item,
                severity: "error",
                message: "Replay executor also executed the original experiment",
                fix: "assign a different deliver-capable role",
              },
            ]
          : [];
      },
    },
    {
      id: "investigation-execution-only",
      severity: "error",
      check(s, a) {
        if (a.type !== "item.complete") return [];
        const p = a.payload as { item: string };
        const x = s.investigation;
        return x?.phase === "observe" && x.rounds.at(-1)?.item === p.item
          ? []
          : [
              {
                rule: "investigation-execution-only",
                item: p.item,
                severity: "error",
                message: "Only the active preregistered experiment can complete",
                fix: `complete only the active experiment item in phase observe; current phase is ${x?.phase ?? "intake"}`,
              },
            ];
      },
    },
  ];
}
