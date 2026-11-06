import { test } from "node:test";
import assert from "node:assert/strict";
import { appendEvent, createState } from "../../core/state.ts";
import { addEvidence } from "../../core/items/evidence.ts";
import { addItem, getItem } from "../../core/items/record.ts";
import { moveItem } from "../../core/items/move.ts";
import { WorkflowError } from "../../core/errors.ts";
import type { Gate, Role, Stage, WorkflowState } from "../../core/types.ts";
import {
  DEFAULT_RISK_TABLE,
  RISK_LEVELS,
  assessorIssue,
  isRiskData,
  riskEscalation,
  type RiskLevel,
  type RiskTable,
} from "./escalation.ts";

const T0 = "2026-11-06T00:00:00.000Z";
const gate: Gate = {
  id: "code-review",
  requires: [{ capability: "review" }],
  evidence: [],
  onFail: { action: "block" },
};
const opts = { gates: ["code-review"] };
const r = (id: string, caps: Role["capabilities"], canApprove: string[] = []): Role => ({
  id,
  name: id,
  modelTier: "small",
  capabilities: caps,
  canApprove,
  inputs: [],
  outputs: [],
  do_not: [],
});
const roles = [
  r("dev", ["deliver", "verify"]),
  r("rev", ["review", "verify"], ["code-review"]),
  r("risk", ["verify"]),
  r("risk2", ["verify"]),
  r("pm", ["order-backlog"]),
];
const stages: Stage[] = [
  { id: "dev", name: "Dev", entryPolicy: [], exitPolicy: [] },
  { id: "review", name: "Review", entryPolicy: [], exitPolicy: [], gate },
];
/** Item A built by dev, now dispatched to rev in the gated review stage. */
const base = (): WorkflowState => {
  let s = createState({ methodology: "kanban", config: {}, stages, roles, now: T0 });
  s = addItem(s, { id: "A", title: "a" }, "pm", T0);
  s = moveItem(s, "A", { stage: "dev", status: "in_progress" }, "dev", T0);
  s = { ...s, items: { ...s.items, A: { ...getItem(s, "A"), role: "dev" } } };
  s = moveItem(s, "A", { stage: "review", status: "review" }, "dev", T0);
  s = moveItem(s, "A", { stage: "review", status: "in_progress" }, "rev", T0);
  return { ...s, items: { ...s.items, A: { ...getItem(s, "A"), role: "rev" } } };
};
const assess = (s: WorkflowState, by: string, data: unknown, ref = `risk/${by}`) =>
  addEvidence(
    s,
    "A",
    { kind: "risk-assessment", ref, by, data: data as Record<string, unknown> },
    T0,
  );
const lv = (level: RiskLevel) => ({ level, factors: [] });
const resolve = (s: WorkflowState) => riskEscalation(s, getItem(s, "A"), gate, opts)!;

test("a gate the options do not name stays static (no escalation)", () => {
  const s = assess(base(), "risk", lv("critical"));
  assert.equal(riskEscalation(s, getItem(s, "A"), { ...gate, id: "other" }, opts), undefined);
});

test("a valid independent assessment picks its table row and names itself in the reason", () => {
  const low = resolve(assess(base(), "risk", { level: "low", factors: ["docs"], subject: "abc" }));
  assert.deepEqual(low, {
    requires: [],
    evidence: [],
    reason: { level: "low", why: "assessed", assessment: "risk/risk", by: "risk" },
  });
  const high = resolve(assess(base(), "human", lv("high")));
  assert.deepEqual(high.requires, ["human"]);
  assert.deepEqual(high.reason, {
    level: "high",
    why: "assessed",
    assessment: "risk/human",
    by: "human",
  });
});

