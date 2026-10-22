import { timSort } from "exsorted";
import type { WorkflowState } from "../types.ts";
import { OPEN } from "./columns.ts";
import { configOf } from "./config.ts";
import { replay, type Replay } from "./replay.ts";

export interface KanbanMetrics {
  leadTimeMs: number[];
  leadTimeP50: number;
  leadTimeP85: number;
  cycleTimeMsByColumn: Record<string, number>;
  throughput: number[];
  wipByColumn: Record<string, number>;
  flowEfficiency: number;
  agingWipMs: Record<string, number>;
  cumulativeFlow: Record<string, number>;
  sleCompliance: Record<string, number>;
  blockerTimeMs: number;
  meanBlockerTimeMs: number;
}

/** Nearest-rank percentile; 0 for an empty list. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = timSort([...values], (a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1]!;
}

const ms = (from: string, to: string) => Date.parse(to) - Date.parse(from);
const ratio = (num: number, den: number) => (den === 0 ? 0 : num / den);

function boardOf(state: WorkflowState) {
  const commitment = state.stages.find((s) => s.commitmentPoint)?.id ?? "";
  const delivery = state.stages.find((s) => s.deliveryPoint)?.id ?? "";
  return {
    commitment,
    delivery,
    ci: state.stages.findIndex((s) => s.id === commitment),
    di: state.stages.findIndex((s) => s.id === delivery),
  };
}

function staysOf(r: Replay): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const it of r.items.values())
    for (const st of it.stays)
      if (st.leftAt !== undefined) (out[st.stage] ??= []).push(ms(st.enteredAt, st.leftAt));
  return out;
}

/** Completed stay durations per column. */
export function columnStays(state: WorkflowState): Record<string, number[]> {
  const b = boardOf(state);
  return staysOf(replay(state.events, b.commitment, b.delivery));
}

export function kanbanMetrics(state: WorkflowState): KanbanMetrics {
  const cfg = configOf(state);
  const b = boardOf(state);
  const r = replay(state.events, b.commitment, b.delivery);
  const items = [...r.items.values()];
  const columns = state.stages.map((s) => s.id);
  const index = new Map(columns.map((id, i) => [id, i] as const));

  // questions (escalations) are born on the board and answered, never delivered
  const delivered = timSort(
    items.filter(
      (i) => i.type !== "question" && i.committedAt !== undefined && i.deliveredAt !== undefined,
    ),
    (x, y) => Date.parse(x.deliveredAt!) - Date.parse(y.deliveredAt!),
  );
  const leadTimeMs = delivered.map((i) => ms(i.committedAt!, i.deliveredAt!));

  const cycleTimeMsByColumn: Record<string, number> = {};
  for (const [col, list] of Object.entries(staysOf(r)))
    cycleTimeMsByColumn[col] = list.reduce((s, x) => s + x, 0) / list.length;

  const commits = items
    .filter((i) => i.type !== "question" && i.committedAt !== undefined)
    .map((i) => Date.parse(i.committedAt!));
  let throughput: number[] = [];
  if (commits.length > 0) {
    const start = commits.reduce((lo, x) => (x < lo ? x : lo), commits[0]!);
    const n = Math.floor((Date.parse(r.lastAt) - start) / cfg.throughputWindowMs) + 1;
    throughput = Array.from({ length: n }, () => 0);
    for (const i of delivered) {
      const idx = Math.floor((Date.parse(i.deliveredAt!) - start) / cfg.throughputWindowMs);
      if (idx >= 0 && idx < n) throughput[idx]! += 1;
    }
  }

  const wipByColumn: Record<string, number> = Object.fromEntries(columns.map((c) => [c, 0]));
  const agingWipMs: Record<string, number> = {};
  for (const i of items) {
    if (!OPEN.has(i.status)) continue;
    if (Object.hasOwn(wipByColumn, i.stage)) wipByColumn[i.stage]! += 1;
    const idx = index.get(i.stage);
    if (idx !== undefined && idx >= b.ci && idx < b.di)
      agingWipMs[i.id] = ms(i.stays[i.stays.length - 1]!.enteredAt, r.lastAt);
  }

  const firstEntry = new Map<string, Map<string, string>>();
  for (const i of items)
    for (const st of i.stays) {
      const per = firstEntry.get(st.stage) ?? new Map<string, string>();
      if (!per.has(i.id)) per.set(i.id, st.enteredAt);
      firstEntry.set(st.stage, per);
    }
  const days = timSort([...new Set(state.events.map((e) => e.at.slice(0, 10)))], (x, y) =>
    x < y ? -1 : x > y ? 1 : 0,
  );
  const cumulativeFlow: Record<string, number> = {};
  for (const day of days)
    for (const col of columns)
      cumulativeFlow[`${day}:${col}`] = [...(firstEntry.get(col)?.values() ?? [])].filter(
        (at) => at.slice(0, 10) <= day,
      ).length;

  const sleCompliance: Record<string, number> = {};
  for (const [cls, entry] of Object.entries(cfg.classesOfService)) {
    if (!entry?.sle) continue;
    const mine = delivered.filter((i) => i.classOfService === cls);
    if (mine.length === 0) continue;
    sleCompliance[cls] =
      mine.filter((i) => ms(i.committedAt!, i.deliveredAt!) <= entry.sle!.targetMs).length /
      mine.length;
  }

  const blockerTimeMs = r.blockers.reduce((s, x) => s + ms(x.raisedAt, x.clearedAt ?? r.lastAt), 0);

  return {
    leadTimeMs,
    leadTimeP50: percentile(leadTimeMs, 50),
    leadTimeP85: percentile(leadTimeMs, 85),
    cycleTimeMsByColumn,
    throughput,
    wipByColumn,
    flowEfficiency: ratio(
      delivered.reduce((s, i) => s + i.activeMs, 0),
      leadTimeMs.reduce((s, x) => s + x, 0),
    ),
    agingWipMs,
    cumulativeFlow,
    sleCompliance,
    blockerTimeMs,
    meanBlockerTimeMs: ratio(blockerTimeMs, r.blockers.length),
  };
}
