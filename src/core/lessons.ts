import { applyAgreement, retireAgreement } from "./agreements.ts";
import { fail } from "./errors.ts";
import { getItem } from "./items.ts";
import type { Lesson, LessonChange, WorkflowState } from "./types.ts";

const LESSON_SCOPES: readonly string[] = ["policy", "skill", "memory", "spec", "review"];
const RETIRE_EXAMPLE: Readonly<Record<string, string>> = {
  retro: "review in a fresh worker",
  phaseRetrospective: "qa reads the srs",
};
const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

export interface NewLesson {
  text: string;
  scope: Lesson["scope"];
  from?: string;
  item?: string;
  suggestedChange?: LessonChange;
}
export interface Adopt {
  id: string;
  suggestedChange?: LessonChange;
}
export interface LessonInput {
  lessons: NewLesson[];
  adopt: Adopt[];
  dismiss: string[];
  retire: string[];
}
export interface LessonOutcome {
  state: WorkflowState;
  /** ids of the lessons created by this input */
  created: string[];
  /** created ids first, then the adopted refs */
  adopted: string[];
  dismissed: string[];
  /** texts of the agreements added */
  agreements: string[];
  retired: string[];
}

/** Validates the lesson keys of a retrospective-style ceremony input; every failure names the ceremony. */
export function parseLessonInput(
  state: WorkflowState,
  input: Record<string, unknown>,
  ceremony: string,
): LessonInput {
  const lessons = input["lessons"] ?? [];
  if (
    !Array.isArray(lessons) ||
    !lessons.every(
      (l) =>
        isObj(l) &&
        typeof l["text"] === "string" &&
        l["text"].trim() !== "" &&
        LESSON_SCOPES.includes(l["scope"] as string),
    )
  )
    fail(
      "invalid-input",
      `${ceremony}.lessons entries need a text and a scope`,
      `scope is one of: ${LESSON_SCOPES.join(", ")}`,
    );
  const newLessons = lessons as NewLesson[];
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
        fail("invalid-input", "lesson item must be an item id", "name an item with addItem first");
      getItem(state, l.item);
    }
  }
  const adopt = input["adopt"] ?? [];
  const dismiss = input["dismiss"] ?? [];
  if (
    !Array.isArray(adopt) ||
    !adopt.every((a) => isObj(a) && typeof a["id"] === "string") ||
    !Array.isArray(dismiss) ||
    !dismiss.every((d) => typeof d === "string")
  )
    fail(
      "invalid-input",
      `${ceremony}.adopt must be [{ id, suggestedChange? }] and dismiss a string[]`,
      'e.g. { "adopt": [{ "id": "L1" }], "dismiss": ["L2"] }',
    );
  const refs = [...(adopt as Adopt[]).map((a) => a.id), ...(dismiss as string[])];
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
  const retire: unknown = input["retire"] ?? [];
  if (
    !Array.isArray(retire) ||
    !retire.every((x) => typeof x === "string") ||
    retire.some((x, i) => retire.indexOf(x) !== i)
  )
    fail(
      "invalid-input",
      `${ceremony}.retire must be a list of distinct agreement texts`,
      `e.g. { "retire": ["${RETIRE_EXAMPLE[ceremony] ?? "review in a fresh worker"}"] }; each agreement once`,
    );
  return {
    lessons: newLessons,
    adopt: adopt as Adopt[],
    dismiss: dismiss as string[],
    retire: retire as string[],
  };
}

/**
 * Creates the new lessons as adopted, adopts and dismisses the referenced ones, retires agreements
 * and applies `agreement` changes; every other change kind goes to `applyChange` when given.
 */
export function applyLessonInput(
  state: WorkflowState,
  parsed: LessonInput,
  by: string,
  now: string,
  applyChange?: (s: WorkflowState, change: LessonChange) => WorkflowState | void,
): LessonOutcome {
  let s = state;
  const created: string[] = [];
  const adopted: string[] = [];
  const agreements: string[] = [];
  const change = (c: LessonChange | undefined) => {
    if (!c) return;
    if (c.kind === "agreement") {
      s = applyAgreement(s, c, by, now);
      agreements.push(c.text);
    } else if (applyChange) {
      s = applyChange(s, c) ?? s;
    }
  };
  for (const l of parsed.lessons) {
    const id = `L${s.lessons.length + 1}`;
    const lesson: Lesson = {
      id,
      at: now,
      text: l.text,
      scope: l.scope,
      status: "adopted",
      from: l.from ?? by,
    };
    if (l.item !== undefined) lesson.item = l.item;
    if (l.suggestedChange) lesson.suggestedChange = l.suggestedChange;
    s = { ...s, lessons: [...s.lessons, lesson] };
    created.push(id);
    adopted.push(id);
    change(l.suggestedChange);
  }
  for (const a of parsed.adopt) {
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
    change(a.suggestedChange ?? s.lessons.find((x) => x.id === a.id)?.suggestedChange);
  }
  for (const d of parsed.dismiss)
    s = {
      ...s,
      lessons: s.lessons.map((x) => (x.id === d ? { ...x, status: "dismissed" as const } : x)),
    };
  for (const text of parsed.retire) s = retireAgreement(s, text, by, now);
  return {
    state: s,
    created,
    adopted,
    dismissed: parsed.dismiss,
    agreements,
    retired: parsed.retire,
  };
}
