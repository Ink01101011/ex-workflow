import { fail } from "./errors.ts";
import { freshEvidence } from "./items.ts";
import type { Policy, Violation, WorkItem, WorkflowState } from "./types.ts";

export function evaluatePolicies(
  state: WorkflowState,
  item: WorkItem,
  policies: Policy[],
): Violation[] {
  const out: Violation[] = [];
  const fresh = freshEvidence(state, item);
  const v = (rule: string, message: string, fix: string) =>
    out.push({ rule, severity: "error", item: item.id, message, fix });
  for (const p of policies) {
    switch (p.kind) {
      case "evidence":
        if (!fresh.some((e) => e.kind === p.evidenceKind))
          v(
            "policy:evidence",
            `item "${item.id}" has no evidence of kind "${p.evidenceKind}"`,
            `attach evidence { kind: "${p.evidenceKind}" } via addEvidence or in the handoff.produced`,
          );
        break;
      case "acceptance-written":
        if (item.acceptance.length === 0)
          v(
            "policy:acceptance-written",
            `item "${item.id}" has no acceptance criteria`,
            "editItem with a non-empty acceptance[] (needs define-acceptance)",
          );
        break;
      case "estimate-present":
        if (item.weight === undefined)
          v(
            "policy:estimate-present",
            `item "${item.id}" has no weight`,
            "editItem with a weight (story points)",
          );
        break;
      case "no-open-blockers": {
        const open = item.blockers.filter((b) => !b.clearedAt);
        if (open.length)
          v(
            "policy:no-open-blockers",
            `item "${item.id}" has ${open.length} open blocker(s)`,
            `clearBlocker ${open.map((b) => b.id).join(", ")}`,
          );
        break;
      }
      case "dependencies-done": {
        const notDone = item.dependsOn.filter((d) => state.items[d]?.status !== "done");
        if (notDone.length)
          v(
            "policy:dependencies-done",
            `item "${item.id}" depends on unfinished ${notDone.join(", ")}`,
            `finish ${notDone.join(", ")} first`,
          );
        break;
      }
      case "custom":
        if (!fresh.some((e) => e.kind === `policy:${p.id}`))
          v(
            `policy:custom:${p.id}`,
            `item "${item.id}" has not satisfied "${p.description}"`,
            `attach evidence { kind: "policy:${p.id}" } when it is satisfied`,
          );
        break;
    }
  }
  return out;
}

export function assertPolicies(
  state: WorkflowState,
  item: WorkItem,
  policies: Policy[],
  context: string,
): void {
  const unmet = evaluatePolicies(state, item, policies);
  if (unmet.length) {
    fail(
      "policy-unmet",
      `item "${item.id}" cannot ${context}: ${unmet.length} polic${unmet.length === 1 ? "y" : "ies"} unmet`,
      unmet.map((u) => u.fix).join("; "),
      { items: [item.id] },
    );
  }
}
