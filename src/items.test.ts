import { test } from "node:test";
import assert from "node:assert/strict";
import { createState } from "./state.ts";
import {
  addEvidence,
  addItem,
  clearBlocker,
  editItem,
  getItem,
  isTerminalStage,
  moveItem,
  nextStageOf,
  raiseBlocker,
  stageOf,
} from "./items.ts";
import { WorkflowError } from "./errors.ts";
import type { Role, Stage, WorkflowState } from "./types.ts";

const T0 = "2026-10-19T00:00:00.000Z";
const stages: Stage[] = [
  { id: "backlog", name: "Backlog", entryPolicy: [], exitPolicy: [] },
  { id: "doing", name: "Doing", entryPolicy: [], exitPolicy: [] },
  { id: "done", name: "Done", entryPolicy: [], exitPolicy: [] },
];
const dev: Role = {
  id: "dev",
  name: "Dev",
  modelTier: "small",
  capabilities: ["deliver"],
  canApprove: [],
  inputs: [],
  outputs: [],
  do_not: [],
};
const base = () => createState({ methodology: "scrum", config: {}, stages, roles: [dev], now: T0 });
const code = (e: unknown) => (e instanceof WorkflowError ? e.code : String(e));

test("stage helpers", () => {
  const s = base();
  assert.equal(stageOf(s, "doing").name, "Doing");
  assert.equal(nextStageOf(s, "doing")!.id, "done");
  assert.equal(nextStageOf(s, "done"), undefined);
  assert.equal(isTerminalStage(s, "done"), true);
  assert.throws(
    () => stageOf(s, "nope"),
    (e) => code(e) === "unknown-stage",
  );
});

test("addItem defaults and validates", () => {
  const s = addItem(base(), { id: "A", title: "First" }, "po", T0);
  const a = getItem(s, "A");
  assert.equal(a.type, "task");
  assert.equal(a.stage, "backlog");
  assert.equal(a.status, "todo");
  assert.deepEqual(a.dependsOn, []);
  assert.equal(s.events.at(-1)!.type, "item.added");
  assert.throws(
    () => addItem(s, { id: "A", title: "dup" }, "po"),
    (e) => code(e) === "duplicate-item",
  );
  assert.throws(
    () => addItem(s, { id: "B", title: "b", dependsOn: ["Z"] }, "po"),
    (e) => code(e) === "unknown-item",
  );
  assert.throws(
    () => addItem(s, { id: "B", title: "b", stage: "nope" }, "po"),
    (e) => code(e) === "unknown-stage",
  );
  assert.throws(
    () => addItem(s, { id: "B", title: "b", role: "ghost" }, "po"),
    (e) => code(e) === "unknown-role",
  );
  assert.throws(
    () => addItem(s, { id: "B", title: "b", parent: "Z" }, "po"),
    (e) => code(e) === "unknown-item",
  );
});

test("editItem records changed fields and rejects no-ops", () => {
  const s = addItem(base(), { id: "A", title: "First" }, "po", T0);
  const s2 = editItem(s, "A", { title: "Renamed", weight: 3 }, "po", T0);
  assert.equal(getItem(s2, "A").weight, 3);
  assert.deepEqual((s2.events.at(-1)!.payload as { changed: string[] }).changed, [
    "title",
    "weight",
  ]);
  assert.throws(
    () => editItem(s2, "A", { title: "Renamed" }, "po"),
    (e) => code(e) === "no-op",
  );
});

test("moveItem records a transition and guards terminal statuses", () => {
  const s = addItem(base(), { id: "A", title: "First" }, "po", T0);
  const s2 = moveItem(
    s,
    "A",
    { stage: "doing", status: "in_progress" },
    "dev",
    "2026-10-19T01:00:00.000Z",
  );
  const a = getItem(s2, "A");
  assert.equal(a.stage, "doing");
  assert.deepEqual(a.transitions[0], {
    from: { stage: "backlog", status: "todo" },
    to: { stage: "doing", status: "in_progress" },
    at: "2026-10-19T01:00:00.000Z",
    by: "dev",
  });
  const s3 = moveItem(s2, "A", { stage: "done", status: "done" }, "dev", T0);
  assert.throws(
    () => moveItem(s3, "A", { status: "todo" }, "dev"),
    (e) => code(e) === "invalid-transition",
  );
  assert.throws(
    () => moveItem(s2, "A", { stage: "doing", status: "in_progress" }, "dev"),
    (e) => code(e) === "no-op",
  );
});

