import type { Role } from "../types.ts";

export function scrumRoles(): Role[] {
  return [
    {
      id: "product-owner",
      name: "Product Owner",
      modelTier: "large",
      capabilities: ["order-backlog", "define-acceptance", "escalate"],
      canApprove: ["sprint-review"],
      inputs: ["stakeholder-needs", "product-goal"],
      outputs: ["ordered-backlog", "acceptance-criteria"],
      do_not: ["do not implement items yourself"],
    },
    {
      id: "scrum-master",
      name: "Scrum Master",
      modelTier: "large",
      capabilities: ["facilitate", "escalate"],
      canApprove: [],
      inputs: ["board", "blockers"],
      outputs: ["ceremony-records", "lessons"],
      do_not: ["do not reorder the Product Backlog", "do not assign work; the planner pulls"],
    },
    {
      id: "developer",
      name: "Developer",
      modelTier: "small",
      capabilities: ["deliver", "review", "verify"],
      canApprove: [],
      inputs: ["brief"],
      outputs: ["code", "test-output"],
      do_not: ["do not change acceptance criteria", "do not touch items outside your brief"],
    },
  ];
}
