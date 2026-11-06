// The context-grounded entry policy (design spec section 27, #36): an item may enter a stage only
// with a fresh, verified context snapshot that a human or a registered role other than its workers
// recorded (contextOf counts only such a snapshot).
import type { Violation, WorkItem, WorkflowState } from "../../core/types.ts";
import { contextOf } from "./snapshot.ts";

const RULE = "policy:custom:context-grounded";
const RECORD = "record a fresh one with recordContextSnapshot";

/**
 * Violations of the custom policy `context-grounded` for `item` (rule
 * `policy:custom:context-grounded`, the 1.2 rule id of a custom policy): no qualifying fresh
 * context snapshot (`contextOf`: valid, at least one sourced assumption, recorded by `human` or a
 * registered role that did not work on the item); a stale one (names the changed paths); a
 * `required` assumption without a source (names the claims). Empty when the item is grounded.
 * Pure: the same state gives the same answer.
 */
export function contextGroundedViolations(
  state: WorkflowState<string>,
  item: WorkItem,
): Violation[] {
  const out: Violation[] = [];
  const v = (message: string, fix: string) =>
    out.push({ rule: RULE, severity: "error", item: item.id, message, fix });
  const ctx = contextOf(state, item);
  if (!ctx) {
    v(
      `item "${item.id}" has no qualifying context snapshot (none since its last rework is valid, cites a source and was recorded by human or a registered role that did not work on it)`,
      `have an independent role or a human verify the context and ${RECORD}`,
    );
    return out;
  }
  const of = `context snapshot "${ctx.snapshot}" of "${item.id}"`;
  if (ctx.stale.length)
    v(
      `${of} is stale: ${ctx.stale.join(", ")} changed since`,
      `re-verify the claims and ${RECORD}`,
    );
  const required = ctx.assumptions.filter((a) => a.required);
  const unverified = required.filter((a) => !a.source).map((a) => a.claim);
  if (unverified.length)
    v(
      `${of} has unverified required assumption(s): ${unverified.join(" | ")}`,
      `cite a source { path, hash } for each and ${RECORD}`,
    );
  return out;
}
