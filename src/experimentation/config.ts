import { fail } from "../errors.ts";
import type { Budget } from "../types.ts";
export interface ExperimentationConfig {
  objective: string;
  direction: "minimize" | "maximize";
  tieBreak: "candidate-id";
  concurrencyCap: number;
  maxCandidates: number;
  candidateBudget: Budget;
  totalBudget: Budget;
}
export const dimensions = ["tokens", "turns", "wallclockMs"] as const;
export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function invalid(message: string): never {
  return fail("invalid-input", message, "supply valid experimentation ceremony input");
}
export function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) invalid(`${label} must be a non-empty string`);
  return value;
}
export function sha(value: unknown, label = "sha"): string {
  const s = text(value, label);
  if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(s))
    invalid(`${label} must be a full lowercase commit SHA`);
  return s;
}
function budget(value: unknown, label: string): Budget {
  if (
    !object(value) ||
    !dimensions.some((k) => value[k] !== undefined) ||
    Object.keys(value).some((k) => !dimensions.includes(k as (typeof dimensions)[number]))
  )
    invalid(`${label} needs tokens, turns or wallclockMs limits`);
  const out: Budget = {};
  for (const k of dimensions) {
    const n = value[k];
    if (n !== undefined) {
      if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0)
        invalid(`${label}.${k} must be a positive safe integer`);
      out[k] = n;
    }
  }
  return out;
}
export function validateExperimentationConfig(raw: unknown): ExperimentationConfig {
  try {
    if (!object(raw)) invalid("experimentation config must be an object");
    const known = [
      "objective",
      "direction",
      "tieBreak",
      "concurrencyCap",
      "maxCandidates",
      "candidateBudget",
      "totalBudget",
    ];
    if (Object.keys(raw).some((k) => !known.includes(k)))
      invalid("unknown experimentation config key");
    const objective = text(raw.objective, "objective");
    const direction = raw.direction ?? "minimize";
    if (direction !== "minimize" && direction !== "maximize")
      invalid("direction must be minimize or maximize");
    const tieBreak = raw.tieBreak ?? "candidate-id";
    if (tieBreak !== "candidate-id") invalid("tieBreak must be candidate-id");
    const concurrencyCap = raw.concurrencyCap ?? 2;
    const maxCandidates = raw.maxCandidates ?? 4;
    for (const [key, n] of Object.entries({ concurrencyCap, maxCandidates }))
      if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1)
        invalid(`${key} must be a positive safe integer`);
    if ((concurrencyCap as number) > (maxCandidates as number))
      invalid("concurrencyCap cannot exceed maxCandidates");
    return {
      objective,
      direction,
      tieBreak,
      concurrencyCap: concurrencyCap as number,
      maxCandidates: maxCandidates as number,
      candidateBudget: budget(raw.candidateBudget ?? { turns: 10 }, "candidateBudget"),
      totalBudget: budget(raw.totalBudget ?? { turns: 40 }, "totalBudget"),
    };
  } catch (error) {
    fail(
      "config-invalid",
      error instanceof Error ? error.message : "invalid experimentation config",
      "provide objective and positive finite limits",
    );
  }
}
