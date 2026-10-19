import { isExhausted, remaining } from "../budget.ts";
import { moveItem } from "../items.ts";
import { openIteration } from "../planner.ts";
import { appendEvent } from "../state.ts";
import type { CoreTerm, Methodology, PlannerOptions, WorkItem, WorkflowState } from "../types.ts";
import { scrumCeremonies } from "./ceremonies.ts";
import { validateScrumConfig, type ScrumConfig } from "./config.ts";
import { scrumRoles } from "./roles.ts";
import { scrumRules } from "./rules.ts";
import { scrumStages } from "./stages.ts";

export { validateScrumConfig, scrumRoles, scrumRules, scrumStages };
export type { ScrumConfig };
export { scrumCeremonies, dailyReport, canDo } from "./ceremonies.ts";
export type { DailyReport } from "./ceremonies.ts";

export const SCRUM_VOCABULARY: Record<CoreTerm, string> = {
  backlog: "Product Backlog",
  item: "Product Backlog Item",
  stage: "Column",
  iteration: "Sprint",
  increment: "Increment",
  ceremony: "Scrum Event",
  gate: "Sprint Review",
};

export function configOf(state: WorkflowState): ScrumConfig {
  return state.config as ScrumConfig;
}

export function closeSprint(
  state: WorkflowState,
  reason: "budget" | "review" | "cancel",
  now: string,
): WorkflowState {
  const it = openIteration(state);
  if (!it) return state;
  const done = it.committed.filter((id) => state.items[id]?.status === "done");
  const dropped = it.committed.filter((id) => state.items[id]?.status === "dropped");
  const carryover = it.committed.filter((id) => {
    const status = state.items[id]?.status;
    return status !== "done" && status !== "dropped";
  });
  let s: WorkflowState = state;
  for (const id of carryover) {
    const item = s.items[id]!;
    if (item.stage !== "backlog" || item.status !== "todo")
      s = moveItem(s, id, { stage: "backlog", status: "todo" }, "system", now);
    const { iteration: _i, role: _r, ...rest } = s.items[id]!;
    s = { ...s, items: { ...s.items, [id]: rest as WorkItem } };
  }
  const weightOf = (ids: string[]) =>
    ids.reduce((sum, id) => sum + (state.items[id]?.weight ?? 0), 0);
  s = {
    ...s,
    iterations: s.iterations.map((x) =>
      x.id === it.id
        ? {
            ...x,
            endedAt: now,
            outcome: reason === "cancel" ? "cancelled" : "completed",
            carryover,
          }
        : x,
    ),
  };
  return appendEvent(
    s,
    "sprint.closed",
    "system",
    {
      id: it.id,
      reason,
      done,
      carryover,
      dropped,
      doneWeight: weightOf(done),
      committedWeight: weightOf(it.committed),
      spent: it.spent,
      budget: it.budget,
    },
    now,
  );
}

export function scrum(): Methodology<ScrumConfig> {
  return {
    name: "scrum",
    vocabulary: SCRUM_VOCABULARY,
    validateConfig: validateScrumConfig,
    defaultStages: scrumStages,
    defaultRoles: scrumRoles,
    requiredCapabilities: ["order-backlog", "facilitate", "deliver"],
    exclusiveCapabilities: ["order-backlog"],
    plannerOptions(state): PlannerOptions {
      const cap = configOf(state).inProgressWipLimit;
      return cap === undefined
        ? { schedulerMode: "level", dispatchStage: "in_progress" }
        : { schedulerMode: "level", dispatchStage: "in_progress", concurrencyCap: cap };
    },
    candidates(state): WorkItem[] {
      const it = openIteration(state);
      if (!it) return [];
      return Object.values(state.items).filter(
        (i) =>
          i.iteration === it.id &&
          (i.status === "todo" || i.status === "review") &&
          (i.stage === "sprint" || i.stage === "review"),
      );
    },
    invariants(state, item): string[] {
      const it = openIteration(state);
      const cfg = configOf(state);
      const left = it ? remaining(it.budget, it.spent) : {};
      return [
        `Sprint Goal: ${it?.goal ?? "(no open sprint)"}; Product Goal: ${cfg.productGoal}`,
        `Budget remaining: ${JSON.stringify(left)}; stop and hand off when it is gone`,
        `Definition of Done: ${cfg.definitionOfDone.map((p) => (p.kind === "evidence" ? `evidence ${p.evidenceKind}` : p.kind)).join(", ") || "(none)"}`,
        `Do not change the scope of "${item.id}" or its acceptance criteria; raise open_questions instead`,
      ];
    },
    ceremonies: scrumCeremonies(scrum),
    rules: scrumRules(),
    metrics: () => ({}),
    humanDefaults: { gates: ["sprint-review"] },
    afterComplete(state, _itemId, now) {
      const it = openIteration(state);
      if (it && isExhausted(it.budget, it.spent)) return closeSprint(state, "budget", now);
      return state;
    },
  };
}
