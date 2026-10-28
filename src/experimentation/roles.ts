import type { Role } from "../types.ts";
export function experimentationRoles(): Role[] {
  return [
    {
      id: "coordinator",
      name: "Experiment coordinator",
      modelTier: "large",
      capabilities: ["facilitate", "order-backlog", "manage-flow"],
      canApprove: [],
      inputs: ["objective", "budgets"],
      outputs: ["comparison"],
      do_not: ["Change the frozen baseline or harness"],
    },
    {
      id: "builder",
      name: "Candidate builder",
      modelTier: "large",
      capabilities: ["deliver"],
      canApprove: [],
      inputs: ["frozen harness", "isolated workspace"],
      outputs: ["candidate-sha", "benchmark-result"],
      do_not: ["Validate your own candidate", "Change another candidate workspace"],
    },
    {
      id: "validator",
      name: "Independent validator",
      modelTier: "large",
      capabilities: ["verify", "review", "approve-gate"],
      canApprove: ["experiment-validation"],
      inputs: ["exact candidate SHA", "frozen harness"],
      outputs: ["validation"],
      do_not: ["Approve your own work"],
    },
    {
      id: "integrator",
      name: "Selected candidate integrator",
      modelTier: "large",
      capabilities: ["deliver", "control-change"],
      canApprove: [],
      inputs: ["selected SHA", "current target SHA"],
      outputs: ["integration SHA"],
      do_not: ["Declare integration validated"],
    },
  ];
}
