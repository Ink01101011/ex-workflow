import { timSort } from "exsorted";
import type { WorkflowState } from "../types.ts";
import { addedAt, cardAge } from "./board.ts";
import { ACTIVE, OPEN, activeExpedites, commitmentColumn, onBoard } from "./columns.ts";
import { configOf } from "./config.ts";
import { columnStays, kanbanMetrics, percentile } from "./metrics.ts";

export interface OpsReport {
  blockers: Array<{ item: string; blocker: string; owner: string; reason: string; ageMs: number }>;
  agingWip: Array<{
    item: string;
    column: string;
    status: string;
    ageMs: number;
    p85Ms: number | null;
    overP85: boolean;
  }>;
  queued: Record<string, number>;
  active: Record<string, number>;
}

export function opsReport(state: WorkflowState, now: string): OpsReport {
  const t = Date.parse(now);
  const stays = columnStays(state);
  const blockers: OpsReport["blockers"] = [];
  const aging: OpsReport["agingWip"] = [];
  const queued: Record<string, number> = Object.fromEntries(state.stages.map((s) => [s.id, 0]));
  const active: Record<string, number> = Object.fromEntries(state.stages.map((s) => [s.id, 0]));
  for (const it of Object.values(state.items)) {
    for (const b of it.blockers)
      if (!b.clearedAt)
        blockers.push({
          item: it.id,
          blocker: b.id,
          owner: b.owner,
          reason: b.reason,
          ageMs: t - Date.parse(b.raisedAt),
        });
    if (ACTIVE.has(it.status)) active[it.stage] = (active[it.stage] ?? 0) + 1;
    else if (it.status === "todo" || it.status === "review")
      queued[it.stage] = (queued[it.stage] ?? 0) + 1;
    if (OPEN.has(it.status) && onBoard(state, it)) {
      const history = stays[it.stage] ?? [];
      const p85Ms = history.length ? percentile(history, 85) : null;
      const ageMs = cardAge(state, it, now);
      aging.push({
        item: it.id,
        column: it.stage,
        status: it.status,
        ageMs,
        p85Ms,
        overP85: p85Ms !== null && ageMs > p85Ms,
      });
    }
  }
  return {
    blockers,
    agingWip: timSort(aging, (a, b) => b.ageMs - a.ageMs || (a.item < b.item ? -1 : 1)),
    queued,
    active,
  };
}

export interface RiskReport {
  fixedDate: Array<{
    item: string;
    deadline: string;
    timeLeftMs: number;
    projectedRemainingMs: number | null;
    atRisk: boolean;
  }>;
  staleBlockers: Array<{ item: string; blocker: string; owner: string; ageMs: number }>;
  expediteActive: string[];
}

/** Time the item entered the commitment column (its first transition there), else when it was added. */
function committedAt(state: WorkflowState, id: string): string {
  const commit = commitmentColumn(state).id;
  const it = state.items[id]!;
  const t = it.transitions.find((x) => x.to.stage === commit && x.from.stage !== commit);
  return t?.at ?? addedAt(state, id);
}

export function riskReport(state: WorkflowState, now: string, staleAfterMs: number): RiskReport {
  const t = Date.parse(now);
  const cfg = configOf(state);
  const lead = kanbanMetrics(state).leadTimeMs;
  const p = cfg.classesOfService["fixed-date"]?.sle?.percentile ?? 85;
  const pLead = lead.length ? percentile(lead, p) : null;
  const fixedDate: RiskReport["fixedDate"] = [];
  const staleBlockers: RiskReport["staleBlockers"] = [];
  for (const it of Object.values(state.items)) {
    for (const b of it.blockers) {
      const ageMs = b.clearedAt ? 0 : t - Date.parse(b.raisedAt);
      if (!b.clearedAt && ageMs > staleAfterMs)
        staleBlockers.push({ item: it.id, blocker: b.id, owner: b.owner, ageMs });
    }
    if (
      it.classOfService !== "fixed-date" ||
      !it.deadline ||
      !OPEN.has(it.status) ||
      !onBoard(state, it)
    )
      continue;
    const elapsed = t - Date.parse(committedAt(state, it.id));
    const projectedRemainingMs = pLead === null ? null : Math.max(0, pLead - elapsed);
    const timeLeftMs = Date.parse(it.deadline) - t;
    fixedDate.push({
      item: it.id,
      deadline: it.deadline,
      timeLeftMs,
      projectedRemainingMs,
      atRisk:
        timeLeftMs < 0 || (projectedRemainingMs !== null && projectedRemainingMs > timeLeftMs),
    });
  }
  return { fixedDate, staleBlockers, expediteActive: activeExpedites(state) };
}
