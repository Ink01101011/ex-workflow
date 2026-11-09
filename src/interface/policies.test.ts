import { test } from "node:test";
import assert from "node:assert/strict";
import { createState } from "../core/state.ts";
import { addItem, getItem } from "../core/items/record.ts";
import { moveItem } from "../core/items/move.ts";
import { WorkflowError } from "../core/errors.ts";
import type { Gate, GateEscalation, Methodology, Policy, WorkflowState } from "../core/types.ts";
import { DEFAULT_RISK_TABLE } from "../common/risk/escalation.ts";
import { kanban } from "../methodologies/kanban/index.ts";
import { createMethodologyRegistry } from "./registry.ts";
import { withContextGrounding, withRiskGate } from "./policies.ts";

const T0 = "2026-11-06T00:00:00.000Z";
const gate: Gate = { id: "code-review", requires: [], evidence: [], onFail: { action: "block" } };
const state = (): WorkflowState => {
  const m = kanban();
  const config = m.validateConfig({});
  let s = createState({
    methodology: "kanban",
    config,
    stages: m.defaultStages(config),
    roles: m.defaultRoles(config),
    now: T0,
  });
  s = addItem(s, { id: "A", title: "a" }, "service-request-manager", T0);
  return moveItem(s, "A", { stage: "dev", status: "in_progress" }, "worker", T0);
};
const invalid = (options: unknown, re: RegExp) =>
  assert.throws(
    () => withRiskGate(kanban(), options as never),
    (e) => e instanceof WorkflowError && e.code === "invalid-input" && re.test(e.message),
    JSON.stringify(options),
  );

test("withRiskGate keeps every member and the name; a registry accepts the wrapped factory", () => {
  const plain = kanban();
  const m = withRiskGate(plain, { gates: ["code-review"] });
  assert.equal(m.name, "kanban");
  for (const k of Object.keys(plain) as (keyof Methodology)[]) assert.equal(m[k], plain[k], k);
  assert.equal(typeof m.escalateGate, "function");
  const reg = createMethodologyRegistry({});
  reg.registerMethodology("kanban", () => withRiskGate(kanban(), { gates: ["code-review"] }));
  assert.equal(reg.methodologyFactory("kanban")().name, "kanban");
});

test("the hook answers the default table for the named gates only", () => {
  const m = withRiskGate(kanban(), { gates: ["code-review"] });
  const s = state();
  const x = m.escalateGate!(s, getItem(s, "A"), gate)!;
  assert.deepEqual(x.requires, DEFAULT_RISK_TABLE.critical.requires);
  assert.equal(x.reason["why"], "missing");
  assert.equal(m.escalateGate!(s, getItem(s, "A"), { ...gate, id: "other" }), undefined);
});

test("an existing escalateGate is composed: both widen the gate", () => {
  const inner: GateEscalation = {
    requires: [{ capability: "security" }],
    evidence: ["sbom"],
    reason: { inner: "yes" },
  };
  const base = { ...kanban(), escalateGate: () => inner };
  const m = withRiskGate(base, { gates: ["code-review"] });
  const s = state();
  assert.deepEqual(m.escalateGate!(s, getItem(s, "A"), gate), {
    requires: [{ capability: "security" }, "human"],
    evidence: ["sbom"],
    reason: { inner: "yes", level: "critical", why: "missing", assessment: null, by: null },
  });
  // a gate only the inner hook answers keeps the inner answer
  assert.deepEqual(m.escalateGate!(s, getItem(s, "A"), { ...gate, id: "other" }), inner);
  // wrapping twice composes too
  const twice = withRiskGate(m, { gates: ["code-review"] });
  assert.deepEqual(twice.escalateGate!(s, getItem(s, "A"), gate)!.requires, [
    { capability: "security" },
    "human",
    "human",
  ]);
});

