import { test } from "node:test";
import assert from "node:assert/strict";
import { createState } from "./state.ts";
import { addItem, getItem, moveItem } from "./items.ts";
import { assignRole, openIteration, plan, resourceCapsFor, toExNodes } from "./planner.ts";
import { WorkflowError } from "./errors.ts";
import type { Methodology, Role, Stage, WorkflowState } from "./types.ts";

const T0 = "2026-10-19T00:00:00.000Z";
const stages: Stage[] = [
  { id: "todo", name: "To do", entryPolicy: [], exitPolicy: [] },
  { id: "done", name: "Done", entryPolicy: [], exitPolicy: [] },
];
const r = (id: string, caps: Role["capabilities"], extra: Partial<Role> = {}): Role => ({
  id,
  name: id,
  modelTier: "small",
  capabilities: caps,
  canApprove: [],
  inputs: [],
  outputs: [],
  do_not: [],
  ...extra,
});
const dev = r("dev", ["deliver"], { maxConcurrent: 2 });
const reviewer = r("reviewer", ["review"]);

const fakeMethodology = (opts: Partial<Methodology> = {}): Methodology => ({
  name: "kanban",
  vocabulary: {} as Methodology["vocabulary"],
  validateConfig: (c) => c,
  defaultStages: () => stages,
  defaultRoles: () => [dev],
  requiredCapabilities: ["deliver"],
  exclusiveCapabilities: [],
  plannerOptions: () => ({ schedulerMode: "throughput", concurrencyCap: 10 }),
  candidates: (s) =>
    Object.values(s.items).filter((i) => i.status === "todo" || i.status === "review"),
  invariants: () => [],
  ceremonies: {},
  rules: [],
  metrics: () => ({}),
  humanDefaults: { gates: "none" },
  ...opts,
});

function seed(): WorkflowState {
  let s = createState({
    methodology: "kanban",
    config: {},
    stages,
    roles: [dev, reviewer],
    now: T0,
  });
  s = addItem(s, { id: "A", title: "a", priority: 1, weight: 1 }, "po", T0);
  s = addItem(s, { id: "B", title: "b", dependsOn: ["A"], priority: 5, weight: 1 }, "po", T0);
  s = addItem(
    s,
    { id: "C", title: "c", priority: 3, weight: 2, deadline: "2026-11-01T00:00:00.000Z" },
    "po",
    T0,
  );
  return s;
}

test("toExNodes drops done dependencies and maps deadline/resourceClass", () => {
  let s = seed();
  s = moveItem(s, "A", { stage: "done", status: "done" }, "dev", T0);
  const nodes = toExNodes([getItem(s, "B"), getItem(s, "C")], s);
  assert.deepEqual(
    nodes.map((n) => n.id),
    ["B", "C"],
  );
  assert.deepEqual(nodes[0]!.dependsOn, []);
  assert.equal(nodes[0]!.resourceClass, "dev");
  assert.equal(nodes[1]!.deadline, Date.parse("2026-11-01T00:00:00.000Z"));
  assert.deepEqual(nodes[0]!.data, { id: "B" });
  assert.deepEqual(resourceCapsFor(s), { dev: 2 });
});

test("assignRole prefers the item's role, else deliver/review by status, never the author for review", () => {
  let s = seed();
  assert.equal(assignRole(s, getItem(s, "A")).id, "dev");
  s = moveItem(s, "A", { status: "in_progress" }, "dev", T0);
  s = moveItem(s, "A", { status: "review" }, "dev", T0);
  assert.equal(assignRole(s, getItem(s, "A")).id, "reviewer");
  const noReviewer = { ...s, roles: { dev } };
  assert.throws(
    () => assignRole(noReviewer, getItem(noReviewer, "A")),
    (e: unknown) => e instanceof WorkflowError && e.code === "missing-capability",
  );
  const devrev = r("devrev", ["deliver", "review"]);
  const lone = { ...s, roles: { devrev } };
  assert.equal(assignRole(lone, getItem(lone, "A")).id, "devrev");
});

test("plan never dispatches an item whose dependency is not done", () => {
  const s = seed();
  const res = plan(s, fakeMethodology(), { now: T0 });
  assert.deepEqual(new Set(res.dispatched.map((i) => i.id)), new Set(["A", "C"]));
  assert.equal(getItem(res.state, "A").status, "in_progress");
  assert.equal(getItem(res.state, "A").role, "dev");
  assert.equal(getItem(res.state, "B").status, "todo");
  const ev = res.state.events.at(-1)!;
  assert.equal(ev.type, "planner.resolved");
  assert.deepEqual(
    new Set((ev.payload as { dispatched: string[] }).dispatched),
    new Set(["A", "C"]),
  );
});

test("plan respects resourceCaps, concurrencyCap, max and reports reasons", () => {
  let s = seed();
  s = addItem(s, { id: "D", title: "d", priority: 2, weight: 1 }, "po", T0);
  const capped = plan(
    s,
    fakeMethodology({ plannerOptions: () => ({ schedulerMode: "throughput", concurrencyCap: 1 }) }),
    { now: T0 },
  );
  assert.equal(capped.dispatched.length, 1);
  assert.equal(capped.dispatched[0]!.id, "C"); // highest priority among ready: C=3 > D=2 > A=1
  const maxed = plan(s, fakeMethodology(), { max: 2, now: T0 });
  assert.equal(maxed.dispatched.length, 2);
  const byRole = plan(s, fakeMethodology(), { now: T0 }); // dev.maxConcurrent = 2 → only 2 of A, C, D
  assert.equal(byRole.dispatched.length, 2);
  assert.equal(byRole.reason, "wip-full");
  const empty = plan(
    createState({ methodology: "kanban", config: {}, stages, roles: [dev], now: T0 }),
    fakeMethodology(),
    { now: T0 },
  );
  assert.deepEqual(empty.dispatched, []);
  assert.equal(empty.reason, "no-candidates");
});

test("plan stops at the open iteration's remaining budget", () => {
  let s = seed();
  s = {
    ...s,
    iterations: [
      {
        id: "S1",
        goal: "g",
        budget: { tokens: 25000 },
        spent: { tokens: 0, turns: 0, wallclockMs: 0 },
        startedAt: T0,
        committed: ["A", "C"],
        carryover: [],
      },
    ],
  };
  assert.equal(openIteration(s)!.id, "S1");
  // fallback estimate 20000/weight: C (weight 2) = 40000 > 25000 → skipped; A (weight 1) = 20000 fits
  const res = plan(s, fakeMethodology(), { now: T0 });
  assert.deepEqual(
    res.dispatched.map((i) => i.id),
    ["A"],
  );
  assert.equal(res.reason, "budget-exhausted");
});

test("plan wraps ex-flow errors", () => {
  let s = seed();
  s = { ...s, items: { ...s.items, A: { ...s.items["A"]!, dependsOn: ["B"] } } }; // A↔B cycle
  assert.throws(
    () => plan(s, fakeMethodology(), { now: T0 }),
    (e: unknown) => e instanceof WorkflowError && e.code === "planner-error",
  );
});
