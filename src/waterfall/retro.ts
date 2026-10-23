import { applyLessonInput, parseLessonInput } from "../lessons.ts";
import { applyAction } from "../methodology.ts";
import { requireCap } from "../roles.ts";
import { appendEvent, nowOf } from "../state.ts";
import type { Ceremony, Methodology } from "../types.ts";
import { wantPhase } from "./ceremonies.ts";

/** Lessons, adoptions and agreements; never touches items, config or baselines. */
export function phaseRetrospective(methodology: () => Methodology): Ceremony {
  return (state, input) => {
    requireCap(state, input.by, "facilitate");
    const phase =
      input["phase"] === undefined ? undefined : wantPhase(state, input, "phaseRetrospective");
    const parsed = parseLessonInput(state, input, "phaseRetrospective");
    return applyAction(
      state,
      methodology(),
      { type: "ceremony.phaseRetrospective", by: input.by, payload: input },
      (s0) => {
        let s = s0;
        const now = nowOf(input.now);
        const out = applyLessonInput(s, parsed, input.by, now);
        s = out.state;
        return appendEvent(
          s,
          "phase.retrospective",
          input.by,
          {
            phase: phase?.id ?? null,
            lessons: out.created,
            adopted: out.adopted.slice(out.created.length),
            dismissed: out.dismissed,
            agreements: out.agreements,
            retired: out.retired,
          },
          now,
        );
      },
    );
  };
}
