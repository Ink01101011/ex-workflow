import { fail } from "../errors.ts";
import { openIteration } from "../planner.ts";
import { appendEvent } from "../state.ts";
import type { Baseline, WorkItem, WorkflowState } from "../types.ts";
import { getPhase, itemsInPhase, phaseIndex, phasesOf, withPhases } from "./phases.ts";

function closeIteration(
  state: WorkflowState,
  prefix: string,
  outcome: "completed" | "cancelled",
  now: string,
): WorkflowState {
  const it = openIteration(state);
  if (!it || !it.id.startsWith(`${prefix}#`)) return state;
  return {
    ...state,
    iterations: state.iterations.map((x) => (x.id === it.id ? { ...x, endedAt: now, outcome } : x)),
  };
}

/** Pass the phase gate: freeze its items, record the baseline, close its iteration. */
export function baselinePhase(
  state: WorkflowState,
  phaseId: string,
  approvedBy: string[],
  now: string,
): WorkflowState {
  const phase = getPhase(state, phaseId);
  if (phase.status !== "open")
    fail(
      "invalid-transition",
      `phase "${phaseId}" is ${phase.status}, not open`,
      phase.status === "baselined"
        ? "it is already baselined; a change-request reopens it"
        : "kickoff the phase first",
    );
  const items = itemsInPhase(state, phaseId);
  const itemSnapshot: Record<string, WorkItem> = {};
  for (const it of items) itemSnapshot[it.id] = it;
  const earlier = (state.baselines ?? []).filter((b) => b.phase === phaseId).length;
  const baseline: Baseline = {
    phase: phaseId,
    version: earlier + 1,
    at: now,
    approvedBy,
    itemSnapshot,
  };
  let s = withPhases(
    state,
    phasesOf(state).map((p) => (p.id === phaseId ? { ...p, status: "baselined" as const } : p)),
  );
  s = { ...s, baseline, baselines: [...(s.baselines ?? []), baseline] };
  s = closeIteration(s, phaseId, "completed", now);
  return appendEvent(
    s,
    "phase.baselined",
    approvedBy[approvedBy.length - 1] ?? "system",
    { phase: phaseId, version: baseline.version, approvedBy, items: items.map((i) => i.id) },
    now,
  );
}

export interface ReopenResult {
  state: WorkflowState;
  reopened: string[];
  suspended: string | null;
}

/** Change-control approval: reopen the listed baselined phases; a later open phase is suspended until they are re-baselined. */
export function reopenPhases(state: WorkflowState, ids: string[], now: string): ReopenResult {
  const reopened: string[] = [];
  for (const id of ids) {
    const p = getPhase(state, id);
    if (p.status === "pending")
      fail(
        "invalid-input",
        `phase "${id}" was never baselined; there is nothing to reopen`,
        "remove it from impactAnalysis.reopen",
      );
    if (p.status === "baselined" && !reopened.includes(id)) reopened.push(id);
  }
  let phases = phasesOf(state).map((p) =>
    reopened.includes(p.id) ? { ...p, status: "reopened" as const } : p,
  );
  let suspended: string | null = null;
  let s = state;
  if (reopened.length) {
    const earliest = Math.min(...reopened.map((id) => phaseIndex(state, id)));
    const open = phases.find((p, i) => p.status === "open" && i > earliest);
    if (open) {
      suspended = open.id;
      phases = phases.map((p) => (p.id === open.id ? { ...p, status: "reopened" as const } : p));
      s = closeIteration(s, open.id, "cancelled", now);
    }
  }
  return { state: withPhases(s, phases), reopened, suspended };
}
