import type { Rule } from "../types.ts";
export function experimentationRules(): Rule[] {
  return [
    {
      id: "experimentation-lifecycle",
      severity: "error",
      check(state, action) {
        const errors: string[] = [];
        const e = state.experimentation;
        const payload = action.payload as
          | {
              item?: string;
              handoff?: { verdict?: string; produced?: { kind: string; ref: string }[] };
            }
          | undefined;
        if (action.type === "item.complete") {
          if (!["done", "needs-review"].includes(payload?.handoff?.verdict ?? "done"))
            errors.push(
              "unsupported completion verdict: terminate this attempt with final usage and log, then freeze a new experiment for retries",
            );
          const c =
            e && Object.values(e.candidates).find((candidate) => candidate.item === payload?.item);
          if (!c || !["submitted", "validated"].includes(c.status))
            errors.push("submit the candidate SHA and benchmark before completing work");
          if (
            c?.status === "submitted" &&
            !payload?.handoff?.produced?.some((p) => p.kind === "candidate-sha" && p.ref === c.sha)
          )
            errors.push("handoff must retain the exact submitted candidate SHA");
        }
        return errors.map((message) => ({
          rule: "experimentation-lifecycle",
          severity: "error" as const,
          message,
          fix: "follow the frozen experimentation lifecycle",
        }));
      },
    },
  ];
}
