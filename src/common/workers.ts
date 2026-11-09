// Who worked on an item (design spec section 27, F1 G1-1): the independence checks of the
// risk-adaptive gate and the context-grounded policy compare an assessor or a snapshot's recorder
// against every one of them, not only the last author.
import { authorOf } from "../core/authors.ts";
import type { WorkItem, WorkflowState } from "../core/types.ts";
import { eventIndex, sinceRework } from "../core/event-index.ts";

/**
 * The roles that worked on `item`: the `by` of each dispatch (a transition into `in_progress`)
 * since the item's last `item.rework` event (or since creation), in order, then its assigned
 * `role` and its author by the 1.3 rule (`authorOf`), each once. The rework boundary is found by
 * matching `item.transitions` to the events that appended them (`item.transition`, and the
 * `blocker.*` events that carry a `transition`) from the end; when those events are not exactly as
 * many as the transitions, every transition counts (fail closed: more workers, never fewer).
 */
export function workersOf(state: WorkflowState<string>, item: WorkItem): string[] {
  const index = eventIndex(state);
  const at = index.transitions.get(item.id) ?? [];
  const all = item.transitions;
  const after = sinceRework(index, item.id, at);
  const ts = after === undefined || at.length !== all.length ? all : all.slice(all.length - after);
  const out = new Set<string>();
  for (const t of ts) if (t.to.status === "in_progress") out.add(t.by);
  for (const w of [item.role, authorOf(state, item)]) if (w !== undefined) out.add(w);
  return [...out];
}
