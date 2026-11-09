// Context-grounded entry on a Kanban board (design spec section 27, #36): the report's walkthrough.
// A scout records what it verified, the planner dispatches only grounded cards, a repository
// change makes an in-flight card's snapshot stale (a warning, no status change) and a todo card's
// (not dispatched), and a refreshed snapshot grounds it again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, workflowStateSchema } from "../src/schema/index.ts";
import {
  addEvidence,
  addItem,
  complete,
  getItem,
  init,
  next,
  synthesizeBrief,
} from "../src/index.ts";
import { kanban } from "../src/methodologies/kanban/index.ts";
import {
  recordContextSnapshot,
  recordRepoChange,
  withContextGrounding,
  withRiskGate,
} from "../src/policies/index.ts";
import type { Accounting, ContextAssumption, Handoff, Role, WorkflowState } from "../src/index.ts";

const MIN = 60_000;
let clock = Date.parse("2026-11-06T09:00:00.000Z");
const tick = () => new Date((clock += MIN)).toISOString();
const srm = "service-request-manager";
const plain = kanban();
const m = withContextGrounding(plain, { entry: ["dev"] });
const scout: Role = {
  id: "scout",
  name: "Scout",
  modelTier: "small",
  capabilities: ["verify"],
  canApprove: [],
  inputs: [],
  outputs: [],
  do_not: [],
};
const src = (path: string) => ({ path, hash: `sha-${path}` });

function board(): WorkflowState {
  const config = m.validateConfig({});
  const roles = [...m.defaultRoles(config), scout];
  let s = init({ methodology: m, config: {}, roles, now: tick() }).state;
  for (const id of ["A", "B", "C"])
    s = addItem(s, { id, title: `card ${id}`, acceptance: ["works"] }, srm, tick());
  s = addItem(s, { id: "W", title: "card W", acceptance: ["works"], role: "worker" }, srm, tick());
  return m.ceremonies["replenishment"]!(s, { by: srm, now: tick(), items: ["A", "B", "C", "W"] })
    .state;
}
const snapshot = (s: WorkflowState, item: string, assumptions: ContextAssumption[], by = "scout") =>
  recordContextSnapshot(s, m, {
    item,
    revision: "r1",
    assumptions,
    ref: `ctx/${item}.json`,
    by,
    now: tick(),
  }).state;
const skippedIds = (r: ReturnType<typeof next>) =>
  r.skipped.filter((x) => x.reason === "entry-policy").map((x) => x.id);

