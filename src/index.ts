export const VERSION = "1.1.1";
export * from "./core/types.ts";
export { WorkflowError, fail } from "./core/errors.ts";
export { createState, appendEvent, lastEvent, nowOf } from "./core/state.ts";
export {
  registerRole,
  retireRole,
  hasCapability,
  rolesWith,
  approversFor,
  requireCapabilities,
  separationLost,
  canDo,
  requireCap,
} from "./core/roles.ts";
export {
  assertId,
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
} from "./core/items.ts";
export type { ItemPatch } from "./core/items.ts";
export { applyAgreement, retireAgreement } from "./core/agreements.ts";
export { evaluatePolicies, assertPolicies } from "./core/policies.ts";
export { checkGate, authorOf, lastDispatchBefore, raisePending, decide } from "./core/gates.ts";
export type { GateResult } from "./core/gates.ts";
export { ZERO_SPENT, addSpent, remaining, isExhausted, estimateTokens } from "./core/budget.ts";
export type { EstimateMode } from "./core/budget.ts";
export { plan, toExNodes, assignRole, resourceCapsFor, openIteration } from "./core/planner.ts";
export type { PlanOptions, PlanReason, PlanResult, Skipped } from "./core/planner.ts";
export { synthesizeBrief, next, openQuestions } from "./core/brief.ts";
export type { NextResult } from "./core/brief.ts";
export { complete } from "./core/complete.ts";
export { correctAccounting } from "./core/accounting.ts";
export type { AccountingPatch } from "./core/accounting.ts";
export { coreRulesFor } from "./core/rules.ts";
export { applyAction, validateAction, init, changeConfig } from "./core/methodology.ts";
export type { InitInput } from "./core/methodology.ts";
