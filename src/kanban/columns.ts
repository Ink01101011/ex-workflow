import { fail } from "../errors.ts";
import { stageOf } from "../items.ts";
import type { ItemStatus, Stage, WorkItem, WorkflowState } from "../types.ts";

/** Statuses that hold a WIP slot. */
export const ACTIVE: ReadonlySet<ItemStatus> = new Set([
  "in_progress",
  "blocked",
  "awaiting_human",
]);
/** Every status but done and dropped: the cards on the board. */
export const OPEN: ReadonlySet<ItemStatus> = new Set([
  "todo",
  "in_progress",
  "blocked",
  "review",
  "awaiting_human",
]);

export function optionsColumn(state: WorkflowState): Stage {
  const first = state.stages[0];
  if (!first)
    fail(
      "config-invalid",
      "kanban board has no columns",
      "init with at least options, a commitment column and a delivery column",
    );
  return first;
}

export function commitmentColumn(state: WorkflowState): Stage {
  const st = state.stages.find((s) => s.commitmentPoint);
  if (!st)
    fail(
      "config-invalid",
      "no column is the commitment point",
      "set commitmentPoint: true on exactly one column",
    );
  return st;
}

export function deliveryColumn(state: WorkflowState): Stage {
  const st = state.stages.find((s) => s.deliveryPoint);
  if (!st)
    fail(
      "config-invalid",
      "no column is the delivery point",
      "set deliveryPoint: true on the last column",
    );
  return st;
}

export function columnIndex(state: WorkflowState, stageId: string): number {
  stageOf(state, stageId);
  return state.stages.findIndex((s) => s.id === stageId);
}

/** Committed and not yet delivered: column index in [commitment, delivery). */
export function onBoard(state: WorkflowState, item: WorkItem): boolean {
  const idx = columnIndex(state, item.stage);
  return (
    idx >= columnIndex(state, commitmentColumn(state).id) &&
    idx < columnIndex(state, deliveryColumn(state).id)
  );
}

export function activeExpedites(state: WorkflowState): string[] {
  return Object.values(state.items)
    .filter((i) => i.classOfService === "expedite" && ACTIVE.has(i.status) && onBoard(state, i))
    .map((i) => i.id);
}

/** ISO time the item last entered its current column; undefined when it was added there and never moved. */
export function enteredStageAt(item: WorkItem): string | undefined {
  for (let i = item.transitions.length - 1; i >= 0; i--) {
    const t = item.transitions[i]!;
    if (t.to.stage === item.stage && t.from.stage !== item.stage) return t.at;
  }
  return undefined;
}
