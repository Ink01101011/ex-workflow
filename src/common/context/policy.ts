// The context-grounded entry policy (design spec section 27, #36): an item may enter a stage only
// with a fresh, verified context snapshot that someone other than its worker recorded.
import { authorOf } from "../../core/gates.ts";
import type { Violation, WorkItem, WorkflowState } from "../../core/types.ts";
import { independenceConflicts } from "../independence.ts";
import { contextOf } from "./snapshot.ts";

const RULE = "policy:custom:context-grounded";
const RECORD = "record a fresh one with recordContextSnapshot";

/**
 * Violations of the custom policy `context-grounded` for `item` (rule
 * `policy:custom:context-grounded`, the 1.2 rule id of a custom policy): no valid fresh context
 * snapshot; a stale one (names the changed paths); a `required` assumption without a source (names
 * the claims); a snapshot with `required` assumptions recorded by the item's assigned role or
 * author. Empty when the item is grounded. Pure: the same state gives the same answer.
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
      `item "${item.id}" has no context snapshot (none valid since its last rework)`,
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
  const workers = [authorOf(state, item), item.role].filter((x): x is string => x !== undefined);
  if (required.length && independenceConflicts(ctx.by, workers).length)
    v(
      `${of} with required assumptions was recorded by "${ctx.by}", who works on the item`,
      `have an independent role or a human verify the context and ${RECORD}`,
    );
  return out;
}
