import { fail } from "../errors.ts";
import { appendEvent, nowOf } from "../state.ts";
import type { ItemStatus, WorkItem, WorkflowState } from "../types.ts";
import { isTerminalStage, nextStageOf, stageOf } from "./stage.ts";
import { getItem, patchItem, putItem } from "./record.ts";

export function moveItem<N extends string>(
  state: WorkflowState<N>,
  id: string,
  to: { stage?: string; status: ItemStatus },
  by: string,
  now?: string,
): WorkflowState<N>;
export function moveItem(
  state: WorkflowState,
  id: string,
  to: { stage?: string; status: ItemStatus },
  by: string,
  now?: string,
): WorkflowState;
export function moveItem<N extends string>(
  state: WorkflowState<N>,
  id: string,
  to: { stage?: string; status: ItemStatus },
  by: string,
  now?: string,
): WorkflowState<N> {
  const item = getItem(state, id);
  const toStage = to.stage ?? item.stage;
  stageOf(state, toStage);
  if (item.status === "done" || item.status === "dropped") {
    fail(
      "invalid-transition",
      `item "${id}" is ${item.status} and cannot move`,
      "create a new item (or a change-request) instead of reopening a finished one",
      { items: [id] },
    );
  }
  if (toStage === item.stage && to.status === item.status)
    fail(
      "no-op",
      `item "${id}" is already ${item.status} in "${toStage}"`,
      "choose a different stage or status",
      { items: [id] },
    );
  const at = nowOf(now);
  const updated: WorkItem = {
    ...item,
    stage: toStage,
    status: to.status,
    transitions: [
      ...item.transitions,
      {
        from: { stage: item.stage, status: item.status },
        to: { stage: toStage, status: to.status },
        at,
        by,
      },
    ],
  };
  const next = putItem(state, updated);
  return appendEvent(
    next,
    "item.transition",
    by,
    {
      id,
      from: { stage: item.stage, status: item.status },
      to: { stage: toStage, status: to.status },
    },
    at,
  );
}

/** Entering a new stage is a new assignment: the role that finished the previous stage is cleared so the planner picks the right one (a reviewer, not the author). */
export function clearRole<N extends string>(
  state: WorkflowState<N>,
  itemId: string,
): WorkflowState<N> {
  return stripItemFields(state, itemId, ["role"]);
}

/** Move an item to the next stage (done at the end, review/todo otherwise) and clear its role. */
export function advanceItem<N extends string>(
  state: WorkflowState<N>,
  itemId: string,
  by: string,
  wantsReview: boolean,
  now: string,
): WorkflowState<N> {
  const item = getItem(state, itemId);
  const to = nextStageOf(state, item.stage);
  if (!to) return moveItem(state, itemId, { status: "done" }, by, now);
  if (isTerminalStage(state, to.id))
    return moveItem(state, itemId, { stage: to.id, status: "done" }, by, now);
  const status = wantsReview || to.review === true ? "review" : "todo";
  return clearRole(moveItem(state, itemId, { stage: to.id, status }, by, now), itemId);
}

/** Drop optional fields (iteration, role, ...) from one item; no event. */
export function stripItemFields<N extends string>(
  state: WorkflowState<N>,
  id: string,
  keys: Array<"iteration" | "role">,
): WorkflowState<N> {
  return patchItem(state, id, (item) => {
    const copy = { ...item };
    for (const k of keys) delete copy[k];
    return copy;
  });
}
