import { test } from "node:test";
import assert from "node:assert/strict";
import { createState } from "./state.ts";
import { addEvidence, addItem, moveItem } from "./items.ts";
import { assertPolicies, evaluatePolicies } from "./policies.ts";
import { WorkflowError } from "./errors.ts";
import type { Policy, Stage } from "./types.ts";

const T0 = "2026-10-19T00:00:00.000Z";
const stages: Stage[] = [
  { id: "todo", name: "To do", entryPolicy: [], exitPolicy: [] },
  { id: "done", name: "Done", entryPolicy: [], exitPolicy: [] },
];
const base = () => createState({ methodology: "scrum", config: {}, stages, roles: [], now: T0 });
const all: Policy[] = [
  { kind: "evidence", evidenceKind: "test-output" },
  { kind: "acceptance-written" },
  { kind: "estimate-present" },
  { kind: "no-open-blockers" },
  { kind: "dependencies-done" },
  { kind: "custom", id: "lint", description: "lint passes" },
];

test("every policy kind reports when unmet, with a fix", () => {
  let s = addItem(base(), { id: "D", title: "dep" }, "po", T0);
  s = addItem(s, { id: "A", title: "a", dependsOn: ["D"] }, "po", T0);
  const v = evaluatePolicies(s, s.items["A"]!, all);
  assert.deepEqual(
    v.map((x) => x.rule),
    [
      "policy:evidence",
      "policy:acceptance-written",
      "policy:estimate-present",
      "policy:dependencies-done",
      "policy:custom:lint",
    ],
  );
  assert.ok(v.every((x) => x.fix.length > 0 && x.item === "A" && x.severity === "error"));
});

test("policies pass when satisfied", () => {
  let s = addItem(base(), { id: "D", title: "dep" }, "po", T0);
  s = moveItem(s, "D", { stage: "done", status: "done" }, "dev", T0);
  s = addItem(
    s,
    { id: "A", title: "a", dependsOn: ["D"], acceptance: ["works"], weight: 2 },
    "po",
    T0,
  );
  s = addEvidence(s, "A", { kind: "test-output", ref: "ci", by: "dev" }, T0);
  s = addEvidence(s, "A", { kind: "policy:lint", ref: "ci", by: "dev" }, T0);
  assert.deepEqual(evaluatePolicies(s, s.items["A"]!, all), []);
  assert.doesNotThrow(() => assertPolicies(s, s.items["A"]!, all, "leave todo"));
});

test("assertPolicies throws policy-unmet naming all fixes", () => {
  const s = addItem(base(), { id: "A", title: "a" }, "po", T0);
  assert.throws(
    () => assertPolicies(s, s.items["A"]!, all.slice(0, 2), "leave todo"),
    (e: unknown) =>
      e instanceof WorkflowError &&
      e.code === "policy-unmet" &&
      /test-output/.test(e.fix) &&
      /acceptance/.test(e.fix),
  );
});
