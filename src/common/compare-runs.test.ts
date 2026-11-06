import { test } from "node:test";
import assert from "node:assert/strict";
import { appendEvent, createState } from "../core/state.ts";
import { WorkflowError } from "../core/errors.ts";
import { addItem, getItem } from "../core/items/record.ts";
import { complete, init, next } from "../index.ts";
import { kanban } from "../methodologies/kanban/index.ts";
import type { Accounting, Handoff, WorkflowState } from "../core/types.ts";
import { compareRuns, type RunRecord } from "./compare-runs.ts";

const T0 = "2026-11-06T00:00:00.000Z";
const base = (): WorkflowState => {
  const m = kanban();
  const config = m.validateConfig({});
  return createState({
    methodology: "kanban",
    config,
    stages: m.defaultStages(config),
    roles: m.defaultRoles(config),
    now: T0,
  });
};

interface Shape {
  tokens?: number;
  durationMs?: number;
  turns?: number;
  pending?: number;
  cleared?: number;
  rework?: number;
  escalated?: number;
  done?: number;
}
/** A synthetic finished state: `turns` accounting lines splitting `tokens` and `durationMs`. */
function shaped(o: Shape = {}): WorkflowState {
  let s = base();
  const turns = o.turns ?? 1;
  const acc: Accounting[] = [];
  for (let i = 0; i < turns; i++)
    acc.push({
      item: "A",
      role: "worker",
      model: "m",
      tokensIn: (o.tokens ?? 100) / turns / 2,
      tokensOut: (o.tokens ?? 100) / turns / 2,
      durationMs: (o.durationMs ?? 10) / turns,
      startedAt: T0,
      endedAt: T0,
    });
  s = { ...s, accounting: acc };
  const ev = (type: string, n: number) => {
    for (let i = 0; i < n; i++) s = appendEvent(s, type, "x", {}, T0);
  };
  ev("pending.raised", o.pending ?? 0);
  ev("blocker.cleared", o.cleared ?? 0);
  ev("item.rework", o.rework ?? 0);
  ev("item.escalated", o.escalated ?? 0);
  ev("blocker.raised", 3); // not counted
  const items = { ...s.items };
  for (let i = 0; i < (o.done ?? 0); i++)
    items[`D${i}`] = {
      ...getItem(addItem(base(), { id: "Z", title: "z" }, "srm", T0), "Z"),
      id: `D${i}`,
      status: "done",
    };
  return { ...s, items };
}
const run = (variant: string, scenario: string, passed: boolean, o: Shape = {}): RunRecord => ({
  variant,
  scenario,
  passed,
  state: shaped(o),
});
const code = (e: unknown) => (e as WorkflowError).code;
const invalid = (fn: () => unknown, re?: RegExp) =>
  assert.throws(fn, (e) => {
    assert.ok(e instanceof WorkflowError, String(e));
    assert.equal(code(e), "invalid-input");
    assert.ok((e as WorkflowError).fix.length > 0);
    if (re) assert.match((e as WorkflowError).message, re);
    return true;
  });

test("metrics come from one finished state: accounting, pending, blockers, rework, escalation, done items", () => {
  const s = shaped({
    tokens: 600,
    durationMs: 30,
    turns: 3,
    pending: 2,
    cleared: 1,
    rework: 4,
    escalated: 1,
    done: 2,
  });
  const r = compareRuns([{ variant: "V0", scenario: "s1", passed: true, state: s }], {
    baseline: "V0",
  });
  assert.deepEqual(r.variants[0]!.mean, {
    tokens: 600,
    durationMs: 30,
    turns: 3,
    humanInterventions: 3,
    reworks: 4,
    escalations: 1,
    itemsDone: 2,
  });
  assert.equal(r.variants[0]!.passRate, 1);
});

