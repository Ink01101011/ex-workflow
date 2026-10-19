import { fail } from "../errors.ts";
import type { Budget, Policy } from "../types.ts";

export interface ScrumConfig {
  sprintBudget: Budget;
  productGoal: string;
  definitionOfDone: Policy[];
  refinementSharePct: number;
  allowMidSprintAdd: "never" | "po-only" | "any";
  inProgressWipLimit?: number;
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
  const out: ScrumConfig = {
    sprintBudget: budget,
    productGoal: c["productGoal"],
    definitionOfDone: c["definitionOfDone"] as Policy[],
    refinementSharePct: share,
    allowMidSprintAdd: add as ScrumConfig["allowMidSprintAdd"],
  };
  if (wip !== undefined) out.inProgressWipLimit = wip as number;
  return out;
}
