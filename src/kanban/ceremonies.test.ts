import { test } from "node:test";
import assert from "node:assert/strict";
import { init } from "../methodology.ts";
import { addItem, getItem, moveItem } from "../items.ts";
import { next, synthesizeBrief } from "../brief.ts";
import { complete } from "../complete.ts";
import { lastEvent } from "../state.ts";
import { WorkflowError } from "../errors.ts";
import { kanban } from "./index.ts";
import type { WorkflowState } from "../types.ts";

const T = (min: number) =>
  new Date(Date.parse("2026-10-22T00:00:00.000Z") + min * 60_000).toISOString();
const m = kanban();
const c = m.ceremonies;
const thrown = (fn: () => unknown): WorkflowError | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof WorkflowError ? e : undefined;
  }
};
const code = (fn: () => unknown) => thrown(fn)?.code ?? "no-throw";
const rule = (fn: () => unknown) => thrown(fn)?.rule;

function withOptions(): WorkflowState {
  let { state } = init({ methodology: m, config: {}, now: T(0) });
  state = addItem(
    state,
    { id: "A", title: "a", acceptance: ["ok"] },
    "service-request-manager",
    T(1),
  );
  state = addItem(state, { id: "B", title: "b" }, "service-request-manager", T(1));
  state = addItem(
    state,
    { id: "F", title: "f", acceptance: ["ok"], classOfService: "fixed-date", deadline: T(500) },
    "service-request-manager",
    T(1),
  );
  state = addItem(
    state,
    { id: "E", title: "e", acceptance: ["ok"], classOfService: "expedite" },
    "service-request-manager",
    T(1),
  );
  return state;
}

test("replenishment pulls options into the commitment column and records class and deadline", () => {
  const s = withOptions();
  assert.equal(
    code(() => c["replenishment"]!(s, { by: "worker", now: T(2), items: ["A"] })),
    "missing-capability",
  );
  assert.equal(
    code(() => c["replenishment"]!(s, { by: "service-request-manager", now: T(2), items: [] })),
    "invalid-input",
  );
  assert.equal(
    code(() =>
      c["replenishment"]!(s, { by: "service-request-manager", now: T(2), items: ["A", "A"] }),
    ),
    "invalid-input",
  );
  assert.equal(
    code(() => c["replenishment"]!(s, { by: "service-request-manager", now: T(2), items: ["B"] })),
    "policy-unmet",
  );
  const r = c["replenishment"]!(s, { by: "service-request-manager", now: T(2), items: ["A", "F"] });
  assert.deepEqual(r.warnings, []);
  assert.equal(getItem(r.state, "A").stage, "ready");
  assert.equal(getItem(r.state, "F").stage, "ready");
  assert.equal(getItem(r.state, "A").status, "todo");
  const ev = lastEvent(r.state)!;
  assert.equal(ev.type, "cadence.replenishment");
  assert.deepEqual(ev.payload, {
    column: "ready",
    items: [
      { id: "A", classOfService: "standard", deadline: null },
      { id: "F", classOfService: "fixed-date", deadline: T(500) },
    ],
  });
  assert.equal(
    rule(() =>
      c["replenishment"]!(r.state, { by: "service-request-manager", now: T(3), items: ["A"] }),
    ),
    "pull-not-push",
  );
  const pulled = next(r.state, m, { now: T(3) });
  assert.deepEqual(new Set(pulled.briefs.map((b) => b.item.id)), new Set(["A", "F"]));
  assert.equal(pulled.briefs.length, 2);
  assert.equal(getItem(pulled.state, "F").stage, "dev");
});

test("delivery-planning records the cards selected for delivery", () => {
  let s = withOptions();
  s = moveItem(s, "A", { stage: "review", status: "todo" }, "human", T(2));
  assert.equal(
    code(() => c["delivery-planning"]!(s, { by: "worker", now: T(3), items: ["A"] })),
    "missing-capability",
  );
  assert.equal(
    code(() =>
      c["delivery-planning"]!(s, { by: "service-delivery-manager", now: T(3), items: ["B"] }),
    ),
    "invalid-input",
  );
  const r = c["delivery-planning"]!(s, {
    by: "service-delivery-manager",
    now: T(3),
    items: ["A"],
    window: "week-43",
  });
  assert.deepEqual(lastEvent(r.state)!.payload, { items: ["A"], window: "week-43", delivered: [] });
  assert.equal(getItem(r.state, "A").stage, "review");
});

