// Who did the work a gate guards (design spec section 28, #48): `authorOf`, the 1.0 rule (the last
// dispatch from an earlier stage), and `authorsOf`, every such dispatch since the item's last
// rework, which the conflict-of-interest check of `checkGate` and the planner's reviewer choice use.
import { eventIndex, sinceRework } from "./event-index.ts";
import type { Transition, WorkItem, WorkflowState } from "./types.ts";

/** Last in_progress dispatch made from a stage that comes STRICTLY BEFORE the item's current stage in `state.stages` order (unknown stage ids count as not-before). */
export function lastDispatchBefore(
  state: WorkflowState<string>,
  item: WorkItem,
): Transition | undefined;
export function lastDispatchBefore(state: WorkflowState, item: WorkItem): Transition | undefined;
export function lastDispatchBefore(
  state: WorkflowState<string>,
  item: WorkItem,
): Transition | undefined {
  const order = new Map(state.stages.map((s, i) => [s.id, i] as const));
  const here = order.get(item.stage);
  if (here === undefined) return undefined;
  for (let i = item.transitions.length - 1; i >= 0; i--) {
    const t = item.transitions[i]!;
    const from = order.get(t.from.stage);
    if (t.to.status === "in_progress" && from !== undefined && from < here) return t;
  }
  return undefined;
}

/** Role that did the work the gate guards: the last dispatch made from a stage strictly before the current one (so a reviewer dispatched into the gated stage is not its author); else the last dispatch of any stage; undefined if never dispatched. */
export function authorOf(state: WorkflowState<string>, item: WorkItem): string | undefined;
export function authorOf(state: WorkflowState, item: WorkItem): string | undefined;
export function authorOf(state: WorkflowState<string>, item: WorkItem): string | undefined {
  const before = lastDispatchBefore(state, item);
  if (before) return before.by;
  for (let i = item.transitions.length - 1; i >= 0; i--) {
    const t = item.transitions[i]!;
    if (t.to.status === "in_progress") return t.by;
  }
  return undefined;
}

/**
 * Every role that did the work a gate on the item's current stage guards (design spec section 28,
 * #48): the `by` of each dispatch (a transition into `in_progress`) since the item's last
 * `item.rework` event whose `from.stage` comes strictly before the current stage in `state.stages`
 * order, in order, then `authorOf`, each once. A dispatch before that rework still counts when it
 * came from a stage before every stage the item has been in since (the rework did not send that
 * work back); a dispatch from a stage `state.stages` does not list, or any dispatch when the current
 * stage is unlisted, counts. A reviewer dispatched into the gated stage is not
 * one, nor is the assigned `role`. The rework boundary is found as `workersOf` finds it: when the
 * events that appended transitions are not exactly as many as `item.transitions`, every
 * transition counts (fail closed: more authors, never fewer).
 */
export function authorsOf(state: WorkflowState<string>, item: WorkItem): string[] {
  const order = new Map(state.stages.map((s, i) => [s.id, i] as const));
  const here = order.get(item.stage);
  const index = eventIndex(state);
  const at = index.transitions.get(item.id) ?? [];
  const all = item.transitions;
  const after = sinceRework(index, item.id, at);
  const ts = after === undefined || at.length !== all.length ? all : all.slice(all.length - after);
  const pre = all.slice(0, all.length - ts.length);
  const rank = (stage: string) => order.get(stage) ?? Infinity;
  // work before the rework that the rework did not send back is not redone: a pre-rework dispatch
  // from a stage before the earliest one the item reached since counts (spec 28, gate G1-2)
  // with the current stage unlisted, every pre-rework dispatch counts (fail closed, gate G3-4)
  let landing = here === undefined ? Infinity : pre.length ? rank(pre.at(-1)!.to.stage) : -Infinity;
  if (here !== undefined)
    for (const t of ts) landing = Math.min(landing, rank(t.from.stage), rank(t.to.stage));
  const out = new Set<string>();
  const limit = here ?? Infinity;
  // a dispatch from a stage state.stages does not list counts (fail closed, gate G1-5)
  const from = (t: Transition) => order.get(t.from.stage) ?? -Infinity;
  for (const t of pre)
    if (t.to.status === "in_progress" && from(t) < Math.min(limit, landing)) out.add(t.by);
  for (const t of ts) if (t.to.status === "in_progress" && from(t) < limit) out.add(t.by);
  const author = authorOf(state, item);
  if (author !== undefined) out.add(author);
  return [...out];
}