test("a finished Kanban run: tokens and turns follow the accounting after a correction", () => {
  const m = kanban();
  let s = init({ methodology: m, config: {}, now: T0 }).state;
  s = addItem(s, { id: "A", title: "a", acceptance: ["ok"] }, "service-request-manager", T0);
  s = m.ceremonies["replenishment"]!(s, {
    by: "service-request-manager",
    now: T0,
    items: ["A"],
  }).state;
  let guard = 0;
  while (getItem(s, "A").status !== "done" && guard++ < 10) {
    s = next(s, m, { now: T0 }).state;
    const it = getItem(s, "A");
    const by = it.role!;
    const h: Handoff = {
      item: "A",
      role: by,
      produced: [{ kind: "test-output", ref: "ci/A" }],
      notes: "n",
      do_not: [],
      open_questions: [],
    };
    const a: Accounting = {
      item: "A",
      role: by,
      model: "m",
      tokensIn: 300,
      tokensOut: 200,
      durationMs: 1000,
      startedAt: T0,
      endedAt: T0,
    };
    s = complete(s, m, h, a, T0).state;
  }
  assert.equal(getItem(s, "A").status, "done");
  const lines = s.accounting.length;
  const r = compareRuns([{ variant: "V0", scenario: "s", passed: true, state: s }], {
    baseline: "V0",
  });
  const mean = r.variants[0]!.mean;
  assert.equal(mean.turns, lines);
  assert.equal(mean.tokens, 500 * lines);
  assert.equal(mean.durationMs, 1000 * lines);
  assert.equal(mean.itemsDone, 1);
});

test("the report's example: V1 regresses on a must-pass scenario, so there is no winner", () => {
  const runs: RunRecord[] = [];
  for (let i = 1; i <= 12; i++) {
    runs.push(run("V0", `s${i}`, i !== 12, { tokens: 1_900_000 / 12 }));
    runs.push(run("V1", `s${i}`, i !== 11 && i !== 12, { tokens: 900_000 / 12 }));
  }
  const r = compareRuns(runs, { baseline: "V0", mustPass: ["s11"] });
  assert.equal(r.winner, null);
  assert.deepEqual(
    r.variants.map((v) => [v.variant, v.eligible, v.passed]),
    [
      ["V0", true, 11],
      ["V1", false, 10],
    ],
  );
  assert.deepEqual(r.variants[1]!.regressions, ["s11"]);
  assert.match(r.reason, /must-pass regression: V1 \(s11\)/);
});

test("without the must-pass regression, the cheaper variant within noise wins", () => {
  const runs = [
    run("V0", "s1", true, { tokens: 1000 }),
    run("V0", "s2", true, { tokens: 1000 }),
    run("V1", "s1", true, { tokens: 500 }),
    run("V1", "s2", true, { tokens: 500 }),
  ];
  const r = compareRuns(runs, { baseline: "V0", mustPass: ["s1"] });
  assert.equal(r.winner, "V1");
  assert.match(r.reason, /V1 beats baseline V0/);
});

test("ranking: eligible first, passRate desc, then tokens, duration, interventions, id", () => {
  const runs = [
    run("b", "s", true, { tokens: 100, durationMs: 5, pending: 1 }),
    run("a", "s", true, { tokens: 100, durationMs: 5, pending: 1 }),
    run("c", "s", true, { tokens: 100, durationMs: 5, pending: 0 }),
    run("d", "s", true, { tokens: 100, durationMs: 4, pending: 9 }),
    run("e", "s", true, { tokens: 90, durationMs: 99, pending: 9 }),
    run("f", "s", false, { tokens: 1 }),
    run("z", "s", true, { tokens: 1 }),
    run("base", "s", true, { tokens: 5000 }),
  ];
  const r = compareRuns(runs, { baseline: "base", mustPass: ["s"] });
  // z..base all pass s; f fails the must-pass scenario so it is ineligible and last
  assert.deepEqual(
    r.variants.map((v) => v.variant),
    ["z", "e", "d", "c", "a", "b", "base", "f"],
  );
  assert.equal(r.winner, "z");
});

