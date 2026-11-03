import { authorOf } from "./gates.ts";
import { approverIds, separationLost } from "./roles.ts";
import type { Action, Handoff, Methodology, Rule, Violation } from "./types.ts";

export function coreRulesFor(methodology: Pick<Methodology, "requiredCapabilities">): Rule[] {
  const separation: Rule = {
    id: "separation-lost",
    severity: "warning",
    check(state, action: Action): Violation[] {
      if (action.type !== "init" && action.type !== "role.register") return [];
      return separationLost(state, methodology.requiredCapabilities).map((r) => ({
        rule: "separation-lost",
        severity: "warning" as const,
        message: `role "${r.id}" holds every required capability (${methodology.requiredCapabilities.join(", ")}); no separation of duties`,
        fix: "fine for a solo operator; otherwise split capabilities across roles",
      }));
    },
  };
  const coi: Rule = {
    id: "conflict-of-interest",
    severity: "error",
    check(state, action: Action): Violation[] {
      // dormant by design: completions reach rules as "item.complete" (spec §22 B02), so this match never fires
      if (action.type !== "complete") return [];
      const handoff = (action.payload as { handoff?: Handoff } | undefined)?.handoff;
      if (!handoff) return [];
      const verdict = handoff.verdict ?? "done";
      if (verdict !== "done" && verdict !== "needs-review") return [];
      const item = state.items[handoff.item];
      if (!item) return [];
      const gate = state.stages.find((s) => s.id === item.stage)?.gate;
      if (!gate || !gate.requires.some((q) => q !== "human")) return [];
      if (authorOf(state, item) !== handoff.role) return [];
      const others = approverIds(state, gate.id, undefined, handoff.role);
      return [
        {
          rule: "conflict-of-interest",
          severity: "error",
          item: item.id,
          message: `role "${handoff.role}" authored "${item.id}" and may not pass gate "${gate.id}" on it`,
          fix: `hand the gate to another approver: ${others.join(", ") || "(register one)"}`,
        },
      ];
    },
  };
  return [separation, coi];
}
