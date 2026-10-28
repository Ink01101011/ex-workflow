import type { Handoff, Verdict, WorkflowState } from "../types.ts";

interface Completion {
  id: string;
  verdict: Verdict;
  produced: Handoff["produced"];
}

/** Completion actors come from validated handoffs, never caller-supplied accounting identity. */
export function executionActors(state: WorkflowState, item: string): string[] {
  return [
    ...new Set([
      ...state.events
        .filter(
          (event) => event.type === "item.completed" && (event.payload as Completion).id === item,
        )
        .map((event) => event.by),
      ...(state.items[item]?.transitions ?? [])
        .filter((transition) => transition.to.status === "in_progress")
        .map((transition) => transition.by),
    ]),
  ];
}

/** Only outputs of the latest successful completion can establish observation provenance. */
export function freshOutputRefs(state: WorkflowState, item: string): string[] {
  let completion: Completion | undefined;
  for (let index = state.events.length - 1; index >= 0; index--) {
    const event = state.events[index]!;
    if (event.type === "item.completed" && (event.payload as Completion).id === item) {
      completion = event.payload as Completion;
      break;
    }
  }
  return completion && ["done", "needs-review"].includes(completion.verdict)
    ? completion.produced
        .filter((output) => output.kind === "experiment-output")
        .map((output) => output.ref)
    : [];
}
