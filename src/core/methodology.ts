import { fail } from "./errors.ts";
import { requireCapabilities } from "./roles/guards.ts";
import { coreRulesFor } from "./rules.ts";
import { openIteration } from "./planner.ts";
import { appendEvent, createState, nowOf } from "./state.ts";
import type {
  Action,
  ApplyResult,
  Methodology,
  MethodologyName,
  Role,
  Stage,
  Violation,
  WorkflowState,
} from "./types.ts";

export function validateAction<N extends string>(
  state: WorkflowState<N>,
  methodology: Methodology<unknown, N>,
  action: Action,
): Violation[];
export function validateAction(
  state: WorkflowState,
  methodology: Methodology,
  action: Action,
): Violation[];
export function validateAction<N extends string>(
  state: WorkflowState<N>,
  methodology: Methodology<unknown, N>,
  action: Action,
): Violation[] {
  const out: Violation[] = [];
  for (const rule of [...coreRulesFor<N>(methodology), ...methodology.rules])
    out.push(...rule.check(state, action));
  return out;
}

export function applyAction<N extends string>(
  state: WorkflowState<N>,
  methodology: Methodology<unknown, N>,
  action: Action,
  reduce: (s: WorkflowState<N>) => WorkflowState<N>,
): ApplyResult<N>;
export function applyAction(
  state: WorkflowState,
  methodology: Methodology,
  action: Action,
  reduce: (s: WorkflowState) => WorkflowState,
): ApplyResult;
export function applyAction<N extends string>(
  state: WorkflowState<N>,
  methodology: Methodology<unknown, N>,
  action: Action,
  reduce: (s: WorkflowState<N>) => WorkflowState<N>,
): ApplyResult<N> {
  const violations = validateAction(state, methodology, action);
  const errors = violations.filter((v) => v.severity === "error");
  if (errors.length) {
    fail(
      "rule-violation",
      `${action.type} violates ${errors.map((e) => e.rule).join(", ")}: ${errors.map((e) => e.message).join("; ")}`,
      errors.map((e) => e.fix).join("; "),
      { rule: errors[0]!.rule, items: errors.map((e) => e.item).filter((x): x is string => !!x) },
    );
  }
  return { state: reduce(state), warnings: violations.filter((v) => v.severity === "warning") };
}

export interface InitInput<C, N extends string = MethodologyName> {
  methodology: Methodology<C, N>;
  config: unknown;
  roles?: Role[];
  stages?: Stage[];
  by?: string;
  now?: string;
}

// The first overload is the 1.1 signature; a custom methodology name resolves to the second. The
// 1.1 signature is repeated last so Parameters<typeof init> / ReturnType read the 1.1 shape.
export function init<C>(input: InitInput<C>): ApplyResult;
export function init<C, N extends string>(input: InitInput<C, N>): ApplyResult<N>;
export function init<C>(input: InitInput<C>): ApplyResult;
export function init<C, N extends string>(input: InitInput<C, N>): ApplyResult<N> {
  const m = input.methodology;
  const config = m.validateConfig(input.config);
  const stages = input.stages ?? m.defaultStages(config);
  const roles = input.roles ?? m.defaultRoles(config);
  const stateInput =
    input.now !== undefined
      ? { methodology: m.name, config, stages, roles, now: input.now }
      : { methodology: m.name, config, stages, roles };
  const state = createState(stateInput);
  requireCapabilities(state, m.requiredCapabilities, m.exclusiveCapabilities);
  return applyAction(
    state,
    m as Methodology<unknown, N>,
    { type: "init", by: input.by ?? "system" },
    (s) => s,
  );
}

/** Change the config between iterations: re-validated, recorded as config.changed, derived state kept in step by the methodology hook. */
export function changeConfig<N extends string>(
  state: WorkflowState<N>,
  methodology: Methodology<unknown, N>,
  patch: Record<string, unknown>,
  by: string,
  now?: string,
): ApplyResult<N>;
export function changeConfig(
  state: WorkflowState,
  methodology: Methodology,
  patch: Record<string, unknown>,
  by: string,
  now?: string,
): ApplyResult;
export function changeConfig<N extends string>(
  state: WorkflowState<N>,
  methodology: Methodology<unknown, N>,
  patch: Record<string, unknown>,
  by: string,
  now?: string,
): ApplyResult<N> {
  if (
    typeof patch !== "object" ||
    patch === null ||
    Array.isArray(patch) ||
    Object.keys(patch).length === 0
  )
    fail(
      "invalid-input",
      "config patch must be a non-empty object",
      'pass e.g. { "sprintBudget": { "tokens": 1500000 } } to exwf config set',
    );
  const open = openIteration(state);
  if (open)
    fail(
      "invalid-input",
      `config cannot change while ${open.id} is open`,
      "close it first (exwf ceremony review or cancel; a waterfall phase closes at its gate), then run exwf config set",
    );
  const locked = (methodology.lockedConfigKeys ?? []).filter((k) => Object.hasOwn(patch, k));
  if (locked.length)
    fail(
      "invalid-input",
      `config key(s) ${locked.join(", ")} cannot change after init`,
      methodology.name === "kanban"
        ? "use the service-delivery-review cadence for columns and classes of service"
        : "start a new workflow with exwf init to change them",
    );
  const before = (state.config ?? {}) as Record<string, unknown>;
  const after = methodology.validateConfig({ ...before, ...patch }) as Record<string, unknown>;
  const unknown = Object.keys(patch).filter((k) => !Object.hasOwn(after, k));
  if (unknown.length)
    fail(
      "invalid-input",
      `unknown config key(s) ${unknown.join(", ")}`,
      `known keys: ${Object.keys(after).join(", ")}`,
    );
  const changed = Object.keys(patch).filter(
    (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
  );
  if (changed.length === 0)
    fail(
      "no-op",
      "config patch changes nothing",
      "pass at least one key with a different value to exwf config set",
    );
  const pick = (o: Record<string, unknown>) => Object.fromEntries(changed.map((k) => [k, o[k]]));
  return applyAction(state, methodology, { type: "config.change", by, payload: { patch } }, (s) => {
    const at = nowOf(now);
    let s2 = appendEvent(
      { ...s, config: after },
      "config.changed",
      by,
      { changed, before: pick(before), after: pick(after) },
      at,
    );
    if (methodology.afterConfigChange) s2 = methodology.afterConfigChange(s2, at);
    return s2;
  });
}
