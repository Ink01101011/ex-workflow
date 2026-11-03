import { assertId, fail } from "../errors.ts";
import { appendEvent } from "../state.ts";
import type { Role, WorkflowState } from "../types.ts";
import { roleOf } from "./lookup.ts";

const OPEN: ReadonlySet<string> = new Set(["in_progress", "review", "blocked"]);

export function registerRole<N extends string>(
  state: WorkflowState<N>,
  role: Role,
  by: string,
  now?: string,
): WorkflowState<N>;
export function registerRole(
  state: WorkflowState,
  role: Role,
  by: string,
  now?: string,
): WorkflowState;
export function registerRole<N extends string>(
  state: WorkflowState<N>,
  role: Role,
  by: string,
  now?: string,
): WorkflowState<N> {
  assertId(role.id, "role id");
  if (roleOf(state, role.id))
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

export function retireRole<N extends string>(
  state: WorkflowState<N>,
  roleId: string,
  by: string,
  now?: string,
): WorkflowState<N>;
export function retireRole(
  state: WorkflowState,
  roleId: string,
  by: string,
  now?: string,
): WorkflowState;
export function retireRole<N extends string>(
  state: WorkflowState<N>,
  roleId: string,
  by: string,
  now?: string,
): WorkflowState<N> {
  if (!roleOf(state, roleId))
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
