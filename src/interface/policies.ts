// Wrappers that turn any methodology into one carrying a policy (design spec section 27). The
// wrapped methodology keeps every other member, its name included, so registerMethodology accepts it.
import { assertId, fail } from "../core/errors.ts";
import type { GateRequirement, Methodology, Policy } from "../core/types.ts";
import { contextGroundedViolations } from "../common/context/policy.ts";
import { contextOf } from "../common/context/snapshot.ts";
import { deepFreeze } from "../common/deep-freeze.ts";
import {
  RISK_LEVELS,
  riskEscalation,
  type RiskGateOptions,
  type RiskTable,
} from "../common/risk/escalation.ts";

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const bad = (what: string, fix: string): never =>
  fail("invalid-input", `withRiskGate options: ${what}`, fix);
const closed = (o: Record<string, unknown>, keys: string[], at: string): void => {
  for (const k of Object.keys(o))
    if (!keys.includes(k)) bad(`unknown key "${k}" in ${at}`, `use only: ${keys.join(", ")}`);
};

function requirement(q: unknown, at: string): GateRequirement {
  if (q === "human") return q;
  if (
    !isObj(q) ||
    typeof q["capability"] !== "string" ||
    q["capability"].trim() === "" ||
    Object.keys(q).length !== 1
  )
    bad(
      `${at} must be "human" or { capability: <name> }`,
      'e.g. ["human"] or [{ "capability": "review" }]',
    );
  return { capability: (q as { capability: string }).capability };
}

/** Validates and copies the options once (deeply frozen), so later changes by the caller do not leak in. */
function riskOptions(options: unknown): Required<RiskGateOptions> {
  if (!isObj(options)) bad("must be an object", 'pass { "gates": ["code-review"] }');
  const o = options as Record<string, unknown>;
  closed(o, ["gates", "table"], "options");
  if (!Array.isArray(o["gates"]))
    bad("gates must be an array of gate ids", 'e.g. "gates": ["code-review"]');
  const gates = (o["gates"] as unknown[]).map((g) => {
    assertId(g, "risk gate id");
    return g as string;
  });
  const raw = o["table"];
  let table: RiskTable | undefined;
  if (raw !== undefined) {
    if (!isObj(raw))
      bad("table must be an object keyed by risk level", `levels: ${RISK_LEVELS.join(", ")}`);
    const t = raw as Record<string, unknown>;
    closed(t, [...RISK_LEVELS], "table");
    table = {} as RiskTable;
    for (const level of RISK_LEVELS) {
      const row = t[level];
      if (!isObj(row))
        bad(
          `table is missing level "${level}"`,
          `give every level a row, e.g. "${level}": { "requires": [] }`,
        );
      const rw = row as Record<string, unknown>;
      closed(rw, ["requires", "evidence"], `table.${level}`);
      if (!Array.isArray(rw["requires"]))
        bad(`table.${level}.requires must be an array`, 'e.g. "requires": ["human"]');
      const ev = rw["evidence"];
      if (
        ev !== undefined &&
        (!Array.isArray(ev) || !ev.every((k) => typeof k === "string" && k.trim() !== ""))
      )
        bad(
          `table.${level}.evidence must be an array of evidence kinds`,
          'e.g. "evidence": ["sbom"]',
        );
      table[level] = {
        requires: (rw["requires"] as unknown[]).map((q, i) =>
          requirement(q, `table.${level}.requires[${i}]`),
        ),
        ...(ev === undefined ? {} : { evidence: [...(ev as string[])] }),
      };
    }
  }
  return deepFreeze(table ? { gates, table } : ({ gates } as Required<RiskGateOptions>));
}

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
  const opts = riskOptions(options);
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
  const { customPolicy, briefContext } = methodology;
  const add = (list: Policy[], on: boolean): Policy[] =>
    on && !list.some((p) => p.kind === "custom" && p.id === GROUNDED)
      ? [...list, groundedPolicy]
      : list;
  return {
    ...methodology,
    defaultStages(config) {
      const stages = methodology.defaultStages(config);
      for (const id of [...entry, ...exit])
        if (!stages.some((st) => st.id === id))
          fail(
            "invalid-input",
            `withContextGrounding: unknown stage "${id}"`,
            `stages: ${stages.map((st) => st.id).join(", ")}`,
          );
      return stages.map((st) => ({
        ...st,
        entryPolicy: add(st.entryPolicy, entry.includes(st.id)),
        exitPolicy: add(st.exitPolicy, exit.includes(st.id)),
      }));
    },
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
