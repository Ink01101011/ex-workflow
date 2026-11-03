import { readExt, writeExt } from "../../interface/ext.ts";
import type { WorkflowState } from "../../core/types.ts";
import type { ExperimentationState } from "./state.ts";

/** The experimentation record: `ext.experimentation`, or the legacy field of a state written before 1.2. */
export const readExperimentation = (s: WorkflowState): ExperimentationState | undefined =>
  readExt(s, "experimentation");

/** Stores the experimentation record in `ext.experimentation` and its deprecated legacy mirror (spec 26). */
export const writeExperimentation = (s: WorkflowState, x: ExperimentationState): WorkflowState =>
  writeExt(s, "experimentation", x);
