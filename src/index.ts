export const VERSION = "0.1.0";
export * from "./types.ts";
export { WorkflowError, fail } from "./errors.ts";
export { createState, appendEvent, lastEvent, nowOf } from "./state.ts";
export {
  registerRole,
  retireRole,
  hasCapability,
  rolesWith,
  approversFor,
  requireCapabilities,
  separationLost,
} from "./roles.ts";
export {
  stageOf,
  nextStageOf,
  isTerminalStage,
  getItem,
  addItem,
  editItem,
  moveItem,
  addEvidence,
  raiseBlocker,
  clearBlocker,
} from "./items.ts";
export type { ItemPatch } from "./items.ts";
export { evaluatePolicies, assertPolicies } from "./policies.ts";
export { checkGate, authorOf, raisePending, decide } from "./gates.ts";
export type { GateResult } from "./gates.ts";
