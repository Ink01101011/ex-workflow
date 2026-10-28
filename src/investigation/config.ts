import { fail } from "../errors.ts";
import type { Budget } from "../types.ts";
export interface InvestigationConfig {
  question: string;
  maxRounds: number;
  budget: Budget;
}
export function validateInvestigationConfig(raw: unknown): InvestigationConfig {
  const c = raw as InvestigationConfig;
  if (
    !c ||
    typeof c !== "object" ||
    Array.isArray(c) ||
    typeof c.question !== "string" ||
    !c.question.trim() ||
    !Number.isSafeInteger(c.maxRounds) ||
    c.maxRounds < 1 ||
    !c.budget ||
    typeof c.budget !== "object" ||
    Array.isArray(c.budget) ||
    !Object.keys(c.budget).length ||
    Object.entries(c.budget).some(
      ([k, v]) =>
        !["tokens", "turns", "wallclockMs"].includes(k) ||
        typeof v !== "number" ||
        !Number.isFinite(v) ||
        v <= 0,
    )
  )
    fail(
      "config-invalid",
      "investigation requires question, positive maxRounds and a finite positive budget",
      "provide bounded investigation config",
    );
  return { question: c.question, maxRounds: c.maxRounds, budget: { ...c.budget } };
}
