import type { Gate, GateEscalation, WorkflowState } from "./types.ts";

const str = (x: unknown): string | false => typeof x === "string" && x;

/**
 * `base` followed by the entries of `extra` not yet present. The identity of a requirement
 * (`req`) is 1 for "human", else the capability it names when that is a non-empty string; of an
 * evidence kind, the non-empty string itself. A malformed entry has no identity and is skipped.
 */
function add<T>(base: readonly T[], extra: unknown, req?: 1): T[] {
  const key = (q: unknown): unknown =>
    req
      ? q === "human"
        ? 1
        : str((q as { capability?: unknown } | null | undefined)?.capability)
      : str(q);
  const out = [...base];
  // a non-array counts as one entry
  for (const x of [extra].flat()) {
    const k = key(x);
    if (k && !out.some((o) => key(o) === k)) out.push(x as T);
  }
  return out;
}

/**
 * The static gate with the escalation's requirements and evidence kinds appended when not already
 * present (design spec section 27, #35). It never removes or replaces anything and skips malformed
 * entries, so for any hook output the widened gate is at least as strict as the static one.
 */
export function widenGate(
  gate: Gate,
  x: Pick<GateEscalation, "requires" | "evidence"> | undefined,
): Gate {
  return {
    ...gate,
    requires: add(gate.requires, x?.requires, 1),
    evidence: add(gate.evidence, x?.evidence),
  };
}

/**
 * `gate` widened by the `gate.resolved` event recorded with the pending whose `pending.raised`
 * event is `state.events[at]`: `complete()` appends it just before that event, with only the item's
 * own `item.transition` (to `awaiting_human`) in between. Anything else, a later resolution
 * included, does not apply; `at < 0` (no such event) gives the static gate.
 */
export function resolvedGate(
  state: WorkflowState<string>,
  id: string,
  gate: Gate,
  at: number,
): Gate {
  const p = (i: number) => state.events[i]?.payload as { id?: unknown; item?: unknown } | null;
  let i = at - 1;
  while (i >= 0 && state.events[i]!.type === "item.transition" && p(i)?.id === id) i--;
  const e = state.events[i];
  const x = e?.type === "gate.resolved" && p(i) ? (p(i) as { gate?: unknown }) : undefined;
  return widenGate(
    gate,
    x?.gate === gate.id && p(i)?.item === id ? (x as GateEscalation) : undefined,
  );
}
