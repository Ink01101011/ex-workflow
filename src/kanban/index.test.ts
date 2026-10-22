import { test } from "node:test";
import assert from "node:assert/strict";
import { timSort } from "exsorted";
import { init } from "../methodology.ts";
import { addItem, editItem, getItem, moveItem } from "../items.ts";
import { next } from "../brief.ts";
import { WorkflowError } from "../errors.ts";
import { DEFAULT_COLUMNS, validateKanbanConfig } from "./config.ts";
import { activeExpedites, commitmentColumn, deliveryColumn, onBoard } from "./columns.ts";
import { byClassThenAge, kanban, priorityByClass } from "./index.ts";

const T0 = "2026-10-22T00:00:00.000Z";
const T1 = "2026-10-22T01:00:00.000Z";

test("validateKanbanConfig applies defaults and names bad fields", () => {
  const c = validateKanbanConfig({});
  assert.deepEqual(c.columns, DEFAULT_COLUMNS);
  assert.deepEqual(c.classesOfService, {});
  assert.deepEqual(c.fairness, { aging: true, maxDeferralRounds: 5 });
  assert.equal(c.throughputWindowMs, 7 * 86_400_000);
  assert.equal(c.maxExpedite, 1);
  assert.throws(
    () => validateKanbanConfig({ columns: 5 }),
    (e: unknown) =>
      e instanceof WorkflowError && e.code === "config-invalid" && /columns/.test(e.message),
  );
  assert.throws(
    () =>
      validateKanbanConfig({
        columns: [
          { id: "a", policies: [] },
          { id: "a", policies: [] },
        ],
      }),
    (e: unknown) => e instanceof WorkflowError && /duplicate column id "a"/.test(e.message),
  );
  assert.throws(
    () => validateKanbanConfig({ columns: [{ id: "a", policies: [], wipLimit: 0 }] }),
    (e: unknown) => e instanceof WorkflowError && /wipLimit/.test(e.message),
  );
  assert.throws(
    () => validateKanbanConfig({ classesOfService: { gold: {} } }),
    (e: unknown) => e instanceof WorkflowError && /classesOfService\.gold/.test(e.message),
  );
  assert.throws(
    () =>
      validateKanbanConfig({
        classesOfService: { expedite: { sle: { percentile: 101, targetMs: 1 } } },
      }),
    (e: unknown) => e instanceof WorkflowError && /percentile/.test(e.message),
  );
  assert.throws(
    () => validateKanbanConfig({ cadences: { daily: {} } }),
    (e: unknown) => e instanceof WorkflowError && /cadences\.daily/.test(e.message),
  );
  assert.throws(
    () => validateKanbanConfig({ maxExpedite: 0 }),
    (e: unknown) => e instanceof WorkflowError && /maxExpedite/.test(e.message),
  );
  for (const bad of [["junk"], [{ kind: "evidence" }], [{ kind: "x" }]]) {
    assert.throws(
      () => validateKanbanConfig({ columns: [{ id: "a", policies: bad }] }),
      (e: unknown) =>
        e instanceof WorkflowError &&
        e.code === "config-invalid" &&
        /policies\[0\]/.test(e.message) &&
        e.fix !== "",
    );
  }
  const named = validateKanbanConfig({
    columns: [{ id: "x", policies: [{ kind: "acceptance-written" }] }],
  });
  assert.equal(named.columns[0]!.name, "x");
});

test("init with kanban builds the default five columns and three roles", () => {
  const { state, warnings } = init({ methodology: kanban(), config: {}, now: T0 });
  assert.deepEqual(
    state.stages.map((s) => s.id),
    ["options", "ready", "dev", "review", "done"],
  );
  assert.equal(state.stages[1]!.commitmentPoint, true);
  assert.equal(state.stages[4]!.deliveryPoint, true);
  assert.equal(state.stages[3]!.review, true);
  assert.deepEqual(state.stages[2]!.exitPolicy, [
    { kind: "evidence", evidenceKind: "test-output" },
  ]);
  assert.deepEqual(Object.keys(state.roles), [
    "service-request-manager",
    "service-delivery-manager",
    "worker",
  ]);
  assert.deepEqual(warnings, []);
  assert.equal(kanban().vocabulary.backlog, "Options");
  assert.equal(commitmentColumn(state).id, "ready");
  assert.equal(deliveryColumn(state).id, "done");
  assert.equal(kanban().humanDefaults.gates, "none");
});

