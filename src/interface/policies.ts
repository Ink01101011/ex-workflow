// Wrappers that turn any methodology into one carrying a policy (design spec section 27). The
// wrapped methodology keeps every other member, its name included, so registerMethodology accepts it.
import { assertId, fail } from "../core/errors.ts";
import type { Methodology, Policy } from "../core/types.ts";
import { contextGroundedViolations } from "../common/context/policy.ts";
import { contextOf } from "../common/context/snapshot.ts";
import { riskEscalation, type RiskGateOptions } from "../common/risk/escalation.ts";
import { riskOptions } from "../common/risk/options.ts";

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * `methodology` with the risk-adaptive gate policy (design spec section 27, #35): for each gate in
 * `options.gates`, `complete()` adds the requirements of the row of `options.table` (default
 * `DEFAULT_RISK_TABLE`) that the item's strictest fresh, valid, independent risk assessment picks,
 * `critical` when there is none. An `escalateGate` the methodology already has is kept: both widen
 * the gate. Invalid options fail `invalid-input` here, once.
 */
export function withRiskGate<C, N extends string>(
  methodology: Methodology<C, N>,
  options: RiskGateOptions,
): Methodology<C, N> {
  const opts = riskOptions(options, "withRiskGate");
  const inner = methodology.escalateGate;
  return {
    ...methodology,
    escalateGate(state, item, gate) {
      const own = riskEscalation(state, item, gate, opts);
      const prior = inner?.call(methodology, state, item, gate);
      if (!prior || !own) return prior ?? own;
      return {
        requires: [...prior.requires, ...own.requires],
        evidence: [...prior.evidence, ...own.evidence],
        reason: { ...prior.reason, ...own.reason },
      };
    },
  };
}

export interface ContextGroundingOptions {
  /** Stage ids whose entry policies gain the custom policy `context-grounded`. */
  entry: string[];
  /** Stage ids whose exit policies gain it. */
  exit?: string[];
}

const GROUNDED = "context-grounded";
const groundedPolicy: Policy = {
  kind: "custom",
  id: GROUNDED,
  description: "grounded in a fresh, verified context snapshot",
};
const badGrounding = (what: string, fix: string): never =>
  fail("invalid-input", `withContextGrounding options: ${what}`, fix);

function stageIds(o: Record<string, unknown>, key: "entry" | "exit"): string[] {
  const ids = o[key];
  if (ids === undefined && key === "exit") return [];
  if (!Array.isArray(ids))
    badGrounding(`${key} must be an array of stage ids`, `e.g. "${key}": ["dev"]`);
  return (ids as unknown[]).map((id) => {
    assertId(id, `context-grounded ${key} stage id`);
    return id as string;
  });
}

/**
 * `methodology` with the context-grounded policy (design spec section 27, #36): `defaultStages`
 * adds the custom policy `context-grounded` to the entry policies of the `entry` stages and the
 * exit policies of the `exit` stages (an unknown stage id fails `invalid-input` there), and
 * `plan()`/`complete()` answer it with `contextGroundedViolations`; `synthesizeBrief` carries
 * `contextOf` as `Brief.context`. Hooks the methodology already has answer every other policy id
 * and a brief with no snapshot. Invalid options fail `invalid-input` here, once.
 */
export function withContextGrounding<C, N extends string>(
  methodology: Methodology<C, N>,
  options: ContextGroundingOptions,
): Methodology<C, N> {
  if (!isObj(options)) badGrounding("must be an object", 'pass { "entry": ["dev"] }');
  const o = options as unknown as Record<string, unknown>;
  for (const k of Object.keys(o))
    if (k !== "entry" && k !== "exit") badGrounding(`unknown key "${k}"`, "use only: entry, exit");
  const entry = stageIds(o, "entry");
  const exit = stageIds(o, "exit");
  const add = (list: Policy[], on: boolean): Policy[] =>
    on && !list.some((p) => p.kind === "custom" && p.id === GROUNDED)
      ? [...list, groundedPolicy]
      : list;
  return {
    ...withGroundingHooks(methodology),
    defaultStages(config) {
      const stages = methodology.defaultStages(config);
      for (const id of [...entry, ...exit])
        if (!stages.some((st) => st.id === id))
          fail(
            "invalid-input",
            `withContextGrounding: unknown stage "${id}"`,
            `stages: ${stages.map((st) => st.id).join(", ")}`,
          );
      // a built-in ceremony checks these policies without the hook, so the policy could never pass
      // there (spec 28, G2 finding 2): refuse them here, once
      const checked = ceremonyChecked(methodology.name, stages);
      for (const [key, ids] of [
        ["entry", entry],
        ["exit", exit],
      ] as const)
        for (const id of ids)
          if (checked[key].includes(id))
            fail(
              "invalid-input",
              `withContextGrounding: the ${methodology.name} ceremony that moves items ${key === "entry" ? "into" : "out of"} "${id}" checks its ${key} policies without the grounding hook`,
              `ground a later stage instead, e.g. ${key} ["${stages.find((st) => !checked.entry.includes(st.id) && !checked.exit.includes(st.id) && st.id !== stages[0]!.id)?.id ?? "dev"}"]`,
            );
      return stages.map((st) => ({
        ...st,
        entryPolicy: add(st.entryPolicy, entry.includes(st.id)),
        exitPolicy: add(st.exitPolicy, exit.includes(st.id)),
      }));
    },
  };
}

/** Stage policies a built-in methodology's ceremonies check with `assertPolicies` (spec 28). */
function ceremonyChecked(
  name: string,
  stages: readonly { id: string }[],
): { entry: string[]; exit: string[] } {
  if (name === "kanban") return { entry: [], exit: stages[0] ? [stages[0].id] : [] };
  if (name === "scrum") return { entry: [], exit: ["backlog"] };
  if (name === "experimentation") return { entry: ["building"], exit: [] };
  return { entry: [], exit: [] };
}

/**
 * `methodology` with the hooks that answer the custom policy `context-grounded` (spec 28, #47):
 * `customPolicy` with `contextGroundedViolations`, `briefContext` with `contextOf`; hooks the
 * methodology already has answer every other policy id and a brief with no snapshot. Stages are
 * untouched. `withContextGrounding` builds on it, and the CLI wraps every methodology with it so a
 * state the SDK grounded is judged by its snapshots there too. Not exported from an entry point.
 */
export function withGroundingHooks<C, N extends string>(
  methodology: Methodology<C, N>,
): Methodology<C, N> {
  const { customPolicy, briefContext } = methodology;
  return {
    ...methodology,
    customPolicy(state, item, policy) {
      return policy.id === GROUNDED
        ? contextGroundedViolations(state, item)
        : customPolicy?.call(methodology, state, item, policy);
    },
    briefContext(state, item) {
      return contextOf(state, item) ?? briefContext?.call(methodology, state, item);
    },
  };
}
