import type { Stage } from "../types.ts";
import type { WaterfallConfig } from "./config.ts";
import { DONE, REVIEW, WORK } from "./phases.ts";

/** Every phase's items share the same three steps; the phase is the unit of governance. */
export function waterfallStages(_config: WaterfallConfig): Stage[] {
  return [
    { id: WORK, name: "Work", entryPolicy: [{ kind: "dependencies-done" }], exitPolicy: [] },
    {
      id: REVIEW,
      name: "Review",
      entryPolicy: [],
      exitPolicy: [{ kind: "no-open-blockers" }],
      review: true,
    },
    { id: DONE, name: "Done", entryPolicy: [], exitPolicy: [] },
  ];
}
