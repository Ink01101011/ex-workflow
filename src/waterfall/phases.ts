import { fail } from "../errors.ts";
import type { Phase, WorkItem, WorkflowState } from "../types.ts";
import { configOf } from "./config.ts";

export const WORK = "work";
export const REVIEW = "review";
export const DONE = "done";

/** state.phases, or the config phases as pending (before the first ceremony touches them). */
export function phasesOf(state: WorkflowState): Phase[] {
  if (state.phases) return state.phases;
  return configOf(state).phases.map((p) => {
    const ph: Phase = {
      id: p.id,
      name: p.name,
      deliverables: [...p.deliverables],
      gate: p.gate,
      status: "pending",
    };
    if (p.budget) ph.budget = p.budget;
    return ph;
  });
}

export function withPhases(state: WorkflowState, phases: Phase[]): WorkflowState {
  return { ...state, phases };
}

export function phaseIndex(state: WorkflowState, id: string): number {
  const idx = phasesOf(state).findIndex((p) => p.id === id);
  if (idx < 0)
    fail(
      "config-invalid",
      `unknown phase "${id}"`,
      `phases are: ${phasesOf(state)
        .map((p) => p.id)
        .join(" → ")}`,
    );
  return idx;
}

export function getPhase(state: WorkflowState, id: string): Phase {
  return phasesOf(state)[phaseIndex(state, id)]!;
}

/** The item's phase, inherited from its parent chain (questions, follow-ups, retro items). */
export function phaseOf(state: WorkflowState, item: WorkItem): string | undefined {
  const seen = new Set<string>();
  let cur: WorkItem | undefined = item;
  while (cur && !seen.has(cur.id)) {
    if (cur.phase !== undefined) return cur.phase;
    seen.add(cur.id);
    cur =
      cur.parent !== undefined && Object.hasOwn(state.items, cur.parent)
        ? state.items[cur.parent]
        : undefined;
  }
  return undefined;
}

export function itemsInPhase(state: WorkflowState, phaseId: string): WorkItem[] {
  return Object.values(state.items).filter(
    (i) => i.status !== "dropped" && phaseOf(state, i) === phaseId,
  );
}

export function openPhase(state: WorkflowState): Phase | undefined {
  return phasesOf(state).find((p) => p.status === "open");
}

/** First phase in order that is not baselined: the one to kick off (or the open one). */
export function currentPhase(state: WorkflowState): Phase | undefined {
  return phasesOf(state).find((p) => p.status !== "baselined");
}

export function isFrozen(state: WorkflowState, item: WorkItem): boolean {
  const id = phaseOf(state, item);
  return id !== undefined && phasesOf(state).find((p) => p.id === id)?.status === "baselined";
}

export function producedKinds(state: WorkflowState, phase: Phase): Set<string> {
  const kinds = new Set<string>((phase.produced ?? []).map((p) => p.kind));
  for (const it of itemsInPhase(state, phase.id)) for (const e of it.evidence) kinds.add(e.kind);
  return kinds;
}

/** Deliverables (and gate evidence kinds) still missing, in declaration order. */
export function missingDeliverables(
  state: WorkflowState,
  phase: Phase,
  extra: string[] = [],
): string[] {
  const have = producedKinds(state, phase);
  for (const k of extra) have.add(k);
  const wanted: string[] = [];
  for (const k of [...phase.deliverables, ...phase.gate.evidence])
    if (!wanted.includes(k)) wanted.push(k);
  return wanted.filter((k) => !have.has(k));
}

/** The traceability `to` phase that comes last in phase order (where the matrix must be complete). */
export function lastToPhase(state: WorkflowState): string | undefined {
  const order = phasesOf(state).map((p) => p.id);
  const to = configOf(state).traceability.to.filter((t) => order.includes(t));
  if (to.length === 0) return undefined;
  return to.reduce((a, b) => (order.indexOf(a) >= order.indexOf(b) ? a : b));
}
