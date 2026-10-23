import { getItem, moveItem } from "../items.ts";
import { appendEvent } from "../state.ts";
import type { WorkflowState } from "../types.ts";
import { reopenPhases } from "./baseline.ts";
import { DONE } from "./phases.ts";

export function approveChange(
  state: WorkflowState,
  changeId: string,
  by: string,
  note: string,
  now: string,
): WorkflowState {
  const cr = getItem(state, changeId);
  const ia = cr.impactAnalysis;
  const r = reopenPhases(state, ia?.reopen ?? [], now);
  let s = moveItem(r.state, changeId, { stage: DONE, status: "done" }, by, now);
  for (const phase of r.reopened)
    s = appendEvent(s, "phase.reopened", by, { phase, change: changeId }, now);
  if (r.suspended !== null)
    s = appendEvent(s, "phase.suspended", by, { phase: r.suspended, change: changeId }, now);
  return appendEvent(
    s,
    "change.decided",
    by,
    {
      change: changeId,
      decision: "approve",
      by,
      note,
      reopened: r.reopened,
      suspended: r.suspended,
      weight: ia?.weight ?? 0,
      affects: cr.affects ?? [],
    },
    now,
  );
}

export function rejectChange(
  state: WorkflowState,
  changeId: string,
  by: string,
  note: string,
  now: string,
): WorkflowState {
  const cr = getItem(state, changeId);
  const s = moveItem(state, changeId, { status: "dropped" }, by, now);
  return appendEvent(
    s,
    "change.decided",
    by,
    {
      change: changeId,
      decision: "reject",
      by,
      note,
      reopened: [],
      suspended: null,
      weight: 0,
      affects: cr.affects ?? [],
    },
    now,
  );
}
