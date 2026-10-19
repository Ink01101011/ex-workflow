import { openIteration } from "../planner.ts";
import type { Budget, Iteration, Rule, Violation, WorkflowState } from "../types.ts";
import type { ItemPatch } from "../items.ts";
import { canDo, closedSeq } from "./ceremonies.ts";
import { configOf } from "./index.ts";

const v = (
  rule: string,
  severity: Violation["severity"],
  message: string,
  fix: string,
  item?: string,
): Violation => (item ? { rule, severity, item, message, fix } : { rule, severity, message, fix });

function lastClosed(state: WorkflowState): Iteration | undefined {
  for (let i = state.iterations.length - 1; i >= 0; i--) {
    const it = state.iterations[i]!;
    if (it.endedAt !== undefined) return it;
  }
  return undefined;
}
export function scrumRules(): Rule[] {
  const oneOpen: Rule = {
    id: "one-open-sprint",
    severity: "error",
    check: (s, a) =>
      a.type === "ceremony.plan" && openIteration(s)
        ? [
            v(
              "one-open-sprint",
              "error",
              `sprint ${openIteration(s)!.id} is still open`,
              "review or cancel it before planning the next sprint",
            ),
          ]
        : [],
  };

  const retroFirst: Rule = {
    id: "retro-before-plan",
    severity: "error",
    check: (s, a) => {
      if (a.type !== "ceremony.plan") return [];
      const last = lastClosed(s);
      if (!last) return [];
      const seq = closedSeq(s, last.id);
      if (s.events.some((e) => e.type === "retro" && e.seq > seq)) return [];
      const sev = last.outcome === "cancelled" ? "warning" : "error";
      return [
        v(
          "retro-before-plan",
          sev,
          `sprint ${last.id} has no retrospective yet`,
          "run the retro ceremony first (lessons may be empty)",
        ),
      ];
    },
  };

  const budgetFixed: Rule = {
    id: "sprint-budget-fixed",
    severity: "error",
    check: (s, a) => {
      if (a.type !== "ceremony.plan") return [];
      const b = (a.payload as { budget?: Budget } | undefined)?.budget;
      if (b === undefined || JSON.stringify(b) === JSON.stringify(configOf(s).sprintBudget))
        return [];
      return [
        v(
          "sprint-budget-fixed",
          "error",
          "sprint length is fixed by config.sprintBudget",
          "change sprintBudget in the config between sprints instead of per plan",
        ),
      ];
    },
  };

  const scope: Rule = {
    id: "scope-protects-goal",
    severity: "error",
    check: (s, a) => {
      if (a.type !== "ceremony.commit") return [];
      const cfg = configOf(s);
      const p = (a.payload ?? {}) as { goalImpact?: string };
      if (cfg.allowMidSprintAdd === "never")
        return [
          v(
            "scope-protects-goal",
            "error",
            "mid-sprint additions are disabled",
            'set allowMidSprintAdd to "po-only" or wait for the next sprint',
          ),
        ];
      if (cfg.allowMidSprintAdd === "po-only" && !canDo(s, a.by, "order-backlog"))
        return [
          v(
            "scope-protects-goal",
            "error",
            `"${a.by}" may not add work mid-sprint`,
            "ask the Product Owner (order-backlog) to commit it",
          ),
        ];
      if (p.goalImpact !== "none")
        return [
          v(
            "scope-protects-goal",
            "error",
            `adding work with goalImpact "${p.goalImpact ?? "unset"}" endangers the Sprint Goal`,
            'only commit items with goalImpact: "none"; otherwise cancel and re-plan',
          ),
        ];
      return [];
    },
  };

  const poOrders: Rule = {
    id: "po-orders-backlog",
    severity: "error",
    check: (s, a) => {
      if (a.type !== "ceremony.refine" || canDo(s, a.by, "order-backlog")) return [];
      const items =
        ((a.payload ?? {}) as { items?: Array<{ id: string; patch: ItemPatch }> }).items ?? [];
      return items
        .filter((i) => i.patch.priority !== undefined)
        .map((i) =>
          v(
            "po-orders-backlog",
            "error",
            `"${a.by}" may not change the priority of "${i.id}"`,
            "only the Product Owner orders the backlog; drop priority from the patch",
            i.id,
          ),
        );
    },
  };

  const dod: Rule = {
    id: "dod-not-weakened",
    severity: "error",
    check: (s, a) =>
      a.type === "ceremony.retro" &&
      (a.payload as { dodChanges?: unknown } | undefined)?.dodChanges !== undefined &&
      openIteration(s)
        ? [
            v(
              "dod-not-weakened",
              "error",
              "Definition of Done cannot change while a sprint is open",
              "close the sprint first; DoD changes apply to the next sprint",
            ),
          ]
        : [],
  };

  const carry: Rule = {
    id: "carryover-reestimated",
    severity: "error",
    check: (s, a) => {
      if (a.type !== "ceremony.plan") return [];
      const items = (a.payload as { items?: string[] | "auto" } | undefined)?.items;
      if (!Array.isArray(items)) return [];
      const last = lastClosed(s);
      if (!last) return [];
      const seq = closedSeq(s, last.id);
      return items
        .filter(
          (id) =>
            last.carryover.includes(id) &&
            !s.events.some(
              (e) =>
                e.type === "item.edited" &&
                e.seq > seq &&
                (e.payload as { id: string; changed: string[] }).id === id &&
                (e.payload as { changed: string[] }).changed.includes("weight"),
            ),
        )
        .map((id) =>
          v(
            "carryover-reestimated",
            "error",
            `carried-over item "${id}" was not re-estimated after ${last.id}`,
            "refine it with a new weight before committing",
            id,
          ),
        );
    },
  };

  return [oneOpen, retroFirst, budgetFixed, scope, poOrders, dod, carry];
}
