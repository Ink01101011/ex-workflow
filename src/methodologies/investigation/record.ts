import { readExt, writeExt } from "../../interface/ext.ts";
import type { WorkflowState } from "../../core/types.ts";
import type { InvestigationState } from "./state.ts";

/** The investigation record: `ext.investigation`, or the legacy field of a state written before 1.2. */
export const readInvestigation = (s: WorkflowState): InvestigationState | undefined =>
  readExt(s, "investigation");

/** Stores the investigation record in `ext.investigation` and its deprecated legacy mirror (spec 26). */
export const writeInvestigation = (s: WorkflowState, x: InvestigationState): WorkflowState =>
  writeExt(s, "investigation", x);
