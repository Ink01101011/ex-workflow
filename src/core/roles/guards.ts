import { fail } from "../errors.ts";
import type { Capability, Role, WorkflowState } from "../types.ts";
import { hasCapability, roleOf, rolesWith } from "./lookup.ts";

export function requireCapabilities(
  state: WorkflowState,
  required: Capability[],
  exclusive: Capability[],
): void {
  for (const cap of required) {
    if (rolesWith(state, cap).length === 0) {
      fail(
        "missing-capability",
        `no registered role has capability "${cap}"`,
        `register a role whose capabilities include "${cap}" (registerRole) before init`,
      );
    }
  }
  for (const cap of exclusive) {
    const holders = rolesWith(state, cap);
    if (holders.length > 1) {
      fail(
        "exclusive-capability",
        `capability "${cap}" must belong to exactly one role but is held by ${holders.map((r) => r.id).join(", ")}`,
        `remove "${cap}" from all but one role`,
      );
    }
  }
}

export function separationLost(state: WorkflowState, required: Capability[]): Role[] {
  if (required.length === 0) return [];
  return Object.values(state.roles).filter((r) => required.every((c) => hasCapability(r, c)));
}

/** `human` may do anything; a role must hold at least one of `caps`; unknown ids may do nothing. */
export function canDo(state: WorkflowState, by: string, ...caps: Capability[]): boolean {
  if (by === "human") return true;
  const role = roleOf(state, by);
  return !!role && caps.some((c) => hasCapability(role, c));
}

export function requireCap(state: WorkflowState, by: string, ...caps: Capability[]): void {
  if (!canDo(state, by, ...caps)) {
    const holders = Object.values(state.roles)
      .filter((r) => caps.some((c) => hasCapability(r, c)))
      .map((r) => r.id);
    fail(
      "missing-capability",
      `"${by}" lacks capability ${caps.map((c) => `"${c}"`).join(" or ")}`,
      `run this as one of: human${holders.map((h) => `, ${h}`).join("")}`,
    );
  }
}
