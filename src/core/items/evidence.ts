import { appendEvent, nowOf } from "../state.ts";
import type { Evidence, WorkItem, WorkflowState } from "../types.ts";
import { getItem, putItem } from "./record.ts";

/** Evidence recorded at or after the item's last `item.rework` event; evidence stays stored, but earlier entries no longer count toward policies or gates. Never-reworked items keep all evidence. */
export function freshEvidence(state: WorkflowState<string>, item: WorkItem): Evidence[] {
  // Event order, not timestamps: evidence recorded by an item.evidence event AFTER the item's last
  // item.rework event is fresh. Evidence entries are appended in the same order as those events, so
  // the fresh entries are the last `after` ones. Evidence attached by the rework completion itself
  // precedes its item.rework event and therefore does not count.
  let after = 0;
  let found = false;
  for (let i = state.events.length - 1; i >= 0; i--) {
    const ev = state.events[i]!;
    if ((ev.payload as { id?: string } | null)?.id !== item.id) continue;
    if (ev.type === "item.rework") {
      found = true;
      break;
    }
    if (ev.type === "item.evidence") after++;
  }
  return found ? item.evidence.slice(Math.max(0, item.evidence.length - after)) : item.evidence;
}

export function addEvidence<N extends string>(
  state: WorkflowState<N>,
  id: string,
  evidence: Omit<Evidence, "at">,
  now?: string,
): WorkflowState<N> {
  const item = getItem(state, id);
  const at = nowOf(now);
  const updated: WorkItem = { ...item, evidence: [...item.evidence, { ...evidence, at }] };
  const next = putItem(state, updated);
  return appendEvent(
    next,
    "item.evidence",
    evidence.by,
    { id, kind: evidence.kind, ref: evidence.ref },
    at,
  );
}
