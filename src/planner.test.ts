import { test } from "node:test";
import assert from "node:assert/strict";
import { createState } from "./state.ts";
import { addItem, getItem, moveItem, raiseBlocker } from "./items.ts";
import { assignRole, openIteration, plan, resourceCapsFor, toExNodes } from "./planner.ts";
import { WorkflowError } from "./errors.ts";
import type { Methodology, PlannerOptions, Role, Stage, WorkflowState } from "./types.ts";

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

function sprintWith(
  budget: { tokens?: number; turns?: number; wallclockMs?: number },
  ids: string[],
) {
  let s = createState({
    methodology: "kanban",
    config: {},
    stages,
    roles: [r("dev", ["deliver"])],
    now: T0,
  });
  ids.forEach((id, n) => {
    s = addItem(s, { id, title: id, priority: 10 - n, weight: 1 }, "po", T0);
    s = { ...s, items: { ...s.items, [id]: { ...s.items[id]!, iteration: "S1" } } };
  });
  return {
    ...s,
    iterations: [
      {
        id: "S1",
        goal: "g",
        budget,
        spent: { tokens: 0, turns: 0, wallclockMs: 0 },
        startedAt: T0,
        committed: ids,
        carryover: [],
      },
    ],
  };
}

test("a turns budget gates dispatch: remaining turns minus in-flight, then budget-exhausted", () => {
  const s = sprintWith({ turns: 2 }, ["A", "B", "C"]);
  const r1 = plan(s, fakeMethodology(), { now: T0 });
  assert.deepEqual(
    r1.dispatched.map((d) => d.id),
    ["A", "B"],
  );
  assert.equal(r1.reason, "budget-exhausted");
  assert.deepEqual(r1.skipped, [
    { id: "C", reason: "budget", detail: "turns budget spent: 0 used + 2 in flight of 2" },
  ]);
  // A is complete (one turn used), B still in flight: the second turn is spoken for
  const done = moveItem(r1.state, "A", { stage: "done", status: "done" }, "dev", T0);
  const s2 = {
    ...done,
    iterations: done.iterations.map((it) => ({
      ...it,
      spent: { tokens: 10, turns: 1, wallclockMs: 10 },
    })),
  };
  const r2 = plan(s2, fakeMethodology(), { now: T0 });
  assert.equal(r2.dispatched.length, 0);
  assert.equal(r2.reason, "budget-exhausted");
});

test("a turns budget counts in-flight items by the committed list, not only item.iteration", () => {
  const s = sprintWith({ turns: 1 }, ["A", "B"]);
  const items = { ...s.items };
  for (const id of ["A", "B"]) {
    const { iteration: _iteration, ...rest } = items[id]!;
    items[id] = rest as (typeof items)[string];
  }
  items["A"] = { ...items["A"]!, status: "in_progress" };
  const res = plan({ ...s, items }, fakeMethodology(), { now: T0 });
  assert.equal(res.dispatched.length, 0);
  assert.equal(res.reason, "budget-exhausted");
  assert.deepEqual(
    res.skipped.map((x) => [x.id, x.reason]),
    [["B", "budget"]],
  );
});

test("a spent wall-clock budget gates dispatch", () => {
  const s = sprintWith({ wallclockMs: 100 }, ["A"]);
  const spent = {
    ...s,
    iterations: s.iterations.map((it) => ({
      ...it,
      spent: { tokens: 0, turns: 0, wallclockMs: 100 },
    })),
  };
  const res = plan(spent, fakeMethodology(), { now: T0 });
  assert.equal(res.dispatched.length, 0);
  assert.equal(res.reason, "budget-exhausted");
  assert.equal(res.skipped[0]!.detail, "wall-clock budget spent");
});

test("an iteration in closing answers budget-exhausted, not no-candidates", () => {
  const s = sprintWith({ tokens: 100 }, ["A"]);
  const closing = { ...s, iterations: s.iterations.map((it) => ({ ...it, closing: true })) };
  const m = fakeMethodology({ candidates: () => [] });
  assert.equal(plan(closing, m).reason, "budget-exhausted");
  assert.equal(plan(s, m).reason, "no-candidates");
});

