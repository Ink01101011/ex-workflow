import type { Stage } from "../types.ts";
export function investigationStages(): Stage[] {
  return [
    {
      id: "intake",
      name: "Intake",
      entryPolicy: [],
      exitPolicy: [{ kind: "acceptance-written" }],
    },
    {
      id: "execute",
      name: "Execute preregistered experiment",
      entryPolicy: [{ kind: "acceptance-written" }, { kind: "no-open-blockers" }],
      exitPolicy: [{ kind: "evidence", evidenceKind: "experiment-output" }],
    },
    { id: "observed", name: "Execution recorded", entryPolicy: [], exitPolicy: [] },
  ];
}
