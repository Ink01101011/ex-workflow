import { test } from "node:test";
import assert from "node:assert/strict";
import { createState } from "./state.ts";
import { addItem, moveItem } from "./items.ts";
import { coreRulesFor } from "./rules.ts";
import type { Action, Methodology, Role, Stage } from "./types.ts";

const T0 = "2026-10-19T00:00:00.000Z";
const stages: Stage[] = [
  {
    id: "todo",
    name: "To do",
    entryPolicy: [],
    exitPolicy: [],
    gate: {
      id: "g",
      requires: [{ capability: "approve-gate" }],
      evidence: [],
      onFail: { action: "block" },
    },
  },
  { id: "done", name: "Done", entryPolicy: [], exitPolicy: [] },
];
const r = (id: string, caps: Role["capabilities"]): Role => ({
  id,
  name: id,
  modelTier: "small",
  capabilities: caps,
  canApprove: ["g"],
  inputs: [],
  outputs: [],
  do_not: [],
});
const m = (): Methodology => ({
  name: "kanban",
  vocabulary: {} as Methodology["vocabulary"],
  validateConfig: (c) => c,
  defaultStages: () => stages,
  defaultRoles: () => [],
  requiredCapabilities: ["deliver", "approve-gate"],
  exclusiveCapabilities: [],
  plannerOptions: () => ({ schedulerMode: "level" }),
  candidates: () => [],
  invariants: () => [],
  ceremonies: {},
  rules: [],
  metrics: () => ({}),
  humanDefaults: { gates: "none" },
});

test("separation-lost warns when one role holds every required capability", () => {
  const s = createState({
    methodology: "kanban",
    config: {},
    stages,
    roles: [r("solo", ["deliver", "approve-gate"])],
    now: T0,
  });
  const v = coreRulesFor(m()).flatMap((rule) => rule.check(s, { type: "init", by: "system" }));
  assert.equal(v.length, 1);
  assert.equal(v[0]!.rule, "separation-lost");
  assert.equal(v[0]!.severity, "warning");
  const ok = createState({
    methodology: "kanban",
    config: {},
    stages,
    roles: [r("dev", ["deliver"]), r("qa", ["approve-gate"])],
    now: T0,
  });
  assert.deepEqual(
    coreRulesFor(m()).flatMap((rule) => rule.check(ok, { type: "init", by: "system" })),
    [],
  );
});

test("conflict-of-interest errors when the author completes through a capability gate", () => {
  let s = createState({
    methodology: "kanban",
    config: {},
    stages,
    roles: [r("devqa", ["deliver", "approve-gate"]), r("qa", ["approve-gate"])],
    now: T0,
  });
  s = addItem(s, { id: "A", title: "a", role: "devqa" }, "po", T0);
  s = moveItem(s, "A", { status: "in_progress" }, "devqa", T0);
  const action = {
    type: "complete",
    by: "devqa",
    payload: { handoff: { item: "A", role: "devqa", verdict: "done" } },
  };
  const v = coreRulesFor(m()).flatMap((rule) => rule.check(s, action));
  assert.equal(v[0]?.rule, "conflict-of-interest");
  assert.equal(v[0]?.severity, "error");
  assert.match(v[0]!.fix, /qa/);
});

const build = (st: Stage[]) => {
  let s = createState({
    methodology: "kanban",
    config: {},
    stages: st,
    roles: [r("devqa", ["deliver", "approve-gate"]), r("qa", ["approve-gate"])],
    now: T0,
  });
  s = addItem(s, { id: "A", title: "a", role: "devqa" }, "po", T0);
  return moveItem(s, "A", { status: "in_progress" }, "devqa", T0);
};
const act = (role: string, verdict = "done") => ({
  type: "complete",
  by: role,
  payload: { handoff: { item: "A", role, verdict } },
});

test("conflict-of-interest stays silent for a different author, a blocked verdict, a human-only gate and an ungated stage", () => {
  const run = (s: ReturnType<typeof build>, a: Action) =>
    coreRulesFor(m()).flatMap((rule) => rule.check(s, a));
  const s = build(stages);
  assert.equal(run(s, act("devqa"))[0]?.rule, "conflict-of-interest"); // control
  assert.deepEqual(run(s, act("qa")), []); // someone else completes
  assert.deepEqual(run(s, act("devqa", "blocked")), []);
  assert.deepEqual(run(s, { type: "ceremony.plan", by: "devqa" }), []); // not a completion
  const humanOnly = stages.map((st) =>
    st.gate ? { ...st, gate: { ...st.gate, requires: ["human" as const] } } : st,
  );
  assert.deepEqual(run(build(humanOnly), act("devqa")), []);
  const ungated = stages.map(({ gate: _g, ...st }) => st);
  assert.deepEqual(run(build(ungated), act("devqa")), []);
});
