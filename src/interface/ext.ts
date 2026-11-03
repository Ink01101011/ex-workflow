import { assertId } from "../core/errors.ts";
import type { ExperimentationState } from "../core/records/experimentation.ts";
import type { InvestigationState } from "../core/records/investigation.ts";
import type { WorkflowState } from "../core/types.ts";

/**
 * Extension records that 1.1 stored as top-level state fields. Writing one also writes its
 * deprecated legacy mirror (`state.investigation`, `state.experimentation`) in memory; on disk
 * only `ext` is stored (spec 26). 2.0 drops the mirror.
 */
export interface LegacyExtRecords {
  investigation: InvestigationState;
  experimentation: ExperimentationState;
}
type LegacyKey = keyof LegacyExtRecords;
const LEGACY_KEYS: readonly LegacyKey[] = ["investigation", "experimentation"];
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

/**
 * The state as the file adapter stores it: a legacy mirror whose `ext.<key>` exists is left out,
 * so the record is written once (spec 26, U10 F1). A legacy field without `ext.<key>` (a state
 * written before 1.2) is kept. Does not mutate `state`.
 */
export function withoutLegacyMirrors<S extends WorkflowState<string>>(state: S): S {
  const ext = state.ext;
  if (!ext) return state;
  const out = { ...state } as Record<string, unknown>;
  for (const key of LEGACY_KEYS) if (Object.hasOwn(ext, key)) delete out[key];
  return out as S;
}

/**
 * The reverse of `withoutLegacyMirrors` for a loaded state: each legacy field whose `ext.<key>`
 * exists is set to that record by reference, replacing whatever the file held there (`ext` wins
 * over a hand-edited legacy field). Does not mutate `state`.
 */
export function withLegacyMirrors<S extends WorkflowState<string>>(state: S): S {
  const ext = state.ext;
  if (!ext) return state;
  const out = { ...state } as Record<string, unknown>;
  for (const key of LEGACY_KEYS) if (Object.hasOwn(ext, key)) out[key] = ext[key];
  return out as S;
}