test("missing, malformed, unqualified and author-written assessments resolve to critical", () => {
  const missing = resolve(base());
  assert.deepEqual(missing.reason, {
    level: "critical",
    why: "missing",
    assessment: null,
    by: null,
  });
  assert.deepEqual(missing.requires, ["human"]);
  for (const bad of [
    { level: "severe", factors: [] },
    { level: "low" },
    { level: "low", factors: [1] },
    { level: "low", factors: [], subject: 7 },
    undefined,
    "low",
  ])
    assert.equal(resolve(assess(base(), "risk", bad)).reason["why"], "invalid", String(bad));
  // pm lacks verify; an unknown id may do nothing
  assert.equal(resolve(assess(base(), "pm", lv("low"))).reason["why"], "invalid");
  assert.equal(resolve(assess(base(), "ghost", lv("low"))).reason["why"], "invalid");
  // dev authored the work, rev is the assigned role
  const author = resolve(assess(base(), "dev", lv("low")));
  assert.deepEqual(author.reason, {
    level: "critical",
    why: "not-independent",
    assessment: "risk/dev",
    by: "dev",
  });
  assert.equal(resolve(assess(base(), "rev", lv("low"))).reason["why"], "not-independent");
  // a valid assessment wins over a rejected one in either order
  let s = assess(assess(base(), "dev", lv("critical")), "risk", lv("low"));
  assert.equal(resolve(s).reason["level"], "low");
  s = assess(assess(base(), "risk", lv("low")), "dev", lv("critical"));
  assert.equal(resolve(s).reason["level"], "low");
});

test("the strictest valid assessment wins: a later, lower one does not relax it", () => {
  const s = assess(assess(base(), "risk", lv("high")), "risk2", lv("low"));
  assert.deepEqual(resolve(s).reason, {
    level: "high",
    why: "assessed",
    assessment: "risk/risk",
    by: "risk",
  });
});

test("rework makes an assessment stale: the gate resolves critical with reason missing", () => {
  let s = assess(base(), "risk", lv("low"));
  assert.equal(resolve(s).reason["level"], "low");
  s = appendEvent(s, "item.rework", "rev", { id: "A", by: "rev", notes: "redo" }, T0);
  assert.equal(resolve(s).reason["level"], "critical");
  assert.equal(resolve(s).reason["why"], "missing");
  s = assess(s, "risk", lv("medium"));
  assert.equal(resolve(s).reason["level"], "medium");
});

test("a custom table adds its row; the default table is deeply frozen", () => {
  const table: RiskTable = {
    low: { requires: [] },
    medium: { requires: [{ capability: "security-review" }], evidence: ["sbom"] },
    high: { requires: [{ capability: "security-review" }, "human"], evidence: ["sbom"] },
    critical: { requires: [{ capability: "security-review" }, "human"], evidence: ["sbom"] },
  };
  const s = assess(base(), "risk", lv("medium"));
  const x = riskEscalation(s, getItem(s, "A"), gate, { gates: ["code-review"], table })!;
  assert.deepEqual(x.requires, [{ capability: "security-review" }]);
  assert.deepEqual(x.evidence, ["sbom"]);
  // the result is a copy: changing it does not change the table
  (x.requires[0] as { capability: string }).capability = "x";
  assert.equal((table.medium.requires[0] as { capability: string }).capability, "security-review");
  assert.ok(
    Object.isFrozen(DEFAULT_RISK_TABLE) && Object.isFrozen(DEFAULT_RISK_TABLE.high.requires),
  );
});

test("isRiskData and assessorIssue", () => {
  assert.equal(isRiskData({ level: "low", factors: ["a"], subject: "s" }), true);
  assert.equal(isRiskData({ level: "low", factors: "a" }), false);
  const s = base();
  const item = getItem(s, "A");
  assert.equal(assessorIssue(s, item, "human"), undefined);
  assert.equal(assessorIssue(s, item, "risk"), undefined);
  assert.equal(assessorIssue(s, item, "pm"), "invalid");
  assert.equal(assessorIssue(s, item, "dev"), "not-independent");
});

// seeded LCG: no Math.random in the engine or its property tests
const lcg = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const BY = ["risk", "risk2", "human", "dev", "rev", "pm"];
const rank = (l: unknown) => RISK_LEVELS.indexOf(l as RiskLevel);

