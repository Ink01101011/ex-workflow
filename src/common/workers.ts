// Who worked on an item (design spec section 27, F1 G1-1): the independence checks of the
// risk-adaptive gate and the context-grounded policy compare an assessor or a snapshot's recorder
// against every one of them, not only the last author.
import { authorOf } from "../core/gates.ts";
import type { WorkItem, WorkflowState } from "../core/types.ts";
import { eventIndex, sinceRework } from "./event-index.ts";

/**
 * The roles that worked on `item`: the `by` of each dispatch (a transition into `in_progress`)
 * since the item's last `item.rework` event (or since creation), in order, then its assigned
 * `role` and its author by the 1.3 rule (`authorOf`), each once. Transitions are matched to the
 * item's `item.transition` events from the end, as `freshEvidence` matches evidence.
 */
export function workersOf(state: WorkflowState<string>, item: WorkItem): string[] {
  const index = eventIndex(state);
  const after = sinceRework(index, item.id, index.transitions.get(item.id));
  const ts =
    after === undefined
      ? item.transitions
      : item.transitions.slice(Math.max(0, item.transitions.length - after));
  const out = new Set<string>();
  for (const t of ts) if (t.to.status === "in_progress") out.add(t.by);
  for (const w of [item.role, authorOf(state, item)]) if (w !== undefined) out.add(w);
  return [...out];
}
