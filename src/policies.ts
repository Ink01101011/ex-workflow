// The `ex-workflow/policies` entry (design spec section 27): composable policies a host opts into
// per run by wrapping its methodology, e.g.
// `withContextGrounding(withRiskGate(kanban(), { gates: ["code-review"] }), { entry: ["dev"] })`.
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
export { withContextGrounding, withRiskGate } from "./interface/policies.ts";
export type { ContextGroundingOptions } from "./interface/policies.ts";
export { contextOf, recordContextSnapshot } from "./common/context/snapshot.ts";
export type { ContextSnapshotInput } from "./common/context/snapshot.ts";
export { recordRepoChange } from "./common/context/repo-change.ts";
export type { RepoChangeInput } from "./common/context/repo-change.ts";
export { contextGroundedViolations } from "./common/context/policy.ts";