test("ids order by code unit, not by locale", () => {
  const runs = ["b", "B", "a", "A"].map((v) => run(v, "s", true));
  const r = compareRuns(runs, { baseline: "a" });
  assert.deepEqual(
    r.variants.map((v) => v.variant),
    ["A", "B", "a", "b"],
  );
});

test("tolerance boundaries: not worse is >=, better is strict", () => {
  const mk = (pass: boolean[], tokens: number) =>
    pass.map((p, i) => run("V1", `s${i}`, p, { tokens }));
  const baseRuns = [0, 1, 2, 3].map((i) => run("V0", `s${i}`, i !== 3, { tokens: 1000 }));
  // V0 passRate 0.75
  // V1 = 0.5 with passTolerance 0.25: exactly at the edge of "not worse", cheaper -> wins
  let r = compareRuns([...baseRuns, ...mk([true, false, false, true], 500)], {
    baseline: "V0",
    passTolerance: 0.25,
  });
  assert.equal(r.winner, "V1");
  // just below the edge: worse -> no winner
  r = compareRuns([...baseRuns, ...mk([true, false, false, false], 500)], {
    baseline: "V0",
    passTolerance: 0.25,
  });
  assert.equal(r.winner, null);
  // equal passRate and tokens exactly base*(1-costTolerance) is not better
  r = compareRuns([...baseRuns, ...mk([true, true, true, false], 900)], {
    baseline: "V0",
    costTolerance: 0.1,
  });
  assert.equal(r.winner, null);
  assert.match(r.reason, /within noise/);
  r = compareRuns([...baseRuns, ...mk([true, true, true, false], 899)], {
    baseline: "V0",
    costTolerance: 0.1,
  });
  assert.equal(r.winner, "V1");
  // a pass-rate gain beyond passTolerance wins even when costlier
  r = compareRuns([...baseRuns, ...mk([true, true, true, true], 5000)], {
    baseline: "V0",
    passTolerance: 0.2,
  });
  assert.equal(r.winner, "V1");
  r = compareRuns([...baseRuns, ...mk([true, true, true, true], 5000)], {
    baseline: "V0",
    passTolerance: 0.25,
  });
  assert.equal(r.winner, null);
});

test("repeated runs of one scenario: a failing noise run is a regression, rates count every run", () => {
  const runs = [
    run("V0", "s", true),
    run("V1", "s", true),
    run("V1", "s", false),
    run("V1", "s", true, { tokens: 400 }),
  ];
  const r = compareRuns(runs, { baseline: "V0", mustPass: ["s"] });
  const v1 = r.variants.find((v) => v.variant === "V1")!;
  assert.equal(v1.runs, 3);
  assert.equal(v1.passed, 2);
  assert.equal(v1.passRate, 2 / 3);
  assert.deepEqual(v1.regressions, ["s"]);
  assert.equal(v1.eligible, false);
  assert.equal(r.winner, null);
});

test("a scenario the variant never ran is missing and makes it ineligible", () => {
  const runs = [
    run("V0", "s1", true),
    run("V0", "s2", true),
    run("V1", "s1", true, { tokens: 1 }),
    run("V2", "s1", true, { tokens: 1 }),
    run("V2", "s2", true, { tokens: 1 }),
    run("V2", "s3", true, { tokens: 1 }),
  ];
  const r = compareRuns(runs, { baseline: "V0" });
  assert.deepEqual(r.variants.find((v) => v.variant === "V1")!.missing, ["s2"]);
  assert.equal(r.variants.find((v) => v.variant === "V1")!.eligible, false);
  assert.equal(r.variants.find((v) => v.variant === "V2")!.eligible, true);
  assert.equal(r.winner, "V2");
  // a must-pass scenario only a third variant ran is missing for the others too
  const q = compareRuns(runs, { baseline: "V0", mustPass: ["s3"] });
  assert.deepEqual(q.variants.find((v) => v.variant === "V0")!.missing, ["s3"]);
  assert.equal(q.variants.find((v) => v.variant === "V0")!.eligible, false);
  assert.equal(q.winner, "V2");
});

