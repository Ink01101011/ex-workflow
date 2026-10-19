import { fail } from "./errors.ts";
import { requireCapabilities } from "./roles.ts";
import { coreRulesFor } from "./rules.ts";
import { createState } from "./state.ts";
import type {
  Action,
  ApplyResult,
  Methodology,
  Role,
  Stage,
  Violation,
  WorkflowState,
} from "./types.ts";

export function validateAction(
  state: WorkflowState,
  methodology: Methodology,
  action: Action,
): Violation[] {
  const out: Violation[] = [];
  for (const rule of [...coreRulesFor(methodology), ...methodology.rules])
    out.push(...rule.check(state, action));
  return out;
}

export function applyAction(
  state: WorkflowState,
  methodology: Methodology,
  action: Action,
  reduce: (s: WorkflowState) => WorkflowState,
): ApplyResult {
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

export interface InitInput<C> {
  methodology: Methodology<C>;
  config: unknown;
  roles?: Role[];
  stages?: Stage[];
  by?: string;
  now?: string;
}

export function init<C>(input: InitInput<C>): ApplyResult {
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
  return applyAction(state, m as Methodology, { type: "init", by: input.by ?? "system" }, (s) => s);
}
