import { fail } from "../../core/errors.ts";
import { addEvidence } from "../../core/items/evidence.ts";
import { getItem } from "../../core/items/record.ts";
import { applyAction } from "../../core/methodology.ts";
import { rolesWith } from "../../core/roles/lookup.ts";
import type { ApplyResult, Methodology, WorkflowState } from "../../core/types.ts";
import { RISK_LEVELS, assessorIssue, type RiskLevel } from "./escalation.ts";

export interface RiskAssessmentInput {
  item: string;
  level: RiskLevel;
  factors: string[];
  /** The host's assessment artifact. */
  ref: string;
  /** The item SHA or ref that was assessed. */
  subject?: string;
  /** The assessor: `human` or a role with capability `verify` that did not do the work. */
  by: string;
  now?: string;
}

const KEYS = ["item", "level", "factors", "ref", "subject", "by", "now"];
const bad = (what: string, fix: string): never =>
  fail("invalid-input", `risk assessment: ${what}`, fix);

/**
 * Records a risk assessment of an item as evidence `risk-assessment` with `data: { level, factors,
 * subject? }` (design spec section 27, #35), through `applyAction` (action `risk.assess`) so the
 * methodology's rules see it. Refuses `invalid-input` for an unknown key, an unknown level, a
 * non-string factor, an empty ref, an assessor that is neither `human` nor a role with `verify`, and
 * an assessor that is the item's author or assigned role.
 */
export function recordRiskAssessment<N extends string>(
  state: WorkflowState<N>,
  methodology: Methodology<unknown, N>,
  input: RiskAssessmentInput,
): ApplyResult<N> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    bad("input must be an object", `pass { ${KEYS.join(", ")} }`);
  for (const k of Object.keys(input))
    if (!KEYS.includes(k)) bad(`unknown key "${k}"`, `use only: ${KEYS.join(", ")}`);
  const { item: id, level, factors, ref, subject, by, now } = input;
  if (typeof id !== "string") bad("item must be an item id", 'e.g. "item": "CART-12"');
  const item = getItem(state, id);
  if (!RISK_LEVELS.includes(level))
    bad(`unknown level ${JSON.stringify(level)}`, `use one of: ${RISK_LEVELS.join(", ")}`);
  if (!Array.isArray(factors) || !factors.every((f) => typeof f === "string"))
    bad("factors must be an array of strings", 'e.g. "factors": ["ci-cd", "secrets"]');
  if (typeof ref !== "string" || ref.trim() === "")
    bad("ref must be a non-empty string", 'name the assessment artifact, e.g. "risk/CART-12.md"');
  if (subject !== undefined && typeof subject !== "string")
    bad("subject must be a string", "pass the assessed SHA or ref, or omit it");
  if (now !== undefined && typeof now !== "string")
    bad("now must be an ISO timestamp string", "omit now to use the clock");
  if (typeof by !== "string" || by === "") bad("by must name the assessor", 'e.g. "by": "human"');
  const issue = assessorIssue(state, item, by);
  if (issue === "invalid")
    bad(
      `"${by}" may not assess risk (needs capability "verify")`,
      `assess as human or one of: ${
        rolesWith(state, "verify")
          .map((r) => r.id)
          .join(", ") || "(no role has verify; register one)"
      }`,
    );
  if (issue)
    bad(
      `"${by}" did the work on "${id}" and may not assess its risk`,
      "assess as human or an independent role with capability verify",
    );
  const data: Record<string, unknown> = { level, factors: [...factors] };
  if (subject !== undefined) data["subject"] = subject;
  return applyAction(
    state,
    methodology,
    { type: "risk.assess", by, payload: { item: id, ref, ...data } },
    (s) => addEvidence(s, id, { kind: "risk-assessment", ref, by, data }, now),
  );
}