test("options are validated once and copied", () => {
  invalid(null, /must be an object/);
  invalid({}, /gates must be an array/);
  invalid({ gates: [""] }, /not a valid id/);
  invalid({ gates: ["toString"] }, /not a valid id/);
  invalid({ gates: ["g"], extra: 1 }, /unknown key "extra"/);
  invalid({ gates: ["g"], table: [] }, /table must be an object/);
  const { critical: _drop, ...partial } = DEFAULT_RISK_TABLE;
  invalid({ gates: ["g"], table: partial }, /missing level "critical"/);
  invalid({ gates: ["g"], table: { ...DEFAULT_RISK_TABLE, severe: { requires: [] } } }, /"severe"/);
  for (const q of ["robot", { capability: "" }, { capability: 3 }, { capability: "x", y: 1 }])
    invalid(
      { gates: ["g"], table: { ...DEFAULT_RISK_TABLE, low: { requires: [q] } } },
      /table\.low\.requires\[0\]/,
    );
  invalid(
    { gates: ["g"], table: { ...DEFAULT_RISK_TABLE, low: { requires: [], evidence: [1] } } },
    /table\.low\.evidence/,
  );
  invalid(
    { gates: ["g"], table: { ...DEFAULT_RISK_TABLE, low: { requires: {} } } },
    /table\.low\.requires must be an array/,
  );
  // G1-4, G2-10: each level must include what the level below it adds
  invalid(
    {
      gates: ["g"],
      table: { ...DEFAULT_RISK_TABLE, low: { requires: ["human"] }, critical: { requires: [] } },
    },
    /table\.medium must include .*"human"/,
  );
  invalid(
    { gates: ["g"], table: { ...DEFAULT_RISK_TABLE, low: { requires: [], evidence: ["sbom"] } } },
    /table\.medium must include .*"sbom"/,
  );
  invalid(
    {
      gates: ["g"],
      table: {
        ...DEFAULT_RISK_TABLE,
        high: { requires: ["human", { capability: "security-review" }] },
      },
    },
    /table\.critical must include .*security-review/,
  );
  // G5-4: requirements and evidence kinds are separate sets: evidence "human" is not requirement "human"
  for (const [lo, hi] of [
    [{ requires: ["human"] }, { requires: [], evidence: ["human"] }],
    [{ requires: [], evidence: ["human"] }, { requires: ["human"] }],
  ])
    invalid(
      { gates: ["g"], table: { low: lo, medium: hi, high: hi, critical: hi } },
      /table\.medium must include .*"human"/,
    );
  // G5-5: options, the table and its rows are read as own properties only
  invalid(Object.create({ gates: ["g"] }), /gates must be an array/);
  invalid({ gates: ["g"], table: Object.create(DEFAULT_RISK_TABLE) }, /missing level "low"/);
  invalid(
    { gates: ["g"], table: { ...DEFAULT_RISK_TABLE, low: Object.create({ requires: [] }) } },
    /table\.low\.requires must be an array/,
  );
  // a superset in another order, or with more, is fine
  withRiskGate(kanban(), {
    gates: ["g"],
    table: {
      low: { requires: [] },
      medium: { requires: [{ capability: "security-review" }], evidence: ["sbom"] },
      high: { requires: ["human", { capability: "security-review" }], evidence: ["sbom"] },
      critical: {
        requires: [{ capability: "security-review" }, "human"],
        evidence: ["sbom", "pentest"],
      },
    },
  });
  const table = structuredClone({ ...DEFAULT_RISK_TABLE }) as unknown as Record<
    string,
    { requires: unknown[] }
  >;
  const gates = ["code-review"];
  const m = withRiskGate(kanban(), { gates, table: table as never });
  gates.push("other");
  table["critical"]!.requires.length = 0;
  const s = state();
  assert.deepEqual(m.escalateGate!(s, getItem(s, "A"), gate)!.requires, ["human"]);
  assert.equal(m.escalateGate!(s, getItem(s, "A"), { ...gate, id: "other" }), undefined);
});

// ---- #36 withContextGrounding (design spec section 27) -----------------
const GROUNDED = "context-grounded";
const groundingInvalid = (options: unknown, re: RegExp) =>
  assert.throws(
    () => withContextGrounding(kanban(), options as never),
    (e) => e instanceof WorkflowError && e.code === "invalid-input" && re.test(e.message),
    JSON.stringify(options),
  );
const custom = (list: Policy[]) =>
  list.filter((p) => p.kind === "custom" && p.id === GROUNDED).length;

test("withContextGrounding keeps every other member and the name; a registry accepts it", () => {
  const plain = kanban();
  const m = withContextGrounding(plain, { entry: ["dev"] });
  assert.equal(m.name, "kanban");
  const own = ["defaultStages", "customPolicy", "briefContext"];
  for (const k of Object.keys(plain) as (keyof Methodology)[])
    if (!own.includes(k)) assert.equal(m[k], plain[k], k);
  const reg = createMethodologyRegistry({});
  reg.registerMethodology("kanban", () => withContextGrounding(kanban(), { entry: ["dev"] }));
  assert.equal(reg.methodologyFactory("kanban")().name, "kanban");
});

