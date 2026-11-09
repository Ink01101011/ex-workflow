// A per-log index of the events the 1.3 policies and the 1.4 conflict-of-interest check read (design
// spec section 27, F1 G3-2..G3-5; section 28, #48; moved from src/common so core can use it):
// built in one pass over `state.events` and cached per events array, so reading the context or the
// workers of many items of one state costs one pass, not one per item. Pure and deterministic: the
// cache only avoids recomputing what the same array gives; an array changed in place (its length or
// its last event differs) is indexed again.
import type { WorkflowState } from "./types.ts";

export interface EventIndex {
  /** Item id -> positions of its `item.evidence` events, ascending. */
  evidence: Map<unknown, number[]>;
  /**
   * Item id -> positions of the events that appended a transition to the item, ascending: its
   * `item.transition` events and the `blocker.raised` / `blocker.cleared` events whose payload
   * carries a non-null `transition` (spec 27, F2 G5-1). `workersOf` uses them only when they are
   * exactly as many as `item.transitions`.
   */
  transitions: Map<unknown, number[]>;
  /** Item id -> position of its last `item.rework` event. */
  rework: Map<unknown, number>;
  /** Path -> `[position, index in the event's paths]` of each listing in a `repo.changed`, ascending. */
  changed: Map<string, [number, number][]>;
}

const cache = new WeakMap<object, { n: number; last: unknown; index: EventIndex }>();

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

function build(events: WorkflowState<string>["events"]): EventIndex {
  const index: EventIndex = {
    evidence: new Map(),
    transitions: new Map(),
    rework: new Map(),
    changed: new Map(),
  };
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]!;
    const p = ev.payload as { id?: unknown; paths?: unknown; transition?: unknown } | null;
    if (ev.type === "item.evidence") push(index.evidence, p?.id, i);
    else if (ev.type === "item.transition" || p?.transition) push(index.transitions, p?.id, i);
    else if (ev.type === "item.rework") index.rework.set(p?.id, i);
    else if (ev.type === "repo.changed" && Array.isArray(p?.paths)) {
      // a path listed twice in one event keeps both entries; readers take the first after a position
      const paths: unknown[] = p.paths;
      for (let j = 0; j < paths.length; j++)
        if (typeof paths[j] === "string") push(index.changed, paths[j] as string, [i, j]);
    }
  }
  return index;
}

/** The index of `state.events`, built once per events array. */
export function eventIndex(state: WorkflowState<string>): EventIndex {
  const events = state.events;
  const n = events.length;
  const hit = cache.get(events);
  if (hit && hit.n === n && hit.last === events[n - 1]) return hit.index;
  const index = build(events);
  cache.set(events, { n, last: events[n - 1], index });
  return index;
}

/** The first index `k` of the ascending `xs` with `at(xs[k]) > p`, or `xs.length`. */
export function firstAfter<T>(xs: readonly T[], p: number, at: (x: T) => number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (at(xs[mid]!) > p) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * How many of the item's events listed in `positions` (ascending) follow its last `item.rework`
 * event, or `undefined` when it was never reworked: the count `freshEvidence` derives by scanning.
 */
export function sinceRework(
  index: EventIndex,
  id: string,
  positions: readonly number[] | undefined,
): number | undefined {
  const rw = index.rework.get(id);
  if (rw === undefined) return undefined;
  const list = positions ?? [];
  return list.length - firstAfter(list, rw, (x) => x);
}
