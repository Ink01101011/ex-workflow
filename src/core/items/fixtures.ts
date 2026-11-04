import { createState } from "../state.ts";
import { WorkflowError } from "../errors.ts";
import type { Role, Stage } from "../types.ts";

export const T0 = "2026-10-19T00:00:00.000Z";
export const stages: Stage[] = [
  { id: "backlog", name: "Backlog", entryPolicy: [], exitPolicy: [] },
  { id: "doing", name: "Doing", entryPolicy: [], exitPolicy: [] },
  { id: "done", name: "Done", entryPolicy: [], exitPolicy: [] },
];
const dev: Role = {
  id: "dev",
  name: "Dev",
  modelTier: "small",
  capabilities: ["deliver"],
  canApprove: [],
  inputs: [],
  outputs: [],
  do_not: [],
};
export const base = () =>
  createState({ methodology: "scrum", config: {}, stages, roles: [dev], now: T0 });
export const code = (e: unknown) => (e instanceof WorkflowError ? e.code : String(e));
