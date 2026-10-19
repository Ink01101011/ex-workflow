import { fail } from "./errors.ts";
import type { Event, MethodologyName, Role, Stage, WorkflowState } from "./types.ts";

export function nowOf(now?: string): string {
  return now ?? new Date().toISOString();
}

export interface CreateStateInput {
  methodology: MethodologyName;
  config: unknown;
  stages: Stage[];
  roles: Role[];
  now?: string;
}

export function createState(input: CreateStateInput): WorkflowState {
  const seenStages = new Set<string>();
  for (const st of input.stages) {
    if (seenStages.has(st.id))
      fail("config-invalid", `duplicate stage id "${st.id}"`, "give every stage a unique id");
    seenStages.add(st.id);
  }
  const roles: Record<string, Role> = {};
  for (const r of input.roles) {
    if (roles[r.id])
      fail("duplicate-role", `duplicate role id "${r.id}"`, "give every role a unique id");
    roles[r.id] = r;
  }
  const at = nowOf(input.now);
  return {
    version: 1,
    methodology: input.methodology,
    config: input.config,
    items: {},
    stages: input.stages,
    roles,
    iterations: [],
    events: [
      {
        seq: 1,
        at,
        type: "state.created",
        by: "system",
        payload: { methodology: input.methodology },
      },
    ],
    accounting: [],
    pending: [],
    lessons: [],
    agreements: [],
  };
}

export function appendEvent(
  state: WorkflowState,
  type: string,
  by: string,
  payload: unknown,
  now?: string,
): WorkflowState {
  const last = state.events[state.events.length - 1];
  const ev: Event = { seq: (last?.seq ?? 0) + 1, at: nowOf(now), type, by, payload };
  return { ...state, events: [...state.events, ev] };
}

export function lastEvent(state: WorkflowState, type?: string): Event | undefined {
  for (let i = state.events.length - 1; i >= 0; i--) {
    const ev = state.events[i]!;
    if (type === undefined || ev.type === type) return ev;
  }
  return undefined;
}
