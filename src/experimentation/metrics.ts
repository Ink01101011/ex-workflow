import type { WorkflowState } from "../types.ts";
import { effectiveSpent, totalSpent } from "./ceremonies.ts";
export function experimentationMetrics(
  s: WorkflowState,
): Record<string, number | Record<string, number>> {
  const e = s.experimentation;
  const all = Object.values(e?.candidates ?? {});
  return {
    candidates: all.length,
    validated: all.filter((c) => c.status === "validated").length,
    failed: all.filter((c) => c.status === "failed").length,
    timedOut: all.filter((c) => c.status === "timed-out").length,
    cancelled: all.filter((c) => c.status === "cancelled").length,
    integrated: e?.status === "integrated" ? 1 : 0,
    spent: e ? { ...totalSpent(s) } : { tokens: 0, turns: 0, wallclockMs: 0 },
    candidateTokens: Object.fromEntries(all.map((c) => [c.id, effectiveSpent(s, c).tokens])),
  };
}
export function experimentationReport(s: WorkflowState): Record<string, unknown> {
  const e = s.experimentation;
  return {
    status: e?.status ?? "unfrozen",
    baseSha: e?.baseSha ?? null,
    harness: e?.harness ?? null,
    selected: e?.selected ?? null,
    reason: e?.reason ?? null,
    integration: e?.integration ? structuredClone(e.integration) : null,
    candidates: structuredClone(e?.candidates ?? {}),
    cleanup: Object.values(e?.candidates ?? {}).flatMap((c) =>
      c.workspace && !e?.released.includes(c.workspace) ? [c.workspace] : [],
    ),
    hostResponsibilities: [
      "provision isolated workspaces at baseSha",
      "execute candidates and the frozen harness",
      "integrate selected SHA at the current target",
      "execute fresh integration validation",
      "release owned workspace identities and record cleanup",
    ],
  };
}
