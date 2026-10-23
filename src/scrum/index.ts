import { isExhausted, remaining } from "../budget.ts";
import { getItem, moveItem, patchItem, stripItemFields } from "../items.ts";
import { openIteration } from "../planner.ts";
import { appendEvent } from "../state.ts";
import type { CoreTerm, Methodology, PlannerOptions, WorkItem, WorkflowState } from "../types.ts";
import { scrumCeremonies, setDod } from "./ceremonies.ts";
import { validateScrumConfig, type ScrumConfig } from "./config.ts";
import { scrumMetrics, type ScrumMetrics } from "./metrics.ts";
import { scrumRoles } from "./roles.ts";
import { scrumRules } from "./rules.ts";
import { scrumStages } from "./stages.ts";

export { validateScrumConfig, scrumRoles, scrumRules, scrumStages, scrumMetrics };
export type { ScrumMetrics };
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

/** Advanced; used by ceremonies. */
export function configOf(state: WorkflowState): ScrumConfig {
  return state.config as ScrumConfig;
}

/** The stage a carried-over item was returned from when it was in review: it resumes there, not at the sprint start. */
export function resumeStageOf(item: WorkItem): string | undefined {
  const t = item.transitions.at(-1);
  return t &&
    t.by === "system" &&
    t.to.stage === "backlog" &&
    t.to.status === "todo" &&
    t.from.status === "review"
    ? t.from.stage
    : undefined;
}

/** Send an item back to the backlog: clear its open blockers and pending decisions, strip iteration and role. */
function toBacklog(state: WorkflowState, id: string, now: string): WorkflowState {
  let s = state;
  const open = getItem(s, id).blockers.filter((b) => !b.clearedAt);
  if (open.length) {
    s = patchItem(s, id, (it) => ({
      ...it,
      blockers: it.blockers.map((b) => (b.clearedAt ? b : { ...b, clearedAt: now })),
    }));
    for (const b of open)
      s = appendEvent(
        s,
        "blocker.cleared",
        "system",
        { id, blocker: b.id, reason: "sprint closed" },
        now,
      );
  }
  for (const p of s.pending.filter((x) => x.item === id)) {
    s = { ...s, pending: s.pending.filter((x) => x.id !== p.id) };
    s = appendEvent(
      s,
      "pending.dropped",
      "system",
      { id: p.id, item: id, reason: "sprint closed" },
      now,
    );
  }
  const cur = getItem(s, id);
  if (cur.stage !== "backlog" || cur.status !== "todo")
    s = moveItem(s, id, { stage: "backlog", status: "todo" }, "system", now);
  // a question keeps its role: only the escalation target can answer it
  return stripItemFields(s, id, cur.type === "question" ? ["iteration"] : ["iteration", "role"]);
}

/** Advanced; used by ceremonies. Closes the open sprint and returns unfinished work (and its open questions) to the backlog. */
export function closeSprint(
  state: WorkflowState,
  reason: "budget" | "review" | "cancel",
  now: string,
): WorkflowState {
  const it = openIteration(state);
  if (!it) return state;
  const committed = it.committed.map((id) => getItem(state, id));
  const done = committed.filter((i) => i.status === "done").map((i) => i.id);
  const dropped = committed.filter((i) => i.status === "dropped").map((i) => i.id);
  const carryover = committed
    .filter((i) => i.status !== "done" && i.status !== "dropped")
    .map((i) => i.id);
  const carriedQuestions = Object.values(state.items)
    .filter(
      (i) =>
        i.type === "question" &&
        i.parent !== undefined &&
        carryover.includes(i.parent) &&
        i.status !== "done" &&
        i.status !== "dropped",
    )
    .map((i) => i.id);
  let s: WorkflowState = state;
  for (const id of [...carryover, ...carriedQuestions]) s = toBacklog(s, id, now);
  const weightOf = (ids: string[]) =>
    ids.reduce((sum, id) => sum + (state.items[id]?.weight ?? 0), 0);
  s = {
    ...s,
    iterations: s.iterations.map((x) => {
      if (x.id !== it.id) return x;
      const { closing: _c, ...rest } = x;
      return {
        ...rest,
        endedAt: now,
        outcome: reason === "cancel" ? "cancelled" : "completed",
        carryover,
      };
    }),
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
      carriedQuestions,
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
      const cfg = configOf(state);
      const po: PlannerOptions = { schedulerMode: "level", dispatchStage: "in_progress" };
      if (cfg.inProgressWipLimit !== undefined) po.concurrencyCap = cfg.inProgressWipLimit;
      if (cfg.estimateMode !== undefined) po.estimateMode = cfg.estimateMode;
      if (cfg.fallbackTokensPerWeight !== undefined)
        po.fallbackTokensPerWeight = cfg.fallbackTokensPerWeight;
      return po;
    },
    candidates(state): WorkItem[] {
      const it = openIteration(state);
      if (!it || it.closing) return [];
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
    metrics: (state) => ({ ...scrumMetrics(state) }),
    report(state) {
      const it = openIteration(state);
      return {
        closing: it?.closing === true,
        sprint: it?.id ?? null,
        reason: it?.closing ? "budget" : null,
        inFlight: it
          ? Object.values(state.items)
              .filter(
                (i) =>
                  (i.iteration === it.id || it.committed.includes(i.id)) &&
                  i.status === "in_progress",
              )
              .map((i) => i.id)
          : [],
      };
    },
    humanDefaults: { gates: ["sprint-review"] },
    afterConfigChange(state) {
      return setDod(state, configOf(state).definitionOfDone);
    },
    afterComplete(state, _itemId, now) {
      const it = openIteration(state);
      if (!it || (!it.closing && !isExhausted(it.budget, it.spent))) return state;
      const inFlight = Object.values(state.items).some(
        (i) => (i.iteration === it.id || it.committed.includes(i.id)) && i.status === "in_progress",
      );
      if (!inFlight && configOf(state).autoClose !== false)
        return closeSprint(state, "budget", now);
      if (it.closing) return state;
      return appendEvent(
        {
          ...state,
          iterations: state.iterations.map((x) => (x.id === it.id ? { ...x, closing: true } : x)),
        },
        "sprint.closing",
        "system",
        { id: it.id },
        now,
      );
    },
  };
}
