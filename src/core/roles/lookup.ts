import type { Capability, Role, WorkflowState } from "../types.ts";

/** Own-property role lookup (ids such as "constructor" never hit the prototype). */
export function roleOf(state: WorkflowState, id: string): Role | undefined {
  return Object.hasOwn(state.roles, id) ? state.roles[id] : undefined;
}

export function hasCapability(role: Role, cap: Capability): boolean {
  return role.capabilities.includes(cap);
}

export function rolesWith(state: WorkflowState, cap: Capability): Role[] {
  return Object.values(state.roles).filter((r) => hasCapability(r, cap));
}

/** Ids of roles that may approve `gateId`, optionally holding `cap` and excluding one id. */
export function approverIds(
  state: WorkflowState,
  gateId: string,
  cap?: string,
  except?: string,
): string[] {
  return Object.values(state.roles)
    .filter(
      (r) =>
        r.id !== except &&
        r.canApprove.includes(gateId) &&
        (cap === undefined || (r.capabilities as readonly string[]).includes(cap)),
    )
    .map((r) => r.id);
}

export function approversFor(state: WorkflowState, gateId: string): Role[] {
  return rolesWith(state, "approve-gate").filter((r) => r.canApprove.includes(gateId));
}