test("kanban: only grounded cards are dispatched; repo.changed stales snapshots; a refresh grounds again", () => {
  let s = board();
  assert.ok(
    s.stages
      .find((st) => st.id === "dev")!
      .entryPolicy.some((p) => p.kind === "custom" && p.id === "context-grounded"),
  );
  // nothing is grounded yet: every card is skipped by the entry policy
  let r = next(s, m, { now: tick() });
  assert.deepEqual(r.briefs, []);
  assert.deepEqual(skippedIds(r).sort(), ["A", "B", "C", "W"]);

  const cents: ContextAssumption = {
    claim: "cart totals are integer cents",
    required: true,
    source: { ...src("src/cart.ts"), lines: [10, 24] },
  };
  s = snapshot(s, "A", [cents, { claim: "no caching layer" }]);
  s = snapshot(s, "B", [cents, { claim: "tax is applied once", required: true }]);
  s = snapshot(s, "C", [
    { claim: "prices come from the catalog", required: true, source: src("src/catalog.ts") },
  ]);
  // W's assigned worker may not scout its own card: the recorder refuses it, and a hand-written
  // snapshot by the worker does not count
  assert.throws(() => snapshot(s, "W", [cents], "worker"), /worked on the item/);
  s = addEvidence(
    s,
    "W",
    {
      kind: "context-snapshot",
      ref: "ctx/W.json",
      by: "worker",
      data: { revision: "r1", assumptions: [cents] } as never,
    },
    tick(),
  );
  // the catalog changes before C is dispatched: C's snapshot is stale
  const early = recordRepoChange(s, m, {
    revision: "r2",
    paths: ["src/catalog.ts"],
    by: "ci",
    now: tick(),
  });
  assert.deepEqual(
    early.warnings,
    [],
    "a todo card gets no warning; its entry policy re-checks it",
  );
  s = early.state;

  r = next(s, m, { now: tick() });
  assert.deepEqual(
    r.briefs.map((b) => b.item.id),
    ["A"],
  );
  const detail = Object.fromEntries(r.skipped.map((x) => [x.id, x.detail]));
  assert.match(detail["B"]!, /unverified required assumption\(s\): tax is applied once/);
  assert.match(detail["C"]!, /stale: src\/catalog\.ts/);
  assert.match(detail["W"]!, /no qualifying context snapshot/);
  // the worker's brief carries what was verified, where, and what was not
  assert.deepEqual(r.briefs[0]!.context, {
    revision: "r1",
    assumptions: [cents, { claim: "no caching layer" }],
    snapshot: "ctx/A.json",
    by: "scout",
    stale: [],
    unverified: ["no caching layer"],
  });
  s = r.state;
  assert.equal(getItem(s, "A").status, "in_progress");

  // the cart changes while A is in progress: a context-stale warning, no status change
  const change = recordRepoChange(s, m, {
    revision: "r3",
    paths: ["README.md", "src/cart.ts"],
    by: "ci",
    now: tick(),
  });
  assert.deepEqual(
    change.warnings.map((w) => [w.rule, w.item]),
    [["context-stale", "A"]],
  );
  assert.match(change.warnings[0]!.message, /src\/cart\.ts changed at r3/);
  s = change.state;
  assert.equal(getItem(s, "A").status, "in_progress");
  assert.deepEqual(synthesizeBrief(s, m, getItem(s, "A")).context!.stale, ["src/cart.ts"]);

  // refreshed snapshots ground A's brief and C again; B cites a source for its claim now
  s = snapshot(s, "A", [cents]);
  assert.deepEqual(synthesizeBrief(s, m, getItem(s, "A")).context!.stale, []);
  s = snapshot(s, "C", [
    { claim: "prices come from the catalog", required: true, source: src("src/catalog.ts") },
  ]);
  s = snapshot(s, "B", [
    cents,
    { claim: "tax is applied once", required: true, source: src("src/tax.ts") },
  ]);
  s = snapshot(s, "W", [cents], "human");
  r = next(s, m, { now: tick() });
  assert.deepEqual(r.briefs.map((b) => b.item.id).sort(), ["B", "C"]);
  // W is grounded now (a human's snapshot): it passes the entry policy and waits on dev's WIP limit
  assert.deepEqual(
    r.skipped.map((x) => [x.id, x.reason]),
    [["W", "wip"]],
  );
  s = r.state;

  // A finishes; the state with snapshot data validates and survives a JSON round trip
  const by = getItem(s, "A").role!;
  const h: Handoff = {
    item: "A",
    role: by,
    produced: [{ kind: "test-output", ref: "ci/A" }],
    notes: "done",
    do_not: [],
    open_questions: [],
    verdict: "needs-review",
  };
  const acc: Accounting = {
    item: "A",
    role: by,
    model: "small",
    tokensIn: 10,
    tokensOut: 10,
    durationMs: 1,
    startedAt: tick(),
    endedAt: tick(),
  };
  s = complete(s, m, h, acc, tick()).state;
  const loaded = JSON.parse(JSON.stringify(s)) as WorkflowState;
  assert.doesNotThrow(() => assertValid(workflowStateSchema, loaded, "state"));
  assert.deepEqual(loaded, s);
  assert.ok(loaded.events.some((e) => e.type === "repo.changed"));
});

test("#47: the plain methodology fails closed on the reserved policy, even with policy:context-grounded evidence", () => {
  let s = board();
  s = snapshot(s, "A", [{ claim: "c", required: true, source: src("src/a.ts") }]);
  s = addEvidence(s, "B", { kind: "policy:context-grounded", ref: "self", by: "worker" }, tick());
  const r = next(s, plain, { now: tick() });
  assert.deepEqual(r.briefs, []);
  assert.ok(skippedIds(r).includes("A"));
  assert.ok(skippedIds(r).includes("B"));
  assert.match(r.skipped.find((x) => x.id === "B")!.detail!, /context-grounding hook/);
});

test("context grounding composes with the risk gate", () => {
  const both = withContextGrounding(withRiskGate(plain, { gates: ["code-review"] }), {
    entry: ["dev"],
  });
  assert.equal(both.name, "kanban");
  assert.equal(typeof both.escalateGate, "function");
  let s = board();
  s = snapshot(s, "A", [{ claim: "c", required: true, source: src("src/a.ts") }]);
  assert.deepEqual(
    next(s, both, { now: tick() }).briefs.map((b) => b.item.id),
    ["A"],
  );
});
