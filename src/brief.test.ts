import { test } from "node:test";
import assert from "node:assert/strict";
import { createState, appendEvent } from "./state.ts";
import { addItem, moveItem } from "./items.ts";
import { synthesizeBrief, next } from "./brief.ts";
import type { Gate, Methodology, Role, Stage } from "./types.ts";

const T0 = "2026-10-19T00:00:00.000Z";
const gate: Gate = { id: "g", requires: ["human"], evidence: [], onFail: { action: "block" } };
const stages: Stage[] = [
  { id: "todo", name: "To do", entryPolicy: [], exitPolicy: [], gate },
  { id: "done", name: "Done", entryPolicy: [], exitPolicy: [] },
];
const dev: Role = {
  id: "dev",
  name: "Dev",
  modelTier: "small",
  capabilities: ["deliver"],
  canApprove: [],
  inputs: ["spec"],
  outputs: ["code"],
  do_not: ["no force-push"],
};
const m = (): Methodology => ({
  name: "kanban",
  vocabulary: {} as Methodology["vocabulary"],
  validateConfig: (c) => c,
  defaultStages: () => stages,
  defaultRoles: () => [dev],
  requiredCapabilities: ["deliver"],
  exclusiveCapabilities: [],
  plannerOptions: () => ({ schedulerMode: "throughput" }),
  candidates: (s) => Object.values(s.items).filter((i) => i.status === "todo"),
  invariants: (_s, i) => [`finish ${i.id} within budget`],
  ceremonies: {},
  rules: [],
  metrics: () => ({}),
  humanDefaults: { gates: "none" },
});

test("synthesizeBrief merges role do_not with upstream handoffs and exposes the gate ahead", () => {
  let s = createState({ methodology: "kanban", config: {}, stages, roles: [dev], now: T0 });
  s = addItem(s, { id: "A", title: "a", role: "dev" }, "po", T0);
  s = moveItem(s, "A", { stage: "done", status: "done" }, "dev", T0);
  s = appendEvent(
    s,
    "item.completed",
    "dev",
    {
      id: "A",
      role: "dev",
      verdict: "done",
      produced: [{ kind: "code", ref: "src/a.ts" }],
      notes: "A done",
      do_not: ["do not rename a()"],
      open_questions: [],
    },
    T0,
  );
  s = addItem(
    s,
    { id: "B", title: "b", dependsOn: ["A"], role: "dev", acceptance: ["passes"] },
    "po",
    T0,
  );
  s = {
    ...s,
    iterations: [
      {
        id: "S1",
        goal: "g",
        budget: { tokens: 1000 },
        spent: { tokens: 100, turns: 1, wallclockMs: 0 },
        startedAt: T0,
        committed: ["B"],
        carryover: [],
      },
    ],
  };
  const b = synthesizeBrief(s, m(), s.items["B"]!);
  assert.equal(b.role.id, "dev");
  assert.equal(b.modelTier, "small");
  assert.deepEqual(b.do_not, ["no force-push", "do not rename a()"]);
  assert.deepEqual(b.upstream, [
    { item: "A", produced: [{ kind: "code", ref: "src/a.ts" }], notes: "A done" },
  ]);
  assert.deepEqual(b.priorHandoffs, []);
  assert.deepEqual(b.relatedBugs, []);
  assert.deepEqual(b.invariants, ["finish B within budget"]);
  assert.deepEqual(b.budgetRemaining, { tokens: 900 });
  assert.equal(b.gateAhead?.id, "g");
  assert.deepEqual(b.acceptance, ["passes"]);
});

test("priorHandoffs carries earlier completions of the same item; relatedBugs lists open bugs touching it or its deps", () => {
  let s = createState({ methodology: "kanban", config: {}, stages, roles: [dev], now: T0 });
  s = addItem(s, { id: "A", title: "a", role: "dev" }, "po", T0);
  s = addItem(s, { id: "B", title: "b", role: "dev", dependsOn: ["A"] }, "po", T0);
  s = appendEvent(
    s,
    "item.completed",
    "dev",
    {
      id: "B",
      role: "dev",
      verdict: "rework",
      produced: [],
      notes: "tests missing",
      do_not: [],
      open_questions: [],
    },
    T0,
  );
  s = addItem(
    s,
    { id: "BUG1", title: "a() returns null", type: "bug", affects: ["A"], role: "dev" },
    "po",
    T0,
  );
  assert.throws(
    () =>
      addItem(
        s,
        { id: "BUG2", title: "unrelated", type: "bug", affects: ["Z"], role: "dev" },
        "po",
        T0,
      ),
    (e: unknown) => (e as { code?: string }).code === "unknown-item",
  );
  const b = synthesizeBrief(s, m(), s.items["B"]!);
  assert.equal(b.priorHandoffs.length, 1);
  assert.equal(b.priorHandoffs[0]!.verdict, "rework");
  assert.equal(b.priorHandoffs[0]!.notes, "tests missing");
  assert.deepEqual(b.relatedBugs, [{ id: "BUG1", title: "a() returns null", affects: ["A"] }]);
  const bug = synthesizeBrief(s, m(), s.items["BUG1"]!);
  assert.deepEqual(bug.relatedBugs, []);
});

test("next plans and returns one brief per dispatched item", () => {
  let s = createState({ methodology: "kanban", config: {}, stages, roles: [dev], now: T0 });
  s = addItem(s, { id: "A", title: "a" }, "po", T0);
  const res = next(s, m(), { now: T0 });
  assert.equal(res.briefs.length, 1);
  assert.equal(res.briefs[0]!.item.status, "in_progress");
  assert.equal(res.briefs[0]!.role.id, "dev");
});