test("the baseline alone is valid and has no winner", () => {
  const r = compareRuns([run("V0", "s", true)], { baseline: "V0" });
  assert.equal(r.winner, null);
  assert.equal(r.variants.length, 1);
  assert.match(r.reason, /no variant to compare/);
});

test("mixed methodologies compare on the same metrics", () => {
  const other = { ...shaped({ tokens: 10 }), methodology: "scrum" as const };
  const r = compareRuns(
    [
      run("V0", "s", true, { tokens: 100 }),
      { variant: "V1", scenario: "s", passed: true, state: other },
    ],
    { baseline: "V0" },
  );
  assert.equal(r.winner, "V1");
});

test("input order never changes the result, floats included", () => {
  const runs = [
    run("V0", "s1", true, { tokens: 0.1 }),
    run("V0", "s2", true, { tokens: 0.2 }),
    run("V0", "s3", true, { tokens: 0.3 }),
    run("V1", "s1", true, { tokens: 0.05 }),
    run("V1", "s2", true, { tokens: 0.07 }),
    run("V1", "s3", false, { tokens: 0.3 }),
  ];
  const expected = compareRuns(runs, { baseline: "V0", mustPass: ["s1"] });
  const rev = [...runs].reverse();
  assert.deepEqual(compareRuns(rev, { baseline: "V0", mustPass: ["s1"] }), expected);
  const shuffled = [runs[3]!, runs[0]!, runs[5]!, runs[2]!, runs[4]!, runs[1]!];
  assert.deepEqual(compareRuns(shuffled, { baseline: "V0", mustPass: ["s1"] }), expected);
});

test("pure: the input is not mutated and the result is a fresh object", () => {
  const runs = [run("V0", "s", true), run("V1", "s", true, { tokens: 1 })];
  const snap = JSON.stringify(runs);
  const a = compareRuns(runs, { baseline: "V0", mustPass: ["s"] });
  assert.equal(JSON.stringify(runs), snap);
  const b = compareRuns(runs, { baseline: "V0", mustPass: ["s"] });
  assert.deepEqual(a, b);
  assert.notEqual(a, b);
});

test("invalid inputs fail invalid-input with a fix", () => {
  const ok = [run("V0", "s", true)];
  invalid(() => compareRuns([], { baseline: "V0" }), /no runs/);
  invalid(() => compareRuns(ok, { baseline: "nope" }), /"nope"/);
  invalid(() => compareRuns(ok, { baseline: "V0", mustPass: ["nope"] }), /"nope"/);
  invalid(() => compareRuns(ok, { baseline: "V0", passTolerance: 1.5 }), /passTolerance/);
  invalid(() => compareRuns(ok, { baseline: "V0", costTolerance: -0.1 }), /costTolerance/);
  invalid(() => compareRuns(ok, { baseline: "V0", costTolerance: Number.NaN }), /costTolerance/);
  invalid(() => compareRuns([{ ...ok[0]!, passed: "yes" as never }], { baseline: "V0" }), /passed/);
  invalid(() => compareRuns([{ ...ok[0]!, variant: "bad id" }], { baseline: "bad id" }));
  invalid(() => compareRuns([{ ...ok[0]!, scenario: "" }], { baseline: "V0" }));
  invalid(
    () =>
      compareRuns([{ ...ok[0]!, state: { ...ok[0]!.state, events: undefined as never } }], {
        baseline: "V0",
      }),
    /events/,
  );
  invalid(
    () =>
      compareRuns([{ ...ok[0]!, state: { ...ok[0]!.state, accounting: {} as never } }], {
        baseline: "V0",
      }),
    /accounting/,
  );
  invalid(() => compareRuns(ok, { baseline: "V0", bogus: 1 } as never), /bogus/);
  invalid(() => compareRuns(ok, { baseline: "V0", mustPass: "s" as never }), /mustPass/);
});

