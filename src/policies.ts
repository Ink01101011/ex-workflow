// The `ex-workflow/policies` entry (design spec section 27): composable policies a host opts into
// per run by wrapping its methodology, e.g. `withRiskGate(kanban(), { gates: ["code-review"] })`.
// Outer ring, like src/registry.ts: the root entry exports none of these, so no core+<methodology>
// bundle carries them.
export { DEFAULT_RISK_TABLE, riskEscalation } from "./common/risk/escalation.ts";
export type {
  RiskAssessmentData,
  RiskGateOptions,
  RiskLevel,
  RiskTable,
} from "./common/risk/escalation.ts";
export { recordRiskAssessment } from "./common/risk/assessment.ts";
export type { RiskAssessmentInput } from "./common/risk/assessment.ts";
export { withRiskGate } from "./interface/policies.ts";
