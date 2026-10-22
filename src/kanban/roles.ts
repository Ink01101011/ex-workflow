import type { Role } from "../types.ts";

export function kanbanRoles(): Role[] {
  return [
    {
      id: "service-request-manager",
      name: "Service Request Manager",
      modelTier: "large",
      capabilities: ["order-backlog", "define-acceptance", "manage-flow", "escalate"],
      canApprove: [],
      inputs: ["stakeholder-requests", "options"],
      outputs: ["ordered-options", "acceptance-criteria", "classes-of-service"],
      do_not: [
        "do not implement items yourself",
        "do not push work past the commitment point outside replenishment",
      ],
    },
    {
      id: "service-delivery-manager",
      name: "Service Delivery Manager",
      modelTier: "large",
      capabilities: ["facilitate", "manage-flow", "escalate"],
      canApprove: [],
      inputs: ["board", "flow-metrics", "blockers"],
      outputs: ["cadence-records", "wip-and-policy-changes", "lessons"],
      do_not: ["do not reorder the options", "do not assign work; the planner pulls"],
    },
    {
      id: "worker",
      name: "Worker",
      modelTier: "small",
      capabilities: ["deliver", "review", "verify"],
      canApprove: [],
      inputs: ["brief"],
      outputs: ["code", "test-output"],
      do_not: [
        "do not change acceptance criteria",
        "do not pull more work while your card is open",
      ],
    },
  ];
}
