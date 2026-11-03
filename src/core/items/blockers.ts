import { fail } from "../errors.ts";
import { appendEvent, nowOf } from "../state.ts";
import type { ItemStatus, Transition, WorkItem, WorkflowState } from "../types.ts";
import { stageOf } from "./stage.ts";
import { getItem, putItem } from "./record.ts";

export function raiseBlocker(
  state: WorkflowState,
  id: string,
  reason: string,
  owner: string,
  by: string,
  now?: string,
): WorkflowState {
  const item = getItem(state, id);
  const at = nowOf(now);
  const blockerId = `${id}-b${item.blockers.length + 1}`;
  const t: Transition | null =
    item.status === "blocked"
      ? null
      : {
          from: { stage: item.stage, status: item.status },
          to: { stage: item.stage, status: "blocked" },
          at,
          by,
        };
  const updated: WorkItem = {
    ...item,
    status: "blocked",
    blockers: [...item.blockers, { id: blockerId, reason, owner, raisedAt: at }],
    transitions: t ? [...item.transitions, t] : item.transitions,
  };
  const next = putItem(state, updated);
  return appendEvent(
    next,
    "blocker.raised",
    by,
    { id, blocker: blockerId, reason, owner, transition: t && { from: t.from, to: t.to } },
    at,
  );
}

function lastTransitionTo(item: WorkItem, status: ItemStatus): Transition | undefined {
  for (let i = item.transitions.length - 1; i >= 0; i--) {
    const t = item.transitions[i]!;
    if (t.to.status === status) return t;
  }
  return undefined;
}

export function clearBlocker(
  state: WorkflowState,
  id: string,
  blockerId: string,
  by: string,
  now?: string,
  note?: string,
): WorkflowState {
  const item = getItem(state, id);
  const idx = item.blockers.findIndex((b) => b.id === blockerId && !b.clearedAt);
  if (idx < 0)
    fail(
      "invalid-input",
      `item "${id}" has no open blocker "${blockerId}"`,
      `open blockers: ${
        item.blockers
          .filter((b) => !b.clearedAt)
          .map((b) => b.id)
          .join(", ") || "(none)"
      }`,
      { items: [id] },
    );
  const at = nowOf(now);
  const blockers = item.blockers.map((b, i) => (i === idx ? { ...b, clearedAt: at } : b));
  const stillBlocked = blockers.some((b) => !b.clearedAt);
  const prev = lastTransitionTo(item, "blocked")?.from.status ?? "todo";
  let toStage = item.stage;
  let toStatus: ItemStatus = prev;
  let dropRole = false;
  if (prev === "in_progress") {
    toStatus = "todo";
    toStage = lastTransitionTo(item, "in_progress")?.from.stage ?? item.stage;
  } else if (prev === "awaiting_human") {
    // a rejected human gate: the work is re-dispatched in the current stage
    toStatus = stageOf(state, item.stage).review ? "review" : "todo";
    dropRole = true;
  }
  const { role: _r, ...noRole } = item;
  const t: Transition | null = stillBlocked
    ? null
    : {
        from: { stage: item.stage, status: "blocked" },
        to: { stage: toStage, status: toStatus },
        at,
        by,
      };
  const updated: WorkItem = {
    ...(dropRole && !stillBlocked ? (noRole as WorkItem) : item),
    blockers,
    stage: stillBlocked ? item.stage : toStage,
    status: stillBlocked ? "blocked" : toStatus,
    transitions: t ? [...item.transitions, t] : item.transitions,
  };
  const next = putItem(state, updated);
  return appendEvent(
    next,
    "blocker.cleared",
    by,
    { id, blocker: blockerId, transition: t && { from: t.from, to: t.to }, note: note ?? null },
    at,
  );
}
