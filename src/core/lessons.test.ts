import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLessonInput } from "./lessons.ts";
import { createState } from "./state.ts";
import { WorkflowError } from "./errors.ts";

const T = "2026-10-24T00:00:00.000Z";
const s = createState({ methodology: "kanban", config: {}, stages: [], roles: [], now: T });
const err = (input: Record<string, unknown>, ceremony: string) => {
  try {
    parseLessonInput(s, input, ceremony);
  } catch (e) {
    return e as WorkflowError;
  }
  throw new Error("did not throw");
};

test("parseLessonInput names the ceremony and says how to fix each malformed key", () => {
  const lessons = err({ lessons: [{ text: "x", scope: "nope" }] }, "service-delivery-review");
  assert.equal(lessons.code, "invalid-input");
  assert.match(
    lessons.message,
    /^service-delivery-review\.lessons entries need a text and a scope/,
  );
  assert.match(lessons.fix, /scope is one of: policy, skill, memory, spec, review/);
  const adopt = err({ adopt: [{ nope: 1 }] }, "retro");
  assert.match(adopt.message, /^retro\.adopt must be/);
  const retire = err({ retire: ["a", "a"] }, "phaseRetrospective");
  assert.match(retire.message, /^phaseRetrospective\.retire must be a list of distinct/);
  assert.match(retire.fix, /qa reads the srs/);
  assert.equal(err({ dismiss: ["L1"] }, "retro").message, 'no lesson "L1"');
  const from = err({ lessons: [{ text: "x", scope: "spec", from: "ghost" }] }, "retro");
  assert.match(from.message, /is not a role/);
  assert.deepEqual(parseLessonInput(s, {}, "retro"), {
    lessons: [],
    adopt: [],
    dismiss: [],
    retire: [],
  });
});
