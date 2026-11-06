import { test } from "node:test";
import assert from "node:assert/strict";
import { createState } from "../core/state.ts";
import { addItem, getItem } from "../core/items/record.ts";
import { moveItem } from "../core/items/move.ts";
import { WorkflowError } from "../core/errors.ts";
import type { Gate, GateEscalation, Methodology, WorkflowState } from "../core/types.ts";
import { DEFAULT_RISK_TABLE } from "../common/risk/escalation.ts";
import { kanban } from "../methodologies/kanban/index.ts";
import { createMethodologyRegistry } from "./registry.ts";
import { withRiskGate } from "./policies.ts";

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
