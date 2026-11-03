export interface Hypothesis {
  id: string;
  claim: string;
  falsifiedBy: string;
}
export interface Experiment {
  id: string;
  procedureRef: string;
  predictions: Array<{ hypothesis: string; prediction: string }>;
  replayOf?: string;
}
export interface Observation {
  id: string;
  valid: boolean;
  summary: string;
  provenanceRefs: string[];
}
export interface BeliefUpdate {
  result: string;
  assessments: Array<{
    hypothesis: string;
    assessment: "supported" | "refuted" | "uncertain";
    reason: string;
  }>;
}
export interface InvestigationRound {
  hypotheses: Hypothesis[];
  experiment: Experiment;
  item: string;
  by: string;
  result?: Observation;
  update?: BeliefUpdate;
}
export interface InvestigationConclusion {
  outcome: "resolved" | "inconclusive";
  summary: string;
  supportedHypothesis?: string;
  evidenceRefs: string[];
  by: string;
}
export interface InvestigationState {
  item: string;
  phase:
    | "hypotheses"
    | "preregister"
    | "observe"
    | "update-belief"
    | "conclusion"
    | "review"
    | "closed";
  hypotheses: Hypothesis[];
  singleHypothesisRationale?: string;
  rounds: InvestigationRound[];
  conclusion?: InvestigationConclusion;
  outcome?: "resolved" | "inconclusive" | "stopped";
  stopReason?: string;
  contributors: string[];
  reviewHistory?: Array<{
    by: string;
    reason: string;
    approve: boolean;
    next?: "round" | "conclusion";
    replayRefs: string[];
  }>;
  review?: { by: string; reason: string; replayRefs: string[] };
}
