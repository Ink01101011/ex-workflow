import { test } from "node:test";
import assert from "node:assert/strict";
import { createState } from "../state.ts";
import { WorkflowError } from "../errors.ts";
import { addItem, editItem, getItem } from "./record.ts";
import { T0, base, code, stages } from "./fixtures.ts";

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

test("item.added carries phase and parent (null when unset)", () => {
  let s = createState({ methodology: "waterfall", config: {}, stages, roles: [], now: T0 });
  s = addItem(s, { id: "R1", title: "r", phase: "requirements" }, "human", T0);
  s = addItem(s, { id: "R1-q1", title: "q", type: "question", parent: "R1" }, "human", T0);
  s = addItem(s, { id: "X", title: "x" }, "human", T0);
  const added = s.events
    .filter((e) => e.type === "item.added")
    .map((e) => e.payload as { id: string; phase: string | null; parent: string | null });
  assert.deepEqual(
    added.map((p) => [p.id, p.phase, p.parent]),
    [
      ["R1", "requirements", null],
      ["R1-q1", null, "R1"],
      ["X", null, null],
    ],
  );
  assert.equal(getItem(s, "R1").phase, "requirements");
  assert.equal(getItem(s, "X").phase, undefined);
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