test("plan takes fallbackTokensPerWeight and estimateMode from PlannerOptions, PlanOptions wins", () => {
  const s = sprintWith({ tokens: 100 }, ["A"]);
  const po = fakeMethodology({
    plannerOptions: () => ({
      schedulerMode: "throughput",
      concurrencyCap: 10,
      fallbackTokensPerWeight: 50,
    }),
  });
  assert.deepEqual(
    plan(s, po, { now: T0 }).dispatched.map((d) => d.id),
    ["A"],
  );
  assert.equal(plan(s, po, { now: T0, fallbackTokensPerWeight: 500 }).reason, "budget-exhausted");
  // per-call mode prices a candidate at one call regardless of weight
  const perCall = fakeMethodology({
    plannerOptions: () => ({ schedulerMode: "throughput", estimateMode: "per-call" }),
  });
  const heavy = sprintWith({ tokens: 100 }, ["A"]);
  const w = { ...heavy, items: { ...heavy.items, A: { ...heavy.items["A"]!, weight: 9 } } };
  assert.equal(plan(w, perCall, { now: T0, fallbackTokensPerWeight: 60 }).dispatched.length, 1);
});

test("plan wraps ex-flow errors", () => {
  let s = seed();
  s = { ...s, items: { ...s.items, A: { ...s.items["A"]!, dependsOn: ["B"] } } }; // A↔B cycle
  assert.throws(
    () => plan(s, fakeMethodology(), { now: T0 }),
    (e: unknown) => e instanceof WorkflowError && e.code === "planner-error",
  );
});

const H0 = "2026-10-22T00:00:00.000Z";
const hookStages: Stage[] = [
  { id: "queue", name: "Queue", entryPolicy: [], exitPolicy: [] },
  { id: "work", name: "Work", wipLimit: 1, entryPolicy: [], exitPolicy: [] },
  { id: "done", name: "Done", entryPolicy: [], exitPolicy: [] },
];
const devRole: Role = {
  id: "dev",
  name: "dev",
  modelTier: "small",
  capabilities: ["deliver"],
  canApprove: [],
  inputs: [],
  outputs: [],
  do_not: [],
};
const hooked = (over: Partial<PlannerOptions>): Methodology => ({
  name: "kanban",
  vocabulary: {} as Methodology["vocabulary"],
  validateConfig: (c) => c,
  defaultStages: () => hookStages,
  defaultRoles: () => [devRole],
  requiredCapabilities: ["deliver"],
  exclusiveCapabilities: [],
  plannerOptions: () => ({ schedulerMode: "level", ...over }),
  candidates: (s) =>
    Object.values(s.items).filter((i) => i.status === "todo" || i.status === "review"),
  invariants: () => [],
  ceremonies: {},
  rules: [],
  metrics: () => ({}),
  humanDefaults: { gates: "none" },
});
function threeQueued() {
  let s = createState({
    methodology: "kanban",
    config: {},
    stages: hookStages,
    roles: [devRole],
    now: H0,
  });
  s = addItem(s, { id: "A", title: "a", priority: 5 }, "h", H0);
  s = addItem(s, { id: "B", title: "b", priority: 1 }, "h", H0);
  s = addItem(s, { id: "C", title: "c", priority: 1 }, "h", H0);
  return s;
}

test("dispatchStage as a function pulls queued items into the stage it names", () => {
  const m = hooked({ dispatchStage: (i) => (i.stage === "queue" ? "work" : undefined) });
  const res = plan(threeQueued(), m, { now: H0 });
  assert.deepEqual(
    res.dispatched.map((d) => d.id),
    ["A"],
  ); // work.wipLimit is 1
  assert.equal(res.state.items["A"]!.stage, "work");
  assert.equal(res.state.items["A"]!.status, "in_progress");
  assert.equal(res.reason, "wip-full");
});

test("skipped reports a wip skip with the stage id, in the result and in the planner.resolved event", () => {
  const m = hooked({ dispatchStage: (i) => (i.stage === "queue" ? "work" : undefined) });
  const res = plan(threeQueued(), m, { now: H0 });
  assert.deepEqual(new Set(res.skipped.map((x) => x.id)), new Set(["B", "C"]));
  assert.ok(res.skipped.every((x) => x.reason === "wip"));
  assert.match(res.skipped[0]!.detail, /"work"/);
  const ev = res.state.events[res.state.events.length - 1]!;
  assert.equal(ev.type, "planner.resolved");
  assert.deepEqual((ev.payload as { skipped: unknown }).skipped, res.skipped);
});

test("an entry policy does not apply to a question item", () => {
  const stages = hookStages.map((st) =>
    st.id === "work" ? { ...st, entryPolicy: [{ kind: "estimate-present" as const }] } : st,
  );
  let s = createState({ methodology: "kanban", config: {}, stages, roles: [devRole], now: H0 });
  s = addItem(s, { id: "Q", title: "q", type: "question" }, "h", H0);
  s = addItem(s, { id: "A", title: "a" }, "h", H0);
  const m = hooked({ dispatchStage: (i) => (i.stage === "queue" ? "work" : undefined) });
  const res = plan(s, m, { now: H0 });
  assert.deepEqual(
    res.dispatched.map((d) => d.id),
    ["Q"],
  );
  assert.deepEqual(
    res.skipped.map((x) => [x.id, x.reason]),
    [["A", "entry-policy"]],
  );
});