test("service-delivery-review changes WIP, policies and SLEs, keeps config in sync, and records before/after", () => {
  let s = withOptions();
  assert.equal(
    code(() => c["service-delivery-review"]!(s, { by: "worker", now: T(2) })),
    "missing-capability",
  );
  assert.equal(
    code(() =>
      c["service-delivery-review"]!(s, {
        by: "service-delivery-manager",
        now: T(2),
        wip: { dev: 0 },
      }),
    ),
    "invalid-input",
  );
  assert.equal(
    code(() =>
      c["service-delivery-review"]!(s, {
        by: "service-delivery-manager",
        now: T(2),
        wip: { nowhere: 1 },
      }),
    ),
    "unknown-stage",
  );
  assert.equal(
    code(() =>
      c["service-delivery-review"]!(s, {
        by: "service-delivery-manager",
        now: T(2),
        sle: { gold: { percentile: 85, targetMs: 1 } },
      }),
    ),
    "invalid-input",
  );
  assert.equal(
    rule(() =>
      c["service-delivery-review"]!(s, {
        by: "service-delivery-manager",
        now: T(2),
        policies: { dev: [] },
      }),
    ),
    "policy-explicit",
  );
  const before = JSON.stringify(s);
  assert.equal(
    code(() =>
      c["service-delivery-review"]!(s, {
        by: "service-delivery-manager",
        now: T(2),
        policies: { dev: [{ kind: "nope" }] },
      }),
    ),
    "config-invalid",
  );
  assert.equal(JSON.stringify(s), before);
  const empty = c["service-delivery-review"]!(s, { by: "service-delivery-manager", now: T(2) });
  assert.deepEqual(lastEvent(empty.state)!.payload, {
    wip: [],
    policies: [],
    sle: [],
    lessons: [],
    adopted: [],
    dismissed: [],
    agreements: [],
    retired: [],
  });
  const level = { percentile: 85, targetMs: 604_800_000 };
  const r = c["service-delivery-review"]!(s, {
    by: "service-delivery-manager",
    now: T(2),
    wip: { dev: 2, ready: null, review: 2 },
    policies: { review: [{ kind: "evidence", evidenceKind: "review-notes" }] },
    sle: { standard: level },
  });
  assert.deepEqual(r.warnings, []);
  const dev = r.state.stages.find((st) => st.id === "dev")!;
  const ready = r.state.stages.find((st) => st.id === "ready")!;
  assert.equal(dev.wipLimit, 2);
  assert.equal(ready.wipLimit, undefined);
  assert.deepEqual(r.state.stages.find((st) => st.id === "review")!.exitPolicy, [
    { kind: "evidence", evidenceKind: "review-notes" },
  ]);
  const cfg = r.state.config as {
    columns: Array<{ id: string; wipLimit?: number; policies: unknown[] }>;
    classesOfService: Record<string, { sle?: unknown }>;
  };
  assert.equal(cfg.columns.find((x) => x.id === "dev")!.wipLimit, 2);
  assert.equal(cfg.columns.find((x) => x.id === "ready")!.wipLimit, undefined);
  assert.deepEqual(cfg.columns.find((x) => x.id === "review")!.policies, [
    { kind: "evidence", evidenceKind: "review-notes" },
  ]);
  assert.deepEqual(cfg.classesOfService["standard"], { sle: level });
  assert.deepEqual(lastEvent(r.state)!.payload, {
    wip: [
      { column: "dev", before: 3, after: 2 },
      { column: "ready", before: 4, after: null },
    ],
    policies: [
      {
        column: "review",
        before: [{ kind: "no-open-blockers" }],
        after: [{ kind: "evidence", evidenceKind: "review-notes" }],
      },
    ],
    sle: [{ classOfService: "standard", before: null, after: level }],
    lessons: [],
    adopted: [],
    dismissed: [],
    agreements: [],
    retired: [],
  });
  s = moveItem(s, "A", { stage: "dev", status: "in_progress" }, "human", T(3));
  s = moveItem(s, "F", { stage: "dev", status: "in_progress" }, "human", T(3));
  const tight = c["service-delivery-review"]!(s, {
    by: "service-delivery-manager",
    now: T(4),
    wip: { dev: 1 },
  });
  assert.deepEqual(
    tight.warnings.map((w) => `${w.severity}:${w.rule}`),
    ["warning:wip-respected"],
  );
  assert.equal(tight.state.stages.find((st) => st.id === "dev")!.wipLimit, 1);
  assert.deepEqual(m.candidates(tight.state), []);
});

test("service-delivery-review keeps the column after the commitment column gated by its policies", () => {
  const s = withOptions();
  const sdm = "service-delivery-manager";
  const estimate = [{ kind: "estimate-present" }];
  const blockers = [{ kind: "no-open-blockers" }];
  let r = c["service-delivery-review"]!(s, { by: sdm, now: T(2), policies: { ready: estimate } });
  assert.deepEqual(r.state.stages.find((x) => x.id === "ready")!.exitPolicy, estimate);
  assert.deepEqual(r.state.stages.find((x) => x.id === "dev")!.entryPolicy, estimate);
  // a column that is not the commitment column does not gate its successor
  r = c["service-delivery-review"]!(r.state, { by: sdm, now: T(3), policies: { dev: blockers } });
  assert.deepEqual(r.state.stages.find((x) => x.id === "review")!.entryPolicy, []);
  r = c["service-delivery-review"]!(r.state, { by: sdm, now: T(4), policies: { ready: blockers } });
  assert.deepEqual(r.state.stages.find((x) => x.id === "dev")!.entryPolicy, blockers);
});