test("init fails resolvingly when no role can manage flow", () => {
  assert.throws(
    () =>
      init({
        methodology: kanban(),
        config: {},
        roles: [
          {
            id: "w",
            name: "w",
            modelTier: "small",
            capabilities: ["deliver"],
            canApprove: [],
            inputs: [],
            outputs: [],
            do_not: [],
          },
        ],
        now: T0,
      }),
    (e: unknown) =>
      e instanceof WorkflowError &&
      e.code === "missing-capability" &&
      /manage-flow/.test(e.message),
  );
});

function boardWith(
  ...items: Array<{
    id: string;
    stage: string;
    cos?: "expedite" | "fixed-date" | "standard" | "intangible";
    priority?: number;
  }>
) {
  let { state } = init({ methodology: kanban(), config: {}, now: T0 });
  for (const it of items) {
    state = addItem(
      state,
      {
        id: it.id,
        title: it.id,
        acceptance: ["ok"],
        ...(it.cos ? { classOfService: it.cos } : {}),
        ...(it.priority !== undefined ? { priority: it.priority } : {}),
      },
      "human",
      T0,
    );
    if (it.stage !== "options")
      state = moveItem(state, it.id, { stage: it.stage, status: "todo" }, "human", T1);
  }
  return state;
}

test("candidates are todo/review items between the commitment and delivery columns", () => {
  const s = boardWith(
    { id: "O", stage: "options" },
    { id: "R", stage: "ready" },
    { id: "D", stage: "dev" },
    { id: "X", stage: "done" },
  );
  assert.deepEqual(
    timSort(
      kanban()
        .candidates(s)
        .map((i) => i.id),
      (x, y) => (x < y ? -1 : x > y ? 1 : 0),
    ),
    ["D", "R"],
  );
  assert.equal(onBoard(s, getItem(s, "O")), false);
  assert.equal(onBoard(s, getItem(s, "R")), true);
  assert.equal(onBoard(s, getItem(s, "X")), false);
});

test("next pulls from ready into dev, respects dev WIP, and expedite goes first with a bypass", () => {
  const m = kanban();
  let s = boardWith(
    { id: "A", stage: "ready", priority: 9 },
    { id: "B", stage: "ready", priority: 8 },
    { id: "C", stage: "ready", priority: 7 },
    { id: "D", stage: "ready", priority: 6 },
  );
  let r = next(s, m, { now: T1 });
  assert.deepEqual(
    r.briefs.map((b) => b.item.id),
    ["A", "B", "C"],
  ); // dev.wipLimit 3
  assert.equal(r.reason, "wip-full");
  assert.equal(getItem(r.state, "A").stage, "dev");
  assert.equal(getItem(r.state, "A").role, "worker");
  s = addItem(
    r.state,
    { id: "E", title: "E", acceptance: ["ok"], classOfService: "expedite" },
    "human",
    T1,
  );
  s = moveItem(s, "E", { stage: "ready", status: "todo" }, "human", T1);
  r = next(s, m, { now: T1 });
  assert.deepEqual(
    r.briefs.map((b) => b.item.id),
    ["E"],
  ); // bypass: 3 active + 1
  assert.equal(getItem(r.state, "D").stage, "ready");
  assert.deepEqual(activeExpedites(r.state), ["E"]);
  const inv = m.invariants(r.state, getItem(r.state, "E"));
  assert.equal(inv.length, 4);
  assert.match(inv[0]!, /Development/);
  assert.match(inv[1]!, /expedite/);
  assert.match(inv[2]!, /WIP limit/);
});