test("priorityOf overrides item.priority and tieBreaker orders equal priorities", () => {
  const byC = hooked({ priorityOf: (i) => (i.id === "C" ? 100 : i.priority) });
  assert.deepEqual(
    plan(threeQueued(), byC, { now: H0 }).dispatched.map((d) => d.id),
    ["C", "A", "B"],
  );
  const reverseId = hooked({ tieBreaker: (a, b) => b.id.localeCompare(a.id) });
  assert.deepEqual(
    plan(threeQueued(), reverseId, { now: H0 }).dispatched.map((d) => d.id),
    ["A", "C", "B"],
  );
});

test("wipCounts makes blocked work occupy a slot and wipLimitOf lets an item bypass it", () => {
  let s = createState({
    methodology: "kanban",
    config: {},
    stages: hookStages,
    roles: [devRole],
    now: H0,
  });
  s = addItem(s, { id: "A", title: "a", stage: "work" }, "h", H0);
  s = raiseBlocker(s, "A", "waiting", "owner", "h", H0);
  s = addItem(s, { id: "B", title: "b" }, "h", H0);
  const pull = { dispatchStage: () => "work" } as const;
  assert.deepEqual(
    plan(s, hooked(pull), { now: H0 }).dispatched.map((d) => d.id),
    ["B"],
  );
  const counted = hooked({ ...pull, wipCounts: ["in_progress", "blocked"] });
  const res = plan(s, counted, { now: H0 });
  assert.deepEqual(res.dispatched, []);
  assert.equal(res.reason, "wip-full");
  const bypass = hooked({
    ...pull,
    wipCounts: ["in_progress", "blocked"],
    wipLimitOf: (st, i) => (i.id === "B" ? (st.wipLimit ?? 0) + 1 : st.wipLimit),
  });
  assert.deepEqual(
    plan(s, bypass, { now: H0 }).dispatched.map((d) => d.id),
    ["B"],
  );
});

test("an item queued in a full stage is not counted against itself", () => {
  let s = createState({
    methodology: "kanban",
    config: {},
    stages: hookStages,
    roles: [devRole],
    now: H0,
  });
  s = addItem(s, { id: "A", title: "a", stage: "work" }, "h", H0);
  const m = hooked({ wipCounts: ["todo", "in_progress"] });
  assert.deepEqual(
    plan(s, m, { now: H0 }).dispatched.map((d) => d.id),
    ["A"],
  );
});

test("roleFor picks the dispatch role before the deliver default; unknown ids fail resolvingly", () => {
  let s = createState({
    methodology: "waterfall",
    config: {},
    stages,
    roles: [r("dev", ["deliver"]), r("arch", ["deliver"]), r("qa", ["review"])],
    now: T0,
  });
  s = addItem(s, { id: "A", title: "a" }, "human", T0);
  s = addItem(s, { id: "B", title: "b" }, "human", T0);
  const item = getItem(s, "A");
  assert.equal(assignRole(s, item).id, "dev");
  assert.equal(assignRole(s, item, () => "arch").id, "arch");
  assert.equal(assignRole(s, item, () => undefined).id, "dev");
  assert.throws(
    () => assignRole(s, item, () => "nobody"),
    (e: unknown) =>
      e instanceof WorkflowError &&
      e.code === "unknown-role" &&
      /"nobody"/.test(e.message) &&
      /dev, arch, qa/.test(e.fix),
  );
  const m: Methodology = {
    name: "waterfall",
    vocabulary: {} as Methodology["vocabulary"],
    validateConfig: (c) => c,
    defaultStages: () => stages,
    defaultRoles: () => [],
    requiredCapabilities: [],
    exclusiveCapabilities: [],
    plannerOptions: () => ({
      schedulerMode: "level",
      roleFor: (i) => (i.id === "B" ? "arch" : undefined),
    }),
    candidates: (st) => Object.values(st.items).filter((i) => i.status === "todo"),
    invariants: () => [],
    ceremonies: {},
    rules: [],
    metrics: () => ({}),
    humanDefaults: { gates: "none" },
  };
  const res = plan(s, m, { now: T0 });
  assert.deepEqual(Object.fromEntries(res.dispatched.map((d) => [d.id, d.role])), {
    A: "dev",
    B: "arch",
  });
  const nodes = toExNodes([item], s, undefined, () => "arch");
  assert.equal(nodes[0]!.resourceClass, "arch");
});