test("defaultStages appends the custom policy to the entry and exit stages named, once", () => {
  const plain = kanban();
  const config = plain.validateConfig({});
  const before = plain.defaultStages(config);
  const m = withContextGrounding(plain, { entry: ["dev"], exit: ["dev", "review"] });
  const stages = m.defaultStages(config);
  for (const st of stages) {
    const was = before.find((b) => b.id === st.id)!;
    assert.equal(custom(st.entryPolicy), st.id === "dev" ? 1 : 0, `${st.id} entry`);
    assert.equal(custom(st.exitPolicy), ["dev", "review"].includes(st.id) ? 1 : 0, `${st.id} exit`);
    // the original policies are kept, in order, before the new one
    assert.deepEqual(st.entryPolicy.slice(0, was.entryPolicy.length), was.entryPolicy);
    assert.deepEqual(st.exitPolicy.slice(0, was.exitPolicy.length), was.exitPolicy);
  }
  // the wrapped methodology's stages are not mutated, and wrapping twice adds nothing more
  assert.deepEqual(plain.defaultStages(config), before);
  const twice = withContextGrounding(m, { entry: ["dev"] }).defaultStages(config);
  assert.equal(custom(twice.find((st) => st.id === "dev")!.entryPolicy), 1);
  assert.throws(
    () => withContextGrounding(plain, { entry: ["nope"] }).defaultStages(config),
    (e) => e instanceof WorkflowError && e.code === "invalid-input" && /"nope"/.test(e.message),
  );
});

test("customPolicy answers context-grounded and delegates any other id to the wrapped hook", () => {
  const s = state();
  const item = getItem(s, "A");
  const grounded = { kind: "custom" as const, id: GROUNDED, description: "d" };
  const lint = { kind: "custom" as const, id: "lint", description: "d" };
  const m = withContextGrounding(kanban(), { entry: ["dev"] });
  assert.deepEqual(
    m.customPolicy!(s, item, grounded)!.map((v) => v.rule),
    ["policy:custom:context-grounded"],
  );
  assert.equal(m.customPolicy!(s, item, lint), undefined);
  const inner = withContextGrounding({ ...kanban(), customPolicy: () => [] }, { entry: [] });
  assert.deepEqual(inner.customPolicy!(s, item, lint), []);
  assert.equal(inner.briefContext!(s, item), undefined);
  const withBrief = withContextGrounding(
    {
      ...kanban(),
      briefContext: () => ({
        revision: "x",
        assumptions: [],
        snapshot: "s",
        by: "b",
        stale: [],
        unverified: [],
      }),
    },
    { entry: [] },
  );
  assert.equal(withBrief.briefContext!(s, item)!.snapshot, "s");
});

test("withContextGrounding options are validated once and copied", () => {
  groundingInvalid(null, /must be an object/);
  groundingInvalid({}, /entry must be an array/);
  groundingInvalid({ entry: [""] }, /not a valid id/);
  groundingInvalid({ entry: ["dev"], exit: "dev" }, /exit must be an array/);
  groundingInvalid({ entry: ["dev"], extra: 1 }, /unknown key "extra"/);
  const entry = ["dev"];
  const m = withContextGrounding(kanban(), { entry });
  entry.push("review");
  const config = kanban().validateConfig({});
  const review = m.defaultStages(config).find((st) => st.id === "review")!;
  assert.equal(custom(review.entryPolicy), 0);
});

test("withContextGrounding refuses a stage whose policies a built-in ceremony checks (spec 28)", async () => {
  const { scrum } = await import("../methodologies/scrum/index.ts");
  const { experimentation } = await import("../methodologies/experimentation/index.ts");
  const refused = (fn: () => unknown, re: RegExp) =>
    assert.throws(
      fn,
      (e) => e instanceof WorkflowError && e.code === "invalid-input" && re.test(e.message),
    );
  const k = kanban();
  refused(
    () =>
      withContextGrounding(k, { entry: [], exit: ["options"] }).defaultStages(k.validateConfig({})),
    /kanban ceremony .* out of "options"/,
  );
  const sc = scrum();
  const cfg = sc.validateConfig({
    sprintBudget: { tokens: 1 },
    productGoal: "g",
    definitionOfDone: [],
  });
  refused(
    () => withContextGrounding(sc, { entry: [], exit: ["backlog"] }).defaultStages(cfg),
    /scrum ceremony/,
  );
  const ex = experimentation();
  const ecfg = ex.validateConfig({ objective: "o" });
  refused(
    () => withContextGrounding(ex, { entry: ["building"] }).defaultStages(ecfg),
    /experimentation ceremony .* into "building"/,
  );
  // a stage no ceremony checks is fine
  assert.ok(
    withContextGrounding(k, { entry: ["dev"] }).defaultStages(k.validateConfig({})).length > 0,
  );
});
