import { timSort } from "exsorted";
import type { CoreTerm, Methodology, PlannerOptions, Policy, WorkItem } from "../types.ts";
import { cadencesDue } from "./board.ts";
import { kanbanCeremonies } from "./ceremonies.ts";
import { ACTIVE, activeExpedites, commitmentColumn, enteredStageAt, onBoard } from "./columns.ts";
import { configOf, validateKanbanConfig, type KanbanConfig } from "./config.ts";
import { kanbanMetrics } from "./metrics.ts";
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
export { opsReport, riskReport } from "./reports.ts";
export type { OpsReport, RiskReport } from "./reports.ts";
export { replay } from "./replay.ts";
export { kanbanMetrics, percentile, columnStays } from "./metrics.ts";
export type { KanbanMetrics } from "./metrics.ts";
export type { Replay, ReplayedItem, ReplayedBlocker, Stay } from "./replay.ts";

const RANK: Record<string, number> = { expedite: 0, "fixed-date": 1, standard: 2, intangible: 3 };
const rankOf = (item: WorkItem) => RANK[item.classOfService ?? "standard"] ?? 2;

/** What the priority function needs besides the card: how long it has been passed over, and the fairness config. */
export interface PriorityContext {
  /** next() rounds that resolved since the card entered its column */
  deferrals: number;
  aging: boolean;
  maxDeferralRounds: number;
}

const BAND = 1e15;
const AGE_STEP = 4e9;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Class band x 1e15 + an in-band offset. Bands: question 5, expedite 4, fixed-date 3, standard 2,
 * intangible 1. Fixed-date: earlier deadline = larger offset. Others: own priority (clamped to +-1e9)
 * plus, with aging, 4e9 per full window of maxDeferralRounds deferrals (priority decides within a window). An intangible card deferred that many
 * times is scored in the standard band, so it overtakes fresh standard cards.
 */
export function priorityByClass(item: WorkItem, ctx: PriorityContext): number {
  const cos = item.classOfService ?? "standard";
  if (item.type === "question") return 5 * BAND;
  if (cos === "fixed-date" && item.deadline !== undefined) {
    const t = Date.parse(item.deadline);
    if (Number.isFinite(t)) return 3 * BAND + 1e10 - Math.floor(t / 1000);
  }
  const aged = ctx.aging ? Math.floor(ctx.deferrals / ctx.maxDeferralRounds) : 0;
  const offset = clamp(item.priority ?? 0, -1e9, 1e9) + aged * AGE_STEP;
  const promoted = ctx.aging && ctx.deferrals >= ctx.maxDeferralRounds;
  const band =
    cos === "expedite" ? 4 : cos === "fixed-date" ? 3 : cos === "intangible" && !promoted ? 1 : 2;
  return band * BAND + offset;
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
      // one pass over the events: times, planner.resolved prefix counts and item.added times
      const times: number[] = [];
      const resolvedBefore: number[] = [0]; // resolvedBefore[i] = resolved events among events[0..i)
      const added = new Map<string, string>();
      for (const e of state.events) {
        times.push(Date.parse(e.at));
        resolvedBefore.push(
          resolvedBefore[resolvedBefore.length - 1]! + (e.type === "planner.resolved" ? 1 : 0),
        );
        if (e.type === "item.added") added.set((e.payload as { id: string }).id, e.at);
      }
      /** planner.resolved events after the last event at or before `t` (events are time-ordered). */
      const deferralsSince = (t: number): number => {
        let lo = 0;
        let hi = times.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (times[mid]! <= t) lo = mid + 1;
          else hi = mid;
        }
        return resolvedBefore[times.length]! - resolvedBefore[lo]!;
      };
      const po: PlannerOptions = {
        schedulerMode: "throughput",
        fairnessPolicy: cfg.fairness.aging ? "aging" : "none",
        deadlineStrategy: "earliest-first",
        dispatchStage: (item) => (item.stage === commit.id && after ? after.id : undefined),
        priorityOf: (item) => {
          const since = Date.parse(enteredStageAt(item) ?? added.get(item.id) ?? "");
          return priorityByClass(item, {
            deferrals: deferralsSince(Number.isFinite(since) ? since : 0),
            aging: cfg.fairness.aging,
            maxDeferralRounds: cfg.fairness.maxDeferralRounds,
          });
        },
        tieBreaker: byClassThenAge,
        wipCounts: [...ACTIVE],
        wipLimitOf: (stage, item) =>
          stage.wipLimit === undefined
            ? undefined
            : item.classOfService === "expedite"
              ? stage.wipLimit + bypass
              : stage.wipLimit,
      };
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
    metrics: (state) => ({ ...kanbanMetrics(state) }),
    humanDefaults: { gates: "none" },
    report: (state) => ({ cadencesDue: cadencesDue(state) }),
  };
}
