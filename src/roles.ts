import { fail } from "./errors.ts";
import { appendEvent } from "./state.ts";
import type { Capability, Role, WorkflowState } from "./types.ts";

const OPEN: ReadonlySet<string> = new Set(["in_progress", "review", "blocked"]);

export function registerRole(
  state: WorkflowState,
  role: Role,
  by: string,
  now?: string,
): WorkflowState {
  if (state.roles[role.id])
    fail(
      "duplicate-role",
      `role "${role.id}" already exists`,
      `use a different id or retireRole("${role.id}") first`,
    );
  const next = { ...state, roles: { ...state.roles, [role.id]: role } };
  return appendEvent(
    next,
    "role.registered",
    by,
    { role: role.id, capabilities: role.capabilities },
    now,
  );
}

export function retireRole(
  state: WorkflowState,
  roleId: string,
  by: string,
  now?: string,
): WorkflowState {
  if (!state.roles[roleId])
    fail(
      "unknown-role",
      `role "${roleId}" does not exist`,
      `registered roles: ${Object.keys(state.roles).join(", ") || "(none)"}`,
    );
  const open = Object.values(state.items)
    .filter((i) => i.role === roleId && OPEN.has(i.status))
    .map((i) => i.id);
  if (open.length)
    fail(
      "role-has-open-items",
      `role "${roleId}" still holds ${open.length} open item(s)`,
      `complete or reassign ${open.join(", ")} before retiring the role`,
      { items: open },
    );
  const roles = { ...state.roles };
  delete roles[roleId];
  return appendEvent({ ...state, roles }, "role.retired", by, { role: roleId }, now);
}

export function hasCapability(role: Role, cap: Capability): boolean {
  return role.capabilities.includes(cap);
}

export function rolesWith(state: WorkflowState, cap: Capability): Role[] {
  return Object.values(state.roles).filter((r) => hasCapability(r, cap));
}

export function approversFor(state: WorkflowState, gateId: string): Role[] {
  return rolesWith(state, "approve-gate").filter((r) => r.canApprove.includes(gateId));
}

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
