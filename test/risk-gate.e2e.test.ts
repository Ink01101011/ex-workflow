// Risk-adaptive gate on a Kanban board (design spec section 27, #35): the report's walkthrough.
// A low-risk card passes the review gate on the reviewer's approval, a high-risk one waits for a
// human, and rework makes an assessment stale so the gate resolves critical.
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, workflowStateSchema } from "../src/schema/index.ts";
import { addItem, complete, decide, getItem, init, next } from "../src/index.ts";
import { kanban } from "../src/methodologies/kanban/index.ts";
import { recordRiskAssessment, withRiskGate } from "../src/policies.ts";
import type { Accounting, Handoff, Role, WorkflowError, WorkflowState } from "../src/index.ts";

const MIN = 60_000;
let clock = Date.parse("2026-11-06T09:00:00.000Z");
const tick = () => new Date((clock += MIN)).toISOString();
const srm = "service-request-manager";
const plain = kanban();
const m = withRiskGate(plain, { gates: ["code-review"] });
const role = (id: string, caps: Role["capabilities"], canApprove: string[] = []): Role => ({
  id,
  name: id,
  modelTier: "small",
  capabilities: caps,
  canApprove,
  inputs: [],
  outputs: [],
  do_not: [],
});
const h = (item: string, by: string, over: Partial<Handoff> = {}): Handoff => ({
  item,
  role: by,
  produced: by === "worker" ? [{ kind: "test-output", ref: `ci/${item}` }] : [],
  notes: `${item} by ${by}`,
  do_not: [],
  open_questions: [],
  ...over,
});
const acc = (item: string, by: string): Accounting => ({
  item,
  role: by,
  model: "small-worker",
  tokensIn: 300,
  tokensOut: 200,
  durationMs: 1000,
  startedAt: tick(),
  endedAt: tick(),
});
const code = (e: unknown) => (e as WorkflowError).code;

function board(): WorkflowState {
  const config = m.validateConfig({});
  const stages = m.defaultStages(config).map((st) =>
    st.id === "review"
      ? {
          ...st,
          gate: {
            id: "code-review",
            requires: [{ capability: "review" }],
            evidence: [],
            onFail: { action: "return-to" as const, stage: "dev" },
          },
        }
      : st,
  );
  const roles = [
    ...m.defaultRoles(config),
    role("reviewer", ["review"], ["code-review"]),
    role("assessor", ["verify"]),
  ];
  let s = init({ methodology: m, config: {}, stages, roles, now: tick() }).state;
  for (const id of ["L", "H", "R"])
    s = addItem(s, { id, title: `card ${id}`, acceptance: ["works"] }, srm, tick());
  return m.ceremonies["replenishment"]!(s, { by: srm, now: tick(), items: ["L", "H", "R"] }).state;
}

/** Dispatches what the planner offers (unless `id` is already in progress) and completes `id` as its role. */
function work(s: WorkflowState, id: string, over: Partial<Handoff> = {}, meth = m): WorkflowState {
  if (getItem(s, id).status !== "in_progress") s = next(s, meth, { now: tick() }).state;
  const by = getItem(s, id).role;
  assert.equal(getItem(s, id).status, "in_progress", `${id} dispatched`);
  return complete(s, meth, h(id, by!, over), acc(id, by!), tick()).state;
}
const assess = (s: WorkflowState, item: string, level: "low" | "high", by = "assessor") =>
  recordRiskAssessment(s, m, {
    item,
    level,
    factors: level === "high" ? ["prod-infra"] : ["docs"],
    ref: `risk/${item}.md`,
    by,
    now: tick(),
  }).state;
const resolutions = (s: WorkflowState, item: string) =>
  s.events
    .filter((e) => e.type === "gate.resolved" && (e.payload as { item: string }).item === item)
    .map((e) => e.payload as { requires: unknown[]; reason: Record<string, string | null> });

test("kanban: low passes on review, high raises a human pending, rework makes it stale", () => {
  let s = board();
  // the worker builds each card; it may not assess its own work
  for (const id of ["L", "H", "R"]) s = work(s, id);
  assert.equal(getItem(s, "L").status, "review");
  assert.throws(
    () => assess(s, "L", "low", "worker"),
    (e) => code(e) === "invalid-input",
  );
  s = assess(s, "L", "low");
  s = assess(s, "H", "high");
  s = assess(s, "R", "low");

  // low: the reviewer's approval is enough; gate.resolved names the level and the assessment
  s = work(s, "L");
  assert.equal(getItem(s, "L").status, "done");
  const [low] = resolutions(s, "L");
  assert.deepEqual(low!.reason, {
    level: "low",
    why: "assessed",
    assessment: "risk/L.md",
    by: "assessor",
  });
  assert.deepEqual(low!.requires, [{ capability: "review" }]);

  // high: the static gate would pass on the reviewer, the resolved one waits for a human
  s = work(s, "H");
  assert.equal(getItem(s, "H").status, "awaiting_human");
  assert.equal(resolutions(s, "H")[0]!.reason["level"], "high");
  const pending = s.pending.find((p) => p.item === "H")!;
  assert.throws(
    () => decide(s, pending.id, "approve", "reviewer", "lgtm", tick(), m),
    (e) => code(e) === "gate-unmet",
  );
  s = decide(s, pending.id, "approve", "human", "ok", tick(), m);
  assert.equal(getItem(s, "H").status, "done");

  // rework: the reviewer sends R back; the low assessment is stale, so the gate resolves critical
  s = work(s, "R", { verdict: "rework", notes: "missing a test" });
  assert.equal(getItem(s, "R").status, "todo");
  s = work(s, "R");
  assert.equal(getItem(s, "R").status, "review");
  s = work(s, "R");
  assert.equal(getItem(s, "R").status, "awaiting_human");
  assert.deepEqual(resolutions(s, "R").at(-1)!.reason, {
    level: "critical",
    why: "missing",
    assessment: null,
    by: null,
  });
  assertValid(workflowStateSchema, s, "state");

  // the plain methodology checks the static gate only (the 1.2 contract)
  let p = board();
  for (const id of ["L", "H", "R"]) p = work(p, id, {}, plain);
  p = assess(p, "H", "high");
  p = work(p, "H", {}, plain);
  assert.equal(getItem(p, "H").status, "done");
  assert.equal(resolutions(p, "H").length, 0);
});
