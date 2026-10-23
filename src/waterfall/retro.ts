import { applyAgreement, retireAgreement } from "../agreements.ts";
import { fail } from "../errors.ts";
import { getItem } from "../items.ts";
import { applyAction } from "../methodology.ts";
import { requireCap } from "../roles.ts";
import { appendEvent, nowOf } from "../state.ts";
import type { Ceremony, Lesson, LessonChange, Methodology, WorkflowState } from "../types.ts";
import { wantPhase } from "./ceremonies.ts";

const LESSON_SCOPES: readonly string[] = ["policy", "skill", "memory", "spec", "review"];
const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

type NewLesson = {
  text: string;
  scope: Lesson["scope"];
  from?: string;
  item?: string;
  suggestedChange?: LessonChange;
};
type Adopt = { id: string; suggestedChange?: LessonChange };

function validLessons(x: unknown): x is NewLesson[] {
  return (
    Array.isArray(x) &&
    x.every(
      (l) =>
        isObj(l) &&
        typeof l["text"] === "string" &&
        l["text"].trim() !== "" &&
        LESSON_SCOPES.includes(l["scope"] as string),
    )
  );
}

function assertRefs(state: WorkflowState, adopt: Adopt[], dismiss: string[]): void {
  const refs = [...adopt.map((a) => a.id), ...dismiss];
  const dupe = refs.find((r, i) => refs.indexOf(r) !== i);
  if (dupe !== undefined)
    fail(
      "invalid-input",
      `lesson "${dupe}" is referenced more than once`,
      "adopt or dismiss each lesson once",
    );
  for (const ref of refs) {
    const l = state.lessons.find((x) => x.id === ref);
    if (!l)
      fail(
        "invalid-input",
        `no lesson "${ref}"`,
        `raised lessons: ${
          state.lessons
            .filter((x) => x.status === "raised")
            .map((x) => x.id)
            .join(", ") || "(none)"
        }`,
      );
    if (l.status !== "raised")
      fail(
        "invalid-input",
        `lesson "${ref}" is already ${l.status}`,
        "only raised lessons can be adopted or dismissed",
      );
  }
}

/** Lessons, adoptions and agreements; never touches items, config or baselines. */
export function phaseRetrospective(methodology: () => Methodology): Ceremony {
  return (state, input) => {
    requireCap(state, input.by, "facilitate");
    const phase =
      input["phase"] === undefined ? undefined : wantPhase(state, input, "phaseRetrospective");
    const newLessons = input["lessons"] ?? [];
    if (!validLessons(newLessons))
      fail(
        "invalid-input",
        "phaseRetrospective.lessons entries need a text and a scope",
        `scope is one of: ${LESSON_SCOPES.join(", ")}`,
      );
    const roleIds = ["human", ...Object.keys(state.roles)];
    for (const l of newLessons) {
      if (l.from !== undefined && (typeof l.from !== "string" || !roleIds.includes(l.from)))
        fail(
          "invalid-input",
          `lesson from ${JSON.stringify(l.from)} is not a role`,
          `from is "human" or one of the roles: ${Object.keys(state.roles).join(", ") || "(none)"}`,
        );
      if (l.item !== undefined) {
        if (typeof l.item !== "string")
          fail(
            "invalid-input",
            "lesson item must be an item id",
            "name an item with addItem first",
          );
        getItem(state, l.item);
      }
    }
    const adopt = (input["adopt"] ?? []) as Adopt[];
    const dismiss = (input["dismiss"] ?? []) as string[];
    if (
      !Array.isArray(adopt) ||
      !adopt.every((a) => isObj(a) && typeof a["id"] === "string") ||
      !Array.isArray(dismiss) ||
      !dismiss.every((d) => typeof d === "string")
    )
      fail(
        "invalid-input",
        "phaseRetrospective.adopt must be [{ id, suggestedChange? }] and dismiss a string[]",
        'e.g. { "adopt": [{ "id": "L1" }], "dismiss": ["L2"] }',
      );
    assertRefs(state, adopt, dismiss);
    const retireRaw: unknown = input["retire"] ?? [];
    if (
      !Array.isArray(retireRaw) ||
      !retireRaw.every((x) => typeof x === "string") ||
      retireRaw.some((x, i) => retireRaw.indexOf(x) !== i)
    )
      fail(
        "invalid-input",
        "phaseRetrospective.retire must be a list of distinct agreement texts",
        'e.g. { "retire": ["qa reads the srs"] }; each agreement once',
      );
    const retire = retireRaw as string[];
    return applyAction(
      state,
      methodology(),
      { type: "ceremony.phaseRetrospective", by: input.by, payload: input },
      (s0) => {
        let s = s0;
        const now = nowOf(input.now);
        const agreements: string[] = [];
        const agree = (ch: LessonChange | undefined) => {
          if (!ch || ch.kind !== "agreement") return;
          s = applyAgreement(s, ch, input.by, now);
          agreements.push(ch.text);
        };
        const created: string[] = [];
        for (const l of newLessons) {
          const id = `L${s.lessons.length + 1}`;
          const lesson: Lesson = {
            id,
            at: now,
            text: l.text,
            scope: l.scope,
            status: "adopted",
            from: l.from ?? input.by,
          };
          if (l.item !== undefined) lesson.item = l.item;
          if (l.suggestedChange) lesson.suggestedChange = l.suggestedChange;
          s = { ...s, lessons: [...s.lessons, lesson] };
          created.push(id);
          agree(l.suggestedChange);
        }
        const adopted: string[] = [];
        for (const a of adopt) {
          s = {
            ...s,
            lessons: s.lessons.map((x) =>
              x.id === a.id
                ? {
                    ...x,
                    status: "adopted" as const,
                    ...(a.suggestedChange ? { suggestedChange: a.suggestedChange } : {}),
                  }
                : x,
            ),
          };
          adopted.push(a.id);
          agree(a.suggestedChange ?? s.lessons.find((x) => x.id === a.id)?.suggestedChange);
        }
        for (const d of dismiss)
          s = {
            ...s,
            lessons: s.lessons.map((x) =>
              x.id === d ? { ...x, status: "dismissed" as const } : x,
            ),
          };
        for (const text of retire) s = retireAgreement(s, text, input.by, now);
        return appendEvent(
          s,
          "phase.retrospective",
          input.by,
          {
            phase: phase?.id ?? null,
            lessons: created,
            adopted,
            dismissed: dismiss,
            agreements,
            retired: retire,
          },
          now,
        );
      },
    );
  };
}
