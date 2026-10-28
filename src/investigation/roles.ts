import type { Role } from "../types.ts";
export function investigationRoles(): Role[] {
  return [
    {
      id: "replay-worker",
      name: "Independent replay worker",
      modelTier: "small",
      capabilities: ["deliver", "verify"],
      canApprove: [],
      inputs: ["preregistered-experiment"],
      outputs: ["experiment-output"],
      do_not: ["Do not change the replay procedure"],
    },
    {
      id: "investigator",
      name: "Investigator",
      modelTier: "large",
      capabilities: ["facilitate", "define-acceptance", "deliver", "verify"],
      canApprove: [],
      inputs: ["question", "prior-results"],
      outputs: ["hypotheses", "preregistered-experiment", "belief-update"],
      do_not: ["Do not revise predictions after execution", "Do not approve your own conclusions"],
    },
    {
      id: "conclusion-reviewer",
      name: "Independent conclusion reviewer",
      modelTier: "large",
      capabilities: ["review"],
      canApprove: ["investigation-conclusion"],
      inputs: ["evidence", "replay", "conclusion"],
      outputs: ["conclusion-review"],
      do_not: ["Do not approve unsupported conclusions"],
    },
  ];
}
