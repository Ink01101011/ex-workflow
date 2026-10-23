import { addSpent } from "../budget.ts";
import { openIteration } from "../planner.ts";
import type { CoreTerm, Methodology, PlannerOptions, WorkItem, WorkflowState } from "../types.ts";
import { configOf, validateWaterfallConfig, type WaterfallConfig } from "./config.ts";
import {
  REVIEW,
  WORK,
  currentPhase,
  itemsInPhase,
  missingDeliverables,
  openPhase,
  phaseIndex,
  phaseOf,
  phasesOf,
} from "./phases.ts";
import { waterfallAfterDecide, waterfallCeremonies } from "./ceremonies.ts";
import { waterfallMetrics } from "./metrics.ts";
import { waterfallRoles } from "./roles.ts";
import { waterfallRules } from "./rules.ts";
import { waterfallStages } from "./stages.ts";
import { traceabilityMatrix } from "./traceability.ts";

export {
  validateWaterfallConfig,
  configOf,
  defaultPhases,
  DEFAULT_PHASE_IDS,
  DEFAULT_DELIVERABLES,
  DEFAULT_DELIVER_BY,
  GATE_ID,
  CHANGE_GATE,
} from "./config.ts";
export type { WaterfallConfig, WaterfallPhaseConfig } from "./config.ts";
export {
  WORK,
  REVIEW,
  DONE,
  phasesOf,
  withPhases,
  getPhase,
  phaseIndex,
  phaseOf,
  itemsInPhase,
  openPhase,
  currentPhase,
  isFrozen,
  producedKinds,
  missingDeliverables,
  lastToPhase,
} from "./phases.ts";
export { waterfallStages } from "./stages.ts";
export { waterfallRoles } from "./roles.ts";
export { waterfallRules } from "./rules.ts";
export { waterfallMetrics } from "./metrics.ts";
export type { WaterfallMetrics } from "./metrics.ts";
export {
  waterfallCeremonies,
  waterfallAfterDecide,
  wantPhase,
  approveChange,
  rejectChange,
} from "./ceremonies.ts";
export { traceabilityMatrix, missingTraces } from "./traceability.ts";
export type { TraceabilityMatrix, TraceRow } from "./traceability.ts";
export { baselinePhase, reopenPhases } from "./baseline.ts";
export type { ReopenResult } from "./baseline.ts";

export const WATERFALL_VOCABULARY: Record<CoreTerm, string> = {
  backlog: "Requirements Baseline",
  item: "Work Package",
  stage: "Step",
  iteration: "Phase",
  increment: "Deliverable",
  ceremony: "Review",
  gate: "Phase Gate",
};

/** The role that delivers the item's phase (config deliverBy); undefined = the planner's default deliverer. */
export function deliverRoleFor(state: WorkflowState, item: WorkItem): string | undefined {
  const id = phaseOf(state, item);
  if (id === undefined) return undefined;
  return configOf(state).phases.find((p) => p.id === id)?.deliverBy;
}

export interface PhaseReportRow {
  id: string;
  name: string;
  status: string;
  items: number;
  done: number;
  missingDeliverables: string[];
  readyForGate: boolean;
}
export interface PhaseReport {
  phases: PhaseReportRow[];
  current: string | null;
  open: string | null;
  pendingGates: Array<{ pending: string; gate: string }>;
}

export function phaseReport(state: WorkflowState): PhaseReport {
  const phases = phasesOf(state).map((p) => {
    const items = itemsInPhase(state, p.id);
    const done = items.filter((i) => i.status === "done").length;
    const missing = missingDeliverables(state, p);
    return {
      id: p.id,
      name: p.name,
      status: p.status,
      items: items.length,
      done,
      missingDeliverables: missing,
      readyForGate: p.status === "open" && done === items.length && missing.length === 0,
    };
  });
  return {
    phases,
    current: currentPhase(state)?.id ?? null,
    open: openPhase(state)?.id ?? null,
    pendingGates: state.pending
      .filter((p) => p.kind === "gate" && p.item === undefined && p.gate !== undefined)
      .map((p) => ({ pending: p.id, gate: p.gate! })),
  };
}

export function waterfall(): Methodology<WaterfallConfig> {
  return {
    name: "waterfall",
    vocabulary: WATERFALL_VOCABULARY,
    validateConfig: validateWaterfallConfig,
    defaultStages: waterfallStages,
    defaultRoles: waterfallRoles,
    requiredCapabilities: ["facilitate", "control-change", "approve-gate", "deliver", "verify"],
    exclusiveCapabilities: [],
    plannerOptions(state): PlannerOptions {
      return {
        schedulerMode: "level",
        // questions keep the escalation role core gave them; reviews use the planner's reviewer logic
        roleFor: (item) =>
          item.status === "todo" && item.type !== "question"
            ? deliverRoleFor(state, item)
            : undefined,
      };
    },
    candidates(state): WorkItem[] {
      const open = openPhase(state);
      if (!open) return [];
      return Object.values(state.items).filter(
        (i) =>
          (i.status === "todo" || i.status === "review") &&
          (i.stage === WORK || i.stage === REVIEW) &&
          i.type !== "change-request" &&
          phaseOf(state, i) === open.id,
      );
    },
    invariants(state, item): string[] {
      const cfg = configOf(state);
      const phases = phasesOf(state);
      const id = phaseOf(state, item);
      const p = id === undefined ? undefined : phases[phaseIndex(state, id)];
      const frozen = phases.filter((x) => x.status === "baselined").map((x) => x.id);
      const human = p?.gate.requires.includes("human");
      return [
        p
          ? `Phase "${p.name}" (${phaseIndex(state, p.id) + 1}/${phases.length}); deliverables: ${p.deliverables.join(", ") || "(none)"}; gate "${p.gate.id}"${human ? " needs human approval" : ""}`
          : "This item belongs to no phase; it is dispatched only through its parent's phase",
        `Baselined phases are frozen: ${frozen.join(", ") || "(none yet)"}; to change their items, raise a change-request with an impact analysis`,
        cfg.traceability.to.length
          ? `Traceability: every item of phase "${cfg.traceability.from}" must trace to an item in ${cfg.traceability.to.join(", ")} (set traces on either side)`
          : "Traceability: none configured",
        `Do not change the scope of "${item.id}" or its acceptance criteria; raise open_questions instead`,
      ];
    },
    ceremonies: waterfallCeremonies(waterfall),
    rules: waterfallRules(),
    metrics: (state) => ({ ...waterfallMetrics(state) }),
    humanDefaults: { gates: "all" },
    lockedConfigKeys: ["phases", "traceability"],
    report: (state) => ({ ...phaseReport(state), coverage: traceabilityMatrix(state).coverage }),
    afterDecide: waterfallAfterDecide,
    afterComplete(state, itemId, _now) {
      // an item added to the phase after kickoff is not in the iteration's committed list: count its spend now
      const it = openIteration(state);
      const open = openPhase(state);
      if (!it || !open || it.committed.includes(itemId)) return state;
      const item = state.items[itemId];
      if (!item || phaseOf(state, item) !== open.id) return state;
      const acc = state.accounting[state.accounting.length - 1];
      if (!acc || acc.item !== itemId) return state;
      return {
        ...state,
        iterations: state.iterations.map((x) =>
          x.id === it.id
            ? { ...x, committed: [...x.committed, itemId], spent: addSpent(x.spent, acc) }
            : x,
        ),
      };
    },
  };
}