test("property: the resolved level is the strictest valid assessment, monotone and deterministic (300 seeded sets)", () => {
  const rnd = lcg(35);
  for (let n = 0; n < 300; n++) {
    let s = base();
    let strictest = -1;
    const count = Math.floor(rnd() * 6);
    for (let i = 0; i < count; i++) {
      const by = BY[Math.floor(rnd() * BY.length)]!;
      const level = RISK_LEVELS[Math.floor(rnd() * 4)]!;
      const malformed = rnd() < 0.15;
      const before = rank(resolve(s).reason["level"]);
      const hadValid = strictest >= 0;
      s = assess(s, by, malformed ? { level } : lv(level));
      const valid = !malformed && ["risk", "risk2", "human"].includes(by);
      if (valid) strictest = Math.max(strictest, rank(level));
      const after = rank(resolve(s).reason["level"]);
      // once a valid assessment exists, adding evidence never lowers the level
      if (hadValid) assert.ok(after >= before, `case ${n}: ${before} -> ${after}`);
      // invalid evidence never changes the outcome
      if (!valid) assert.equal(after, before, `case ${n}`);
    }
    const x = resolve(s);
    assert.equal(rank(x.reason["level"]), strictest >= 0 ? strictest : 3, `case ${n}`);
    // never weaker than the static gate: the escalation only adds (core widens), and the same
    // state gives the same answer
    assert.deepEqual(resolve(structuredClone(s)), x);
  }
});

test("G1-1: an earlier stage's worker may not assess when another stage sits between it and the gate", () => {
  // dev -> test -> review (gate code-review): dev built, tester tested, rev reviews
  const three: Stage[] = [
    { id: "dev", name: "Dev", entryPolicy: [], exitPolicy: [] },
    { id: "test", name: "Test", entryPolicy: [], exitPolicy: [] },
    { id: "review", name: "Review", entryPolicy: [], exitPolicy: [], gate },
  ];
  let s = createState({
    methodology: "kanban",
    config: {},
    stages: three,
    roles: [...roles, r("tester", ["verify"])],
    now: T0,
  });
  s = addItem(s, { id: "A", title: "a" }, "pm", T0);
  for (const [stage, by] of [
    ["dev", "dev"],
    ["test", "tester"],
    ["review", "rev"],
  ] as const)
    s = moveItem(s, "A", { stage, status: "in_progress" }, by, T0);
  s = { ...s, items: { ...s.items, A: { ...getItem(s, "A"), role: "rev" } } };
  for (const by of ["dev", "tester", "rev"])
    assert.equal(assessorIssue(s, getItem(s, "A"), by), "not-independent", by);
  assert.equal(assessorIssue(s, getItem(s, "A"), "risk"), undefined);
  // dev's own low assessment is rejected at gate time: critical, a human is required
  const own = resolve(assess(s, "dev", lv("low")));
  assert.deepEqual(own.requires, ["human"]);
  assert.deepEqual([own.reason["level"], own.reason["why"]], ["critical", "not-independent"]);
});

test("G1-6: riskEscalation validates its options like withRiskGate: invalid-input, never a TypeError", () => {
  const s = assess(base(), "risk", lv("low"));
  const bad = (options: unknown, re: RegExp) =>
    assert.throws(
      () => riskEscalation(s, getItem(s, "A"), gate, options as never),
      (e) => e instanceof WorkflowError && e.code === "invalid-input" && re.test(e.message),
      JSON.stringify(options),
    );
  bad({}, /riskEscalation options: gates must be an array/);
  bad(null, /must be an object/);
  const { critical: _drop, ...partial } = DEFAULT_RISK_TABLE;
  bad({ gates: ["code-review"], table: partial }, /missing level "critical"/);
  bad(
    { gates: ["code-review"], table: { ...DEFAULT_RISK_TABLE, low: { requires: ["human"] } } },
    /table\.medium must include/,
  );
});
