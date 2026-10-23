import { timSort } from "exsorted";
import type { WorkItem, WorkflowState } from "../types.ts";
import { configOf } from "./config.ts";
import { itemsInPhase, phasesOf } from "./phases.ts";

export interface TraceRow {
  item: string;
  /** to-phase id → ids of linked items in that phase */
  links: Record<string, string[]>;
}
export interface TraceabilityMatrix {
  from: string;
  to: string[];
  rows: TraceRow[];
  missing: Array<{ item: string; phases: string[] }>;
  coverage: { traced: number; total: number };
}

const byId = (a: WorkItem, b: WorkItem) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const artefacts = (state: WorkflowState, phase: string) =>
  timSort(
    itemsInPhase(state, phase).filter((i) => i.type !== "question"),
    byId,
  );

/** A link exists when either side's `traces` names the other. */
const linked = (a: WorkItem, b: WorkItem) =>
  (a.traces ?? []).includes(b.id) || (b.traces ?? []).includes(a.id);

export function traceabilityMatrix(state: WorkflowState): TraceabilityMatrix {
  const cfg = configOf(state).traceability;
  const order = phasesOf(state).map((p) => p.id);
  const to = cfg.to.filter((t) => order.includes(t));
  const rows: TraceRow[] = artefacts(state, cfg.from).map((f) => {
    const links: Record<string, string[]> = {};
    for (const t of to)
      links[t] = artefacts(state, t)
        .filter((x) => linked(f, x))
        .map((x) => x.id);
    return { item: f.id, links };
  });
  const missing = rows
    .map((r) => ({ item: r.item, phases: to.filter((t) => r.links[t]!.length === 0) }))
    .filter((m) => m.phases.length > 0);
  return {
    from: cfg.from,
    to,
    rows,
    missing,
    coverage: { traced: rows.length - missing.length, total: rows.length },
  };
}

/** Ids of `from` items with no link into `toPhase`. */
export function missingTraces(state: WorkflowState, toPhase: string): string[] {
  return traceabilityMatrix(state)
    .rows.filter((r) => (r.links[toPhase] ?? []).length === 0)
    .map((r) => r.item);
}
