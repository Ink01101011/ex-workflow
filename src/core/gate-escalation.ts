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

/** `gate` widened by the last `gate.resolved` event recorded for item `id` and this gate id. */
export function resolvedGate(state: WorkflowState<string>, id: string, gate: Gate): Gate {
  let last: GateEscalation | undefined;
  for (const e of state.events) {
    const p = e.payload as { item?: unknown; gate?: unknown } | null;
    if (e.type === "gate.resolved" && p?.item === id && p.gate === gate.id)
      last = p as GateEscalation;
  }
  return widenGate(gate, last);
}
