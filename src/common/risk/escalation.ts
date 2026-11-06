// Risk-adaptive gate (design spec section 27, #35): the level of the strictest fresh, valid and
// independent `risk-assessment` evidence picks a row of a table of what the gate additionally needs.
import { canDo } from "../../core/roles/guards.ts";
import { freshEvidence } from "../../core/items/evidence.ts";
import type {
  Evidence,
  Gate,
  GateEscalation,
  GateRequirement,
  WorkItem,
  WorkflowState,
} from "../../core/types.ts";
import { deepFreeze } from "../deep-freeze.ts";
import { independenceConflicts } from "../independence.ts";
import { workersOf } from "../workers.ts";
import { RISK_LEVELS, riskOptions } from "./options.ts";

export type RiskLevel = "low" | "medium" | "high" | "critical";
/** `data` of a `risk-assessment` evidence entry. */
export interface RiskAssessmentData {
  level: RiskLevel;
  /** Free strings naming what drives the risk, e.g. `ci-cd`, `prod-infra`, `secrets`, `blast-radius`, `irreversible`. */
  factors: string[];
  /** The item SHA or ref that was assessed. */
  subject?: string;
}
/** What each level ADDS to the static gate. */
export type RiskTable = Record<RiskLevel, { requires: GateRequirement[]; evidence?: string[] }>;
export interface RiskGateOptions {
  /** Ids of the gates the policy applies to; every other gate stays static. */
  gates: string[];
  /** Default `DEFAULT_RISK_TABLE`. */
  table?: RiskTable;
}

export { RISK_LEVELS };

/** `low` and `medium` add nothing; `high` and `critical` add a human approval. Deeply frozen. */
export const DEFAULT_RISK_TABLE: RiskTable = /* @__PURE__ */ deepFreeze({
  low: { requires: [] },
  medium: { requires: [] },
  high: { requires: ["human"] },
  critical: { requires: ["human"] },
});

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/** True when `data` is a well-formed `RiskAssessmentData`. */
export function isRiskData(data: unknown): data is RiskAssessmentData {
  return (
    isObj(data) &&
    RISK_LEVELS.includes(data["level"] as RiskLevel) &&
    Array.isArray(data["factors"]) &&
    data["factors"].every((f) => typeof f === "string") &&
    (data["subject"] === undefined || typeof data["subject"] === "string")
  );
}

/**
 * Why `by` may not assess `item`: `invalid` when it is neither `human` nor a role with capability
 * `verify`, `not-independent` when it worked on the item (`workersOf`: every role that dispatched
 * it since its last rework, its assigned role, its author); `undefined` when it may. `workers`
 * defaults to `workersOf(state, item)`; pass it to check several assessors against one state.
 */
export function assessorIssue(
  state: WorkflowState<string>,
  item: WorkItem,
  by: string,
  workers: readonly string[] = workersOf(state, item),
): "invalid" | "not-independent" | undefined {
  if (!canDo(state, by, "verify")) return "invalid";
  return independenceConflicts(by, workers).length ? "not-independent" : undefined;
}

/**
 * The escalation of `gate` for `item` under `options` (the `escalateGate` hook `withRiskGate`
 * installs): `undefined` for a gate not in `options.gates`, else the table row of the resolved
 * level. The resolved level is the strictest fresh (post-rework) valid assessment, so a later,
 * lower assessment never relaxes an earlier one; with none it is `critical`, and `reason.why` says
 * whether assessments were `missing`, `invalid` or `not-independent` (the latest rejected one).
 * Invalid options fail `invalid-input` as in `withRiskGate`, never a `TypeError`. Pure: no clock,
 * no randomness; the same state gives the same answer.
 */
export function riskEscalation(
  state: WorkflowState<string>,
  item: WorkItem,
  gate: Gate,
  options: RiskGateOptions,
): GateEscalation | undefined {
  // validated here unless these are the frozen options withRiskGate validated (G1-6)
  const opts = riskOptions(options, "riskEscalation");
  if (!opts.gates.includes(gate.id)) return undefined;
  let level: RiskLevel | undefined;
  let why = "missing";
  let pick: Evidence | undefined;
  let workers: string[] | undefined;
  for (const e of freshEvidence(state, item)) {
    if (e.kind !== "risk-assessment") continue;
    const issue = isRiskData(e.data)
      ? assessorIssue(state, item, e.by, (workers ??= workersOf(state, item)))
      : "invalid";
    if (issue) {
      if (!level) {
        why = issue;
        pick = e;
      }
      continue;
    }
    const l = (e.data as unknown as RiskAssessmentData).level;
    if (!level || RISK_LEVELS.indexOf(l) >= RISK_LEVELS.indexOf(level)) {
      level = l;
      why = "assessed";
      pick = e;
    }
  }
  const resolved = level ?? "critical";
  const row = (opts.table ?? DEFAULT_RISK_TABLE)[resolved];
  return {
    requires: row.requires.map((q) => (q === "human" ? q : { capability: q.capability })),
    evidence: [...(row.evidence ?? [])],
    reason: { level: resolved, why, assessment: pick?.ref ?? null, by: pick?.by ?? null },
  };
}
