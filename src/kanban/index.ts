import { timSort } from "exsorted";
import type { CoreTerm, Methodology, PlannerOptions, Policy, WorkItem } from "../types.ts";
import { cadencesDue } from "./board.ts";
import { kanbanCeremonies } from "./ceremonies.ts";
import { ACTIVE, activeExpedites, commitmentColumn, enteredStageAt, onBoard } from "./columns.ts";
import { configOf, validateKanbanConfig, type KanbanConfig } from "./config.ts";
import { kanbanRoles } from "./roles.ts";
import { kanbanRules } from "./rules.ts";
import { kanbanStages } from "./stages.ts";

export {
  validateKanbanConfig,
  DEFAULT_COLUMNS,
  KANBAN_CADENCES,
  CLASSES,
  DAY_MS,
} from "./config.ts";
export { kanbanRoles } from "./roles.ts";
export { kanbanStages } from "./stages.ts";
export { kanbanRules } from "./rules.ts";
export { kanbanCeremonies, wantItems } from "./ceremonies.ts";
export type {
  KanbanConfig,
  KanbanColumn,
  KanbanCadence,
  ClassConfig,
  ServiceLevel,
} from "./config.ts";
export {
  ACTIVE,
  OPEN,
  optionsColumn,
  commitmentColumn,
  deliveryColumn,
  columnIndex,
  onBoard,
  activeExpedites,
  enteredStageAt,
} from "./columns.ts";

export const KANBAN_VOCABULARY: Record<CoreTerm, string> = {
  backlog: "Options",
  item: "Work Item",
  stage: "Column",
  iteration: "Cadence",
  increment: "Delivery",
  ceremony: "Cadence",
  gate: "Policy",
};

export { configOf } from "./config.ts";
export { board, cardAge, addedAt, cadencesDue, CADENCE_EVENT } from "./board.ts";
export type { BoardCard, BoardColumn, CadenceStatus } from "./board.ts";
export { replay } from "./replay.ts";
export type { Replay, ReplayedItem, ReplayedBlocker, Stay } from "./replay.ts";

const RANK: Record<string, number> = { expedite: 0, "fixed-date": 1, standard: 2, intangible: 3 };
const rankOf = (item: WorkItem) => RANK[item.classOfService ?? "standard"] ?? 2;

/** Expedite always first, intangible always last, everything else by its own priority. */
export function priorityByClass(item: WorkItem): number | undefined {
  if (item.classOfService === "expedite") return Number.MAX_SAFE_INTEGER;
  if (item.classOfService === "intangible") return Number.MIN_SAFE_INTEGER;
  return item.priority;
}

/** Class rank, then the card that has waited longest in its column, then id (FIFO by aging). */
export function byClassThenAge(a: WorkItem, b: WorkItem): number {
  const r = rankOf(a) - rankOf(b);
  if (r !== 0) return r;
  const ageA = enteredStageAt(a);
  const ageB = enteredStageAt(b);
  const ta = ageA === undefined ? 0 : Date.parse(ageA);
  const tb = ageB === undefined ? 0 : Date.parse(ageB);
  if (ta !== tb) return ta - tb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function describePolicies(policies: Policy[]): string {
  return (
    policies
      .map((p) =>
        p.kind === "evidence"
          ? `evidence ${p.evidenceKind}`
          : p.kind === "custom"
            ? `${p.id}: ${p.description}`
            : p.kind,
      )
      .join(", ") || "(none)"
  );
}

export function kanban(): Methodology<KanbanConfig> {
  return {
    name: "kanban",
    vocabulary: KANBAN_VOCABULARY,
    validateConfig: validateKanbanConfig,
    defaultStages: kanbanStages,
    defaultRoles: kanbanRoles,
    requiredCapabilities: ["manage-flow", "deliver"],
    exclusiveCapabilities: [],
    plannerOptions(state): PlannerOptions {
      const cfg = configOf(state);
      const commit = commitmentColumn(state);
      const after = state.stages[state.stages.findIndex((s) => s.id === commit.id) + 1];
      const bypass = cfg.classesOfService.expedite?.wipBypass ?? 1;
      const po: PlannerOptions = {
        schedulerMode: "throughput",
        fairnessPolicy: cfg.fairness.aging ? "aging" : "none",
        deadlineStrategy: "earliest-first",
        dispatchStage: (item) => (item.stage === commit.id && after ? after.id : undefined),
        priorityOf: priorityByClass,
        tieBreaker: byClassThenAge,
        wipCounts: [...ACTIVE],
        wipLimitOf: (stage, item) =>
          stage.wipLimit === undefined
            ? undefined
            : item.classOfService === "expedite"
              ? stage.wipLimit + bypass
              : stage.wipLimit,
      };
      if (cfg.fairness.maxDeferralRounds !== undefined)
        po.maxDeferralRounds = cfg.fairness.maxDeferralRounds;
      return po;
    },
    candidates(state): WorkItem[] {
      // at most maxExpedite expedite cards may be active; the free slots go to the oldest waiting expedites
      const slots = Math.max(0, configOf(state).maxExpedite - activeExpedites(state).length);
      const all = Object.values(state.items).filter(
        (i) => (i.status === "todo" || i.status === "review") && onBoard(state, i),
      );
      const expedites = timSort(
        all.filter((i) => i.classOfService === "expedite"),
        byClassThenAge,
      ).slice(0, slots);
      return all.filter((i) => i.classOfService !== "expedite" || expedites.includes(i));
    },
    invariants(state, item): string[] {
      const cfg = configOf(state);
      const st = state.stages.find((s) => s.id === item.stage)!;
      const cos = item.classOfService ?? "standard";
      const sle = cfg.classesOfService[cos]?.sle;
      const active = Object.values(state.items).filter(
        (i) => i.stage === st.id && ACTIVE.has(i.status),
      ).length;
      return [
        `Column "${st.name}" exit policies: ${describePolicies(st.exitPolicy)}`,
        `Class of service: ${cos}${item.deadline ? `; deadline ${item.deadline}` : ""}${sle ? `; service level p${sle.percentile} <= ${sle.targetMs} ms` : ""}`,
        `WIP limit of "${st.name}": ${st.wipLimit ?? "none"} (active now: ${active}); finish this card before pulling another`,
        `Do not change the scope of "${item.id}" or its acceptance criteria; raise open_questions instead`,
      ];
    },
    ceremonies: kanbanCeremonies(kanban),
    rules: kanbanRules(),
    metrics: () => ({}),
    humanDefaults: { gates: "none" },
    report: (state) => ({ cadencesDue: cadencesDue(state) }),
  };
}
