import { test } from "node:test";
import assert from "node:assert/strict";
import { appendEvent, createState, lastEvent, nowOf } from "./state.ts";
import type { Role, Stage } from "./types.ts";

const T0 = "2026-10-19T00:00:00.000Z";
const stages: Stage[] = [
  { id: "todo", name: "To do", entryPolicy: [], exitPolicy: [] },
  { id: "done", name: "Done", entryPolicy: [], exitPolicy: [] },
];
const roles: Role[] = [
  {
    id: "dev",
    name: "Developer",
    modelTier: "small",
    capabilities: ["deliver"],
    canApprove: [],
    inputs: [],
    outputs: [],
    do_not: [],
  },
];

test("createState records a state.created event with seq 1", () => {
  const s = createState({ methodology: "scrum", config: {}, stages, roles, now: T0 });
  assert.equal(s.version, 1);
  assert.equal(s.methodology, "scrum");
  assert.deepEqual(Object.keys(s.roles), ["dev"]);
  assert.equal(s.events.length, 1);
  assert.deepEqual(s.events[0], {
    seq: 1,
    at: T0,
    type: "state.created",
    by: "system",
    payload: { methodology: "scrum" },
  });
  assert.deepEqual(s.items, {});
  assert.deepEqual(s.pending, []);
});

test("createState rejects duplicate stage or role ids", () => {
  assert.throws(
    () => createState({ methodology: "scrum", config: {}, stages: [...stages, stages[0]!], roles }),
    /duplicate stage/,
  );
  assert.throws(
    () => createState({ methodology: "scrum", config: {}, stages, roles: [...roles, roles[0]!] }),
    /duplicate role/,
  );
});

test("appendEvent is immutable and increments seq", () => {
  const s0 = createState({ methodology: "scrum", config: {}, stages, roles, now: T0 });
  const s1 = appendEvent(s0, "item.added", "po", { id: "A" }, "2026-10-19T00:00:01.000Z");
  assert.equal(s0.events.length, 1);
  assert.equal(s1.events.length, 2);
  assert.equal(s1.events[1]!.seq, 2);
  assert.equal(lastEvent(s1, "item.added")!.at, "2026-10-19T00:00:01.000Z");
  assert.equal(lastEvent(s1, "nothing"), undefined);
});

test("nowOf returns the given time or a valid ISO string", () => {
  assert.equal(nowOf(T0), T0);
  assert.ok(!Number.isNaN(Date.parse(nowOf())));
});