test("a second expedite waits while one is active (maxExpedite)", () => {
  const m = kanban();
  const s = boardWith(
    { id: "E1", stage: "ready", cos: "expedite" },
    { id: "E2", stage: "ready", cos: "expedite" },
    { id: "S", stage: "ready" },
  );
  const r = next(s, m, { now: T1 });
  assert.deepEqual(
    r.briefs.map((b) => b.item.id),
    ["E1", "S"],
  );
  assert.deepEqual(
    m.candidates(r.state).map((i) => i.id),
    [],
  );
  const { state: wide } = init({ methodology: m, config: { maxExpedite: 2 }, now: T0 });
  assert.equal(validateKanbanConfig(wide.config).maxExpedite, 2);
});

test("priorityByClass and byClassThenAge order by class, then age, then id", () => {
  const s = boardWith(
    { id: "I", stage: "ready", cos: "intangible", priority: 99 },
    { id: "F", stage: "ready", cos: "fixed-date" },
    { id: "S", stage: "ready" },
  );
  const [I, F, S] = ["I", "F", "S"].map((id) => getItem(s, id));
  const ctx = { deferrals: 0, aging: true, maxDeferralRounds: 5 };
  assert.equal(priorityByClass(I!, ctx), 1e15 + 99);
  assert.equal(priorityByClass(S!, ctx), 2e15);
  assert.ok(priorityByClass(F!, ctx) > 2e15 + 1e9);
  assert.ok(priorityByClass({ ...S!, classOfService: "expedite" }, ctx) > priorityByClass(F!, ctx));
  assert.ok(priorityByClass({ ...S!, type: "question" }, ctx) > 4e15 + 1e9);
  assert.equal(priorityByClass({ ...S!, priority: 1e12 }, ctx), 2e15 + 1e9); // clamped
  assert.equal(priorityByClass(S!, { ...ctx, deferrals: 9 }), 2e15 + 5 * 2e9); // aging is capped
  assert.equal(priorityByClass(S!, { ...ctx, deferrals: 9, aging: false }), 2e15);
  assert.equal(priorityByClass(I!, { ...ctx, deferrals: 5 }), 2e15 + 99 + 5 * 2e9); // promoted
  assert.equal(priorityByClass(I!, { ...ctx, deferrals: 5, aging: false }), 1e15 + 99);
  assert.ok(byClassThenAge(F!, S!) < 0);
  assert.ok(byClassThenAge(S!, I!) < 0);
  const older = { ...S!, transitions: [{ ...S!.transitions[0]!, at: T0 }] };
  assert.ok(byClassThenAge(older, S!) < 0);
  assert.ok(byClassThenAge(S!, { ...S!, id: "T" }) < 0);
});

test("a commitment-column policy is enforced on the pull and the refusal is visible", () => {
  const m = kanban();
  const columns = DEFAULT_COLUMNS.map((c) =>
    c.id === "ready" ? { ...c, policies: [{ kind: "estimate-present" as const }] } : c,
  );
  let s = init({ methodology: m, config: { columns }, now: T0 }).state;
  assert.deepEqual(s.stages.find((x) => x.id === "dev")!.entryPolicy, [
    { kind: "estimate-present" },
  ]);
  s = addItem(s, { id: "A", title: "a", acceptance: ["ok"] }, "human", T0);
  s = moveItem(s, "A", { stage: "ready", status: "todo" }, "human", T1);
  let r = next(s, m, { now: T1 });
  assert.deepEqual(r.briefs, []);
  assert.notEqual(r.reason, "no-candidates");
  assert.equal(r.skipped[0]!.id, "A");
  assert.equal(r.skipped[0]!.reason, "entry-policy");
  assert.match(r.skipped[0]!.detail, /weight/);
  const ev = r.state.events[r.state.events.length - 1]!;
  assert.deepEqual((ev.payload as { skipped: unknown }).skipped, r.skipped);
  s = editItem(r.state, "A", { weight: 3 }, "human", T1);
  r = next(s, m, { now: T1 });
  assert.deepEqual(
    r.briefs.map((b) => b.item.id),
    ["A"],
  );
  assert.deepEqual(r.skipped, []);
});