test("evidence and blockers", () => {
  let s = addItem(base(), { id: "A", title: "First" }, "po", T0);
  s = addEvidence(s, "A", { kind: "test-output", ref: "ci#1", by: "dev" }, T0);
  assert.deepEqual(getItem(s, "A").evidence[0], {
    kind: "test-output",
    ref: "ci#1",
    by: "dev",
    at: T0,
  });
  s = raiseBlocker(s, "A", "waiting on API key", "po", "dev", T0);
  assert.equal(getItem(s, "A").status, "blocked");
  assert.equal(getItem(s, "A").blockers[0]!.id, "A-b1");
  assert.equal(s.events.at(-1)!.type, "blocker.raised");
  s = clearBlocker(s, "A", "A-b1", "po", "2026-10-19T02:00:00.000Z");
  assert.equal(getItem(s, "A").status, "todo");
  assert.equal(getItem(s, "A").blockers[0]!.clearedAt, "2026-10-19T02:00:00.000Z");
  assert.throws(
    () => clearBlocker(s, "A", "A-b9", "po"),
    (e) => code(e) === "invalid-input",
  );
});

const tr = (s: WorkflowState) =>
  (s.events.at(-1)!.payload as Record<string, unknown>)["transition"];

test("blocker events carry the item transition they caused, or null", () => {
  let s = addItem(base(), { id: "A", title: "First" }, "po", T0);
  s = raiseBlocker(s, "A", "one", "po", "dev", T0);
  assert.deepEqual(tr(s), {
    from: { stage: "backlog", status: "todo" },
    to: { stage: "backlog", status: "blocked" },
  });
  s = raiseBlocker(s, "A", "two", "po", "dev", T0);
  assert.equal(tr(s), null);
  s = clearBlocker(s, "A", "A-b1", "po", T0);
  assert.equal(tr(s), null);
  s = clearBlocker(s, "A", "A-b2", "po", T0);
  assert.deepEqual(tr(s), {
    from: { stage: "backlog", status: "blocked" },
    to: { stage: "backlog", status: "todo" },
  });
});

test("clearing a blocker on an in_progress item re-queues it in the stage it was pulled from", () => {
  let s = addItem(base(), { id: "A", title: "First" }, "po", T0);
  s = moveItem(s, "A", { stage: "doing", status: "in_progress" }, "dev", T0);
  s = raiseBlocker(s, "A", "stuck", "po", "dev", T0);
  s = clearBlocker(s, "A", "A-b1", "po", T0);
  assert.equal(getItem(s, "A").stage, "backlog");
  assert.equal(getItem(s, "A").status, "todo");
});

test("ids are validated: no path separators, dots-only, prototype names or empties", () => {
  const s = createState({ methodology: "kanban", config: {}, stages, roles: [], now: T0 });
  for (const id of [
    "../evil",
    "a/b",
    "a\\b",
    "x..y",
    "",
    "__proto__",
    "constructor",
    "prototype",
    ".hidden",
    "a b",
  ]) {
    assert.throws(
      () => addItem(s, { id, title: "t" }, "po", T0),
      (e: unknown) =>
        e instanceof WorkflowError && e.code === "invalid-input" && /letters, digits/.test(e.fix),
      id,
    );
  }
  assert.doesNotThrow(() => addItem(s, { id: "CART-12.a_b", title: "t" }, "po", T0));
  assert.throws(
    () => getItem(s, "constructor"),
    (e: unknown) => e instanceof WorkflowError && e.code === "unknown-item",
  );
});
