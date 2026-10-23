import type { EstimateMode } from "../budget.ts";
import { fail } from "../errors.ts";
import type { Budget, Policy } from "../types.ts";

export interface ScrumConfig {
  sprintBudget: Budget;
  productGoal: string;
  definitionOfDone: Policy[];
  refinementSharePct: number;
  allowMidSprintAdd: "never" | "po-only" | "any";
  inProgressWipLimit?: number;
  /** Close the sprint automatically when its budget is spent and nothing is in flight; default true. */
  autoClose?: boolean;
  /** How the planner and sprint planning price a candidate; default "per-weight". */
  estimateMode?: EstimateMode;
  /** Tokens per weight unit when no accounting history exists; default 20000. */
  fallbackTokensPerWeight?: number;
}

const ADD_MODES = new Set(["never", "po-only", "any"]);

export function validateScrumConfig(raw: unknown): ScrumConfig {
  const c = (raw ?? {}) as Record<string, unknown>;
  const budget = c["sprintBudget"] as Budget | undefined;
  if (
    !budget ||
    typeof budget !== "object" ||
    (budget.tokens === undefined && budget.turns === undefined && budget.wallclockMs === undefined)
  ) {
    fail(
      "config-invalid",
      "scrum config.sprintBudget must define tokens, turns or wallclockMs",
      'e.g. { "sprintBudget": { "tokens": 400000, "turns": 60 } }',
    );
  }
  if (typeof c["productGoal"] !== "string" || c["productGoal"].trim() === "")
    fail(
      "config-invalid",
      "scrum config.productGoal must be a non-empty string",
      "state the Product Goal in one sentence",
    );
  if (!Array.isArray(c["definitionOfDone"]))
    fail(
      "config-invalid",
      "scrum config.definitionOfDone must be a Policy[]",
      'e.g. [{ "kind": "evidence", "evidenceKind": "test-output" }]',
    );
  const share = c["refinementSharePct"] ?? 10;
  if (typeof share !== "number" || share < 0 || share > 100)
    fail(
      "config-invalid",
      "scrum config.refinementSharePct must be 0..100",
      "omit it for the default 10",
    );
  const add = c["allowMidSprintAdd"] ?? "po-only";
  if (typeof add !== "string" || !ADD_MODES.has(add))
    fail(
      "config-invalid",
      `scrum config.allowMidSprintAdd must be never | po-only | any (got ${JSON.stringify(add)})`,
      'use "po-only" unless you have a reason',
    );
  const wip = c["inProgressWipLimit"];
  if (wip !== undefined && (typeof wip !== "number" || wip < 1))
    fail(
      "config-invalid",
      "scrum config.inProgressWipLimit must be a positive number",
      "omit it for no limit",
    );
  const autoClose = c["autoClose"];
  if (autoClose !== undefined && typeof autoClose !== "boolean")
    fail(
      "config-invalid",
      "scrum config.autoClose must be true or false",
      "omit it for the default true",
    );
  const mode = c["estimateMode"];
  if (mode !== undefined && mode !== "per-weight" && mode !== "per-call")
    fail(
      "config-invalid",
      `scrum config.estimateMode must be per-weight | per-call (got ${JSON.stringify(mode)})`,
      'use "per-weight" (the default) or "per-call"',
    );
  const fallback = c["fallbackTokensPerWeight"];
  if (
    fallback !== undefined &&
    (typeof fallback !== "number" || !Number.isFinite(fallback) || fallback <= 0)
  )
    fail(
      "config-invalid",
      "scrum config.fallbackTokensPerWeight must be a positive finite number",
      "omit it for the default 20000",
    );
  const out: ScrumConfig = {
    sprintBudget: budget,
    productGoal: c["productGoal"],
    definitionOfDone: c["definitionOfDone"] as Policy[],
    refinementSharePct: share,
    allowMidSprintAdd: add as ScrumConfig["allowMidSprintAdd"],
  };
  if (wip !== undefined) out.inProgressWipLimit = wip as number;
  if (autoClose !== undefined) out.autoClose = autoClose as boolean;
  if (mode !== undefined) out.estimateMode = mode as EstimateMode;
  if (fallback !== undefined) out.fallbackTokensPerWeight = fallback as number;
  return out;
}
