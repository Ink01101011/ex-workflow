import { assertId } from "../core/errors.ts";
import type { ExperimentationState } from "../core/records/experimentation.ts";
import type { InvestigationState } from "../core/records/investigation.ts";
import type { WorkflowState } from "../core/types.ts";

/**
 * Extension records that 1.1 stored as top-level state fields. Writing one also writes its
 * deprecated legacy mirror (`state.investigation`, `state.experimentation`); 2.0 drops the mirror.
 */
export interface LegacyExtRecords {
  investigation: InvestigationState;
  experimentation: ExperimentationState;
}
type LegacyKey = keyof LegacyExtRecords;
const isLegacy = (key: string): key is LegacyKey =>
  key === "investigation" || key === "experimentation";

/**
 * Reads the extension record `key` (a methodology name or a common piece id) from `state.ext`.
 * A state written before 1.2 has no `ext`; for `investigation` and `experimentation` the legacy
 * top-level field is read instead.
 */
export function readExt<K extends LegacyKey>(
  state: WorkflowState<string>,
  key: K,
): LegacyExtRecords[K] | undefined;
export function readExt<T = unknown>(state: WorkflowState<string>, key: string): T | undefined;
export function readExt(state: WorkflowState<string>, key: string): unknown {
  assertId(key, "ext key");
  if (state.ext && Object.hasOwn(state.ext, key)) return state.ext[key];
  return isLegacy(key) ? state[key] : undefined;
}

/**
 * Returns a copy of `state` with `state.ext[key] = value`; `undefined` removes the key. For
 * `investigation` and `experimentation` the legacy top-level field is written (or removed) too,
 * so SDK code reading `state.investigation` / `state.experimentation` sees the same record
 * (dual-write, spec 26). The mirror is read-only: once `ext.<key>` exists, `readExt` ignores the
 * legacy field. It does not make the state loadable by 1.1.x, whose schema rejects `ext`.
 */
export function writeExt<N extends string, K extends LegacyKey>(
  state: WorkflowState<N>,
  key: K,
  value: LegacyExtRecords[K] | undefined,
): WorkflowState<N>;
export function writeExt<N extends string, T>(
  state: WorkflowState<N>,
  key: string,
  value: T | undefined,
): WorkflowState<N>;
export function writeExt<N extends string>(
  state: WorkflowState<N>,
  key: string,
  value: unknown,
): WorkflowState<N> {
  assertId(key, "ext key");
  const ext: Record<string, unknown> = { ...state.ext };
  const out: Record<string, unknown> = { ...state, ext };
  for (const target of isLegacy(key) ? [ext, out] : [ext]) {
    if (value === undefined) delete target[key];
    else target[key] = value;
  }
  return out as unknown as WorkflowState<N>;
}
