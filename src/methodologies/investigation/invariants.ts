import { fail } from "../../core/errors.ts";
import type { Iteration, WorkflowState } from "../../core/types.ts";
import type { InvestigationState } from "./state.ts";

/** A loaded state that breaks an invariant the ceremonies keep (a hand-edited or damaged file). */
export function brokenInvestigation(what: string): never {
  return fail(
    "invalid-input",
    `the investigation state is inconsistent: ${what}`,
    "restore .workflow/state.json from git, or start a new investigation",
  );
}

/** The latest round; the phases after preregister always have one. */
export function lastRound(x: InvestigationState): InvestigationState["rounds"][number] {
  return x.rounds.at(-1) ?? brokenInvestigation(`phase ${x.phase} has no round`);
}

/** The `investigation` iteration intake opens; its budget bounds every round. */
export function investigationIteration(s: WorkflowState<string>): Iteration {
  return (
    s.iterations.find((it) => it.id === "investigation") ??
    brokenInvestigation('there is no "investigation" iteration')
  );
}
