import { createState } from "../state.ts";
import type { Role, Stage } from "../types.ts";

export const T0 = "2026-10-19T00:00:00.000Z";
export const stages: Stage[] = [{ id: "todo", name: "To do", entryPolicy: [], exitPolicy: [] }];
export const role = (id: string, caps: Role["capabilities"], canApprove: string[] = []): Role => ({
  id,
  name: id,
  modelTier: "small",
  capabilities: caps,
  canApprove,
  inputs: [],
  outputs: [],
  do_not: [],
});
export const po = role("po", ["order-backlog", "define-acceptance"]);
export const dev = role("dev", ["deliver", "review"]);
export const base = () =>
  createState({ methodology: "scrum", config: {}, stages, roles: [po], now: T0 });
