import type { WorkflowState } from "../types.ts";
import { configOf } from "./config.ts";
import { traceabilityMatrix } from "./traceability.ts";

export interface WaterfallMetrics {
  phaseCompletion: Record<string, number>;
  budgetPlanned: Record<string, number>;
  budgetSpent: Record<string, number>;
  scheduleVariance: Record<string, number>;
  requirementCoverage: number;
  requirementsTraced: number;
  requirementsTotal: number;
  defectsPerPhase: Record<string, number>;
  changeRequests: number;
  changesApproved: number;
  changesRejected: number;
  changeApprovalRate: number;
  reworkWeight: number;
  phasesReopened: number;
}

type Added = { id: string; type: string; phase: string | null; parent: string | null };

/** Phase metrics: membership and spend replayed from events (item.added, item.completed); requirement coverage read live from the traceability matrix. */
export function waterfallMetrics(state: WorkflowState): WaterfallMetrics {
  const phases = configOf(state).phases.map((p) => p.id);
  const zero = () => Object.fromEntries(phases.map((p) => [p, 0])) as Record<string, number>;
  const total = zero();
  const done = zero();
  const planned = zero();
  const spent = zero();
  const defects = zero();
  const phaseOf = new Map<string, string | undefined>();
  const typeOf = new Map<string, string>();
  const status = new Map<string, string>();
  let changeRequests = 0;
  let approved = 0;
  let rejected = 0;
  let reworkWeight = 0;
  let phasesReopened = 0;
  const counted = (id: string) => {
    const t = typeOf.get(id);
    const p = phaseOf.get(id);
    return t !== "question" && t !== "change-request" && p !== undefined && p in total;
  };
  for (const ev of state.events) {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    switch (ev.type) {
      case "item.added": {
        const a = p as Added;
        const phase = a.phase ?? (a.parent !== null ? phaseOf.get(a.parent) : undefined);
        phaseOf.set(a.id, phase);
        typeOf.set(a.id, a.type);
        status.set(a.id, "todo");
        if (a.type === "change-request") changeRequests += 1;
        if (counted(a.id)) {
          total[phase!]! += 1;
          if (a.type === "bug") defects[phase!]! += 1;
        }
        break;
      }
      case "item.transition": {
        const id = p["id"] as string;
        const to = (p["to"] as { status: string }).status;
        const was = status.get(id);
        status.set(id, to);
        if (!counted(id)) break;
        const phase = phaseOf.get(id)!;
        if (to === "done" && was !== "done") done[phase]! += 1;
        if (to === "dropped") {
          total[phase]! -= 1;
          if (was === "done") done[phase]! -= 1;
        }
        break;
      }
      case "item.completed": {
        const phase = phaseOf.get(p["id"] as string);
        if (phase !== undefined && phase in spent) spent[phase]! += (p["tokens"] as number) ?? 0;
        break;
      }
      case "phase.opened": {
        const phase = p["phase"] as string;
        if (phase in planned)
          planned[phase] = ((p["budget"] as { tokens?: number }) ?? {}).tokens ?? 0;
        break;
      }
      case "change.decided": {
        if (p["decision"] === "approve") {
          approved += 1;
          reworkWeight += (p["weight"] as number) ?? 0;
          phasesReopened += ((p["reopened"] as string[]) ?? []).length;
        } else rejected += 1;
        break;
      }
      default:
        break;
    }
  }
  const completion = zero();
  const variance = zero();
  for (const ph of phases) {
    const n = total[ph] ?? 0;
    completion[ph] = n === 0 ? 0 : ((done[ph] ?? 0) / n) * 100;
    variance[ph] = spent[ph]! - planned[ph]!;
  }
  const { traced, total: reqTotal } = traceabilityMatrix(state).coverage;
  const decided = approved + rejected;
  return {
    phaseCompletion: completion,
    budgetPlanned: planned,
    budgetSpent: spent,
    scheduleVariance: variance,
    requirementCoverage: reqTotal === 0 ? 0 : traced / reqTotal,
    requirementsTraced: traced,
    requirementsTotal: reqTotal,
    defectsPerPhase: defects,
    changeRequests,
    changesApproved: approved,
    changesRejected: rejected,
    changeApprovalRate: decided === 0 ? 0 : approved / decided,
    reworkWeight,
    phasesReopened,
  };
}
