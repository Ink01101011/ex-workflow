import type { Stage } from "../types.ts";
import type { ScrumConfig } from "./config.ts";

export function scrumStages(config: ScrumConfig): Stage[] {
  const inProgress: Stage = {
    id: "in_progress",
    name: "In progress",
    entryPolicy: [{ kind: "dependencies-done" }],
    exitPolicy: [],
  };
  if (config.inProgressWipLimit !== undefined) inProgress.wipLimit = config.inProgressWipLimit;
  return [
    {
      id: "backlog",
      name: "Product Backlog",
      entryPolicy: [],
      exitPolicy: [{ kind: "acceptance-written" }, { kind: "estimate-present" }],
    },
    { id: "sprint", name: "Sprint Backlog", entryPolicy: [], exitPolicy: [] },
    inProgress,
    { id: "review", name: "Review", entryPolicy: [], exitPolicy: config.definitionOfDone },
    { id: "done", name: "Increment", entryPolicy: [], exitPolicy: [] },
  ];
}