test("hostile input: no TypeError, always invalid-input", () => {
  const ok = [run("V0", "s", true)];
  for (const bad of [undefined, null, 1, "x", {}, { length: 1, 0: ok[0] }, new Map()])
    invalid(() => compareRuns(bad as never, { baseline: "V0" }), /runs/);
  for (const bad of [undefined, null, 1, "x", [], ok]) invalid(() => compareRuns(ok, bad as never));
  for (const run0 of [null, undefined, 1, "x", [], { variant: "V0" }])
    invalid(() => compareRuns([run0 as never], { baseline: "V0" }));
  for (const state of [null, 1, "x", [], {}, { events: [], accounting: [] }])
    invalid(() => compareRuns([{ ...ok[0]!, state: state as never }], { baseline: "V0" }));
  for (const id of ["__proto__", "toString", "constructor", "valueOf", "hasOwnProperty"]) {
    invalid(() => compareRuns([{ ...ok[0]!, variant: id }], { baseline: id }), new RegExp(id));
    invalid(() => compareRuns([{ ...ok[0]!, scenario: id }], { baseline: "V0" }), new RegExp(id));
    invalid(() => compareRuns(ok, { baseline: "V0", mustPass: [id] }), new RegExp(id));
  }
  const withAcc = (patch: Record<string, unknown>): RunRecord => {
    const r = run("V0", "s", true);
    return { ...r, state: { ...r.state, accounting: [{ ...r.state.accounting[0]!, ...patch }] } };
  };
  for (const v of [Number.NaN, Infinity, -Infinity, -1, "5", null, undefined])
    for (const field of ["tokensIn", "tokensOut", "durationMs"])
      invalid(() => compareRuns([withAcc({ [field]: v })], { baseline: "V0" }), new RegExp(field));
  const r0 = run("V0", "s", true);
  invalid(
    () =>
      compareRuns([{ ...r0, state: { ...r0.state, accounting: [null as never] } }], {
        baseline: "V0",
      }),
    /accounting/,
  );
  invalid(
    () =>
      compareRuns([{ ...r0, state: { ...r0.state, events: [null as never] } }], { baseline: "V0" }),
    /events/,
  );
  invalid(
    () =>
      compareRuns([{ ...r0, state: { ...r0.state, items: null as never } }], { baseline: "V0" }),
    /items/,
  );
});

test("prototype-polluted ids cannot reach the result through inherited keys", () => {
  const runs = [run("V0", "s", true), run("V1", "s", true, { tokens: 1 })];
  const r = compareRuns(runs, { baseline: "V0" });
  assert.equal(Object.getPrototypeOf(r.variants[0]!), Object.prototype);
  assert.equal(r.winner, "V1");
});

test("G1-3: passRate is the mean of each scenario's pass fraction, so extra runs of an easy scenario do not buy a win", () => {
  const runs = [
    run("V0", "easy", true),
    run("V0", "hard", true),
    run("V0", "hard", false),
    run("V0", "hard", false),
    ...[1, 2, 3, 4, 5].map(() => run("V1", "easy", true, { tokens: 10 })),
    run("V1", "hard", false, { tokens: 10 }),
  ];
  const r = compareRuns(runs, { baseline: "V0" });
  const rate = Object.fromEntries(r.variants.map((v) => [v.variant, v.passRate]));
  assert.deepEqual(rate, { V0: (1 + 1 / 3) / 2, V1: 0.5 });
  assert.equal(r.winner, null);
  assert.deepEqual(
    r.variants.map((v) => [v.variant, v.runs, v.passed]),
    [
      ["V0", 4, 2],
      ["V1", 6, 5],
    ],
  );
});
