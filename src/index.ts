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
