import type { Stage } from "../types.ts";
export function experimentationStages(): Stage[] {
  return [
    {
      id: "candidate",
      name: "Frozen candidate",
      entryPolicy: [],
      exitPolicy: [
        { kind: "acceptance-written" },
        { kind: "no-open-blockers" },
        { kind: "dependencies-done" },
      ],
    },
    {
      id: "building",
      name: "Isolated candidate execution",
      entryPolicy: [
        { kind: "acceptance-written" },
        { kind: "no-open-blockers" },
        { kind: "dependencies-done" },
      ],
      exitPolicy: [
        { kind: "evidence", evidenceKind: "candidate-sha" },
        { kind: "evidence", evidenceKind: "benchmark-result" },
      ],
    },
    {
      id: "validation",
      name: "Independent exact-SHA validation",
      review: true,
      entryPolicy: [],
      exitPolicy: [{ kind: "evidence", evidenceKind: "validation" }],
      gate: {
        id: "experiment-validation",
        requires: [{ capability: "verify" }],
        evidence: ["validation"],
        onFail: { action: "block" },
      },
    },
    {
      id: "done",
      name: "Candidate work complete",
      entryPolicy: [],
      exitPolicy: [],
      deliveryPoint: true,
    },
  ];
}
