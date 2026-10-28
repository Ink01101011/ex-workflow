import type { Spent } from "../types.ts";
export interface ExperimentCandidate {
  id: string;
  item: string;
  author: string;
  status:
    | "pending"
    | "ready"
    | "running"
    | "submitted"
    | "validated"
    | "failed"
    | "timed-out"
    | "cancelled";
  workspace?: string;
  sha?: string;
  score?: number;
  spent: Spent;
  validation?: {
    sha: string;
    harness: string;
    by: string;
    passed: boolean;
    reproducible: boolean;
    evidence: string;
  };
  reason?: string;
  command?: string;
  log?: string;
  /** Final failed/cancelled attempt report, separate from the submitted benchmark log. */
  terminalLog?: string;
}
export interface ExperimentationState {
  status: "running" | "selected" | "integrating" | "integrated" | "stopped";
  baseSha: string;
  harness: string;
  candidates: Record<string, ExperimentCandidate>;
  selected?: string;
  reason?: string;
  integration?: {
    selectedSha: string;
    targetSha: string;
    sha: string;
    by: string;
    validation?: { by: string; sha: string; harness: string; evidence: string; passed: boolean };
  };
  released: string[];
  /** Host-reported control, validation and integration cost, additional to candidate execution. */
  overhead: Spent;
}
