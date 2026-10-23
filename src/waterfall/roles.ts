import type { Role } from "../types.ts";
import { CHANGE_GATE, type WaterfallConfig } from "./config.ts";

/** Order matters: the first role with "deliver" is the fallback deliverer for phases without deliverBy. */
export function waterfallRoles(config: WaterfallConfig): Role[] {
  const gates = config.phases.map((p) => p.gate.id);
  return [
    {
      id: "project-manager",
      name: "Project Manager",
      modelTier: "large",
      capabilities: ["facilitate", "control-change", "approve-gate", "escalate"],
      canApprove: [...gates, CHANGE_GATE],
      inputs: ["phase-plan", "deliverables", "change-requests"],
      outputs: ["gate-decisions", "baselines", "change-decisions"],
      do_not: [
        "do not implement items yourself",
        "do not reopen a phase without an approved change-request",
      ],
    },
    {
      id: "developer",
      name: "Developer",
      modelTier: "small",
      capabilities: ["deliver"],
      canApprove: [],
      inputs: ["design-doc", "interface-spec", "brief"],
      outputs: ["code", "code-baseline", "test-output"],
      do_not: [
        "do not change requirements or designs; raise a change-request",
        "do not approve your own work",
      ],
    },
    {
      id: "business-analyst",
      name: "Business Analyst",
      modelTier: "medium",
      capabilities: ["define-acceptance", "deliver"],
      canApprove: [],
      inputs: ["stakeholder-needs"],
      outputs: ["srs", "acceptance-criteria"],
      do_not: [
        "do not design or implement",
        "do not edit a baselined requirement; raise a change-request",
      ],
    },
    {
      id: "architect",
      name: "Architect",
      modelTier: "medium",
      capabilities: ["deliver"],
      canApprove: [],
      inputs: ["srs"],
      outputs: ["design-doc", "interface-spec"],
      do_not: ["do not change requirements; raise a change-request", "do not implement"],
    },
    {
      id: "qa",
      name: "QA",
      modelTier: "small",
      capabilities: ["verify", "review"],
      canApprove: [],
      inputs: ["srs", "design-doc", "code-baseline"],
      outputs: ["test-report", "review-notes"],
      do_not: ["do not fix defects yourself; raise bugs", "do not approve phase gates"],
    },
    {
      id: "release-manager",
      name: "Release Manager",
      modelTier: "small",
      capabilities: ["deliver"],
      canApprove: [],
      inputs: ["code-baseline", "test-report"],
      outputs: ["release-notes", "deployment-record"],
      do_not: ["do not deploy an unbaselined verification phase"],
    },
  ];
}
