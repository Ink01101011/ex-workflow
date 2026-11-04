import { fail } from "../errors.ts";
import type { Stage, WorkflowState } from "../types.ts";

export function stageOf(state: WorkflowState<string>, stageId: string): Stage;
export function stageOf(state: WorkflowState, stageId: string): Stage;
export function stageOf(state: WorkflowState<string>, stageId: string): Stage {
  const st = state.stages.find((s) => s.id === stageId);
  if (!st)
    fail(
      "unknown-stage",
      `stage "${stageId}" does not exist`,
      `stages are: ${state.stages.map((s) => s.id).join(" → ")}`,
    );
  return st;
}

export function nextStageOf(state: WorkflowState<string>, stageId: string): Stage | undefined;
export function nextStageOf(state: WorkflowState, stageId: string): Stage | undefined;
export function nextStageOf(state: WorkflowState<string>, stageId: string): Stage | undefined {
  const idx = state.stages.findIndex((s) => s.id === stageId);
  if (idx < 0) stageOf(state, stageId);
  return state.stages[idx + 1];
}

export function isTerminalStage(state: WorkflowState<string>, stageId: string): boolean;
export function isTerminalStage(state: WorkflowState, stageId: string): boolean;
export function isTerminalStage(state: WorkflowState<string>, stageId: string): boolean {
  return state.stages[state.stages.length - 1]?.id === stageId;
}