const SDR = "service-delivery-manager";
const AGREE = { kind: "agreement" as const, text: "name the DB in acceptance criteria" };

/** A worker finishes A and raises two lessons through its handoff (L1 and L2). */
function withRaisedLessons(): WorkflowState {
  let s = init({ methodology: m, config: {}, now: T(0) }).state;
  s = addItem(s, { id: "A", title: "a", acceptance: ["ok"] }, "human", T(1));
  s = moveItem(s, "A", { stage: "ready", status: "todo" }, "human", T(2));
  s = next(s, m, { now: T(3) }).state;
  return complete(
    s,
    m,
    {
      item: "A",
      role: "worker",
      produced: [{ kind: "test-output", ref: "ci/A" }],
      notes: "ok",
      do_not: [],
      open_questions: [],
      lessons: [
        { text: "name the DB in acceptance", scope: "spec" },
        { text: "flaky ci", scope: "review" },
      ],
    },
    {
      item: "A",
      role: "worker",
      model: "small",
      tokensIn: 50,
      tokensOut: 50,
      durationMs: 1000,
      startedAt: T(4),
      endedAt: T(4),
    },
    T(4),
  ).state;
}

test("service-delivery-review adopts a worker's lesson into an agreement the next brief carries, and dismisses another", () => {
  const s = withRaisedLessons();
  assert.deepEqual(
    s.lessons.map((l) => l.status),
    ["raised", "raised"],
  );
  const r = c["service-delivery-review"]!(s, {
    by: SDR,
    now: T(5),
    adopt: [{ id: "L1", suggestedChange: AGREE }],
    dismiss: ["L2"],
  });
  assert.deepEqual(r.state.agreements, ["name the DB in acceptance criteria"]);
  assert.deepEqual(
    r.state.lessons.map((l) => l.status),
    ["adopted", "dismissed"],
  );
  assert.deepEqual(lastEvent(r.state)!.payload, {
    wip: [],
    policies: [],
    sle: [],
    lessons: [],
    adopted: ["L1"],
    dismissed: ["L2"],
    agreements: ["name the DB in acceptance criteria"],
    retired: [],
  });
  const b = addItem(
    r.state,
    { id: "B", title: "b", acceptance: ["ok"], role: "worker" },
    "human",
    T(6),
  );
  assert.ok(
    synthesizeBrief(b, m, getItem(b, "B")).invariants.includes(
      "name the DB in acceptance criteria",
    ),
  );
});

test("service-delivery-review creates adopted lessons and stores non-agreement suggestions without making cards", () => {
  const s = withRaisedLessons();
  const r = c["service-delivery-review"]!(s, {
    by: SDR,
    now: T(5),
    lessons: [
      {
        text: "split big cards",
        scope: "policy",
        suggestedChange: { kind: "backlog", item: { id: "X", title: "x" } },
      },
    ],
  });
  assert.equal(r.state.lessons[2]!.status, "adopted");
  assert.equal(r.state.lessons[2]!.from, SDR);
  assert.equal(r.state.items["X"], undefined);
  const p = lastEvent(r.state)!.payload as { lessons: string[]; adopted: string[] };
  assert.deepEqual(p.lessons, ["L3"]);
  assert.deepEqual(p.adopted, []);
});

test("service-delivery-review rejects lesson refs that are unknown, adopted already or repeated", () => {
  const s = withRaisedLessons();
  const unknown = thrown(() =>
    c["service-delivery-review"]!(s, { by: SDR, adopt: [{ id: "L9" }] }),
  );
  assert.equal(unknown?.code, "invalid-input");
  assert.match(unknown!.fix, /raised lessons: L1, L2/);
  const done = c["service-delivery-review"]!(s, { by: SDR, now: T(5), adopt: [{ id: "L1" }] });
  assert.equal(
    code(() => c["service-delivery-review"]!(done.state, { by: SDR, dismiss: ["L1"] })),
    "invalid-input",
  );
  assert.equal(
    code(() =>
      c["service-delivery-review"]!(s, { by: SDR, adopt: [{ id: "L1" }], dismiss: ["L1"] }),
    ),
    "invalid-input",
  );
});

test("service-delivery-review retires an agreement and records agreement.retired", () => {
  const s = withRaisedLessons();
  const a = c["service-delivery-review"]!(s, {
    by: SDR,
    now: T(5),
    adopt: [{ id: "L1", suggestedChange: AGREE }],
  });
  const r = c["service-delivery-review"]!(a.state, {
    by: SDR,
    now: T(6),
    retire: ["name the DB in acceptance criteria"],
  });
  assert.deepEqual(r.state.agreements, []);
  assert.ok(r.state.events.some((e) => e.type === "agreement.retired"));
  assert.deepEqual((lastEvent(r.state)!.payload as { retired: string[] }).retired, [
    "name the DB in acceptance criteria",
  ]);
  assert.equal(
    code(() => c["service-delivery-review"]!(r.state, { by: SDR, retire: ["nope"] })),
    "invalid-input",
  );
});
