import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAgreement, retireAgreement } from "./agreements.ts";
import { createState } from "./state.ts";
import { WorkflowError } from "./errors.ts";
import type { WorkflowState } from "./types.ts";

const T = "2026-10-19T00:00:00.000Z";
const base = (): WorkflowState => ({
  ...createState({ methodology: "scrum", config: {}, stages: [], roles: [], now: T }),
  agreements: ["a", "b"],
});
const err = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e as WorkflowError;
  }
  throw new Error("did not throw");
};

test("applyAgreement appends, and is idempotent without an event", () => {
  const s = applyAgreement(base(), { text: "c" }, "sm", T);
  assert.deepEqual(s.agreements, ["a", "b", "c"]);
  const again = applyAgreement(s, { text: "c" }, "sm", T);
  assert.deepEqual(again.agreements, ["a", "b", "c"]);
  assert.equal(again.events.length, s.events.length);
});

test("applyAgreement with replaces removes the old text, appends the new, records the event", () => {
  const s = applyAgreement(base(), { text: "a2", replaces: "a" }, "sm", T);
  assert.deepEqual(s.agreements, ["b", "a2"]);
  assert.deepEqual(s.events.at(-1)!.payload, { text: "a", replacedBy: "a2" });
  assert.equal(s.events.at(-1)!.type, "agreement.retired");
});

test("replacing an unknown agreement fails invalid-input listing the current ones", () => {
  const e = err(() => applyAgreement(base(), { text: "x", replaces: "zzz" }, "sm", T));
  assert.equal(e.code, "invalid-input");
  assert.match(e.fix, /"a", "b"/);
});

test("retireAgreement removes and records; an unknown text fails", () => {
  const s = retireAgreement(base(), "a", "sm", T);
  assert.deepEqual(s.agreements, ["b"]);
  assert.deepEqual(s.events.at(-1)!.payload, { text: "a", replacedBy: null });
  const e = err(() => retireAgreement(base(), "nope", "sm", T));
  assert.equal(e.code, "invalid-input");
  assert.match(e.fix, /current agreements/);
});
