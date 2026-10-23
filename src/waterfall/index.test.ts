import { test } from "node:test";
import assert from "node:assert/strict";
import { init } from "../methodology.ts";
import { addItem, getItem } from "../items.ts";
import { next } from "../brief.ts";
import { WorkflowError } from "../errors.ts";
import { DEFAULT_PHASE_IDS, GATE_ID, validateWaterfallConfig } from "./config.ts";
import {
  currentPhase,
  isFrozen,
  missingDeliverables,
  openPhase,
  phaseOf,
  phasesOf,
  withPhases,
} from "./phases.ts";
import { deliverRoleFor, phaseReport, waterfall } from "./index.ts";

const T0 = "2026-10-22T00:00:00.000Z";
const T1 = "2026-10-22T01:00:00.000Z";
const bad = (cfg: unknown, re: RegExp) =>
  assert.throws(
    () => validateWaterfallConfig(cfg),
    (e: unknown) => e instanceof WorkflowError && e.code === "config-invalid" && re.test(e.message),
  );

test("validateWaterfallConfig applies defaults and names bad fields", () => {
  const c = validateWaterfallConfig({});
  assert.deepEqual(
    c.phases.map((p) => p.id),
    DEFAULT_PHASE_IDS,
  );
  assert.deepEqual(c.phases[0]!.deliverables, ["srs"]);
  assert.deepEqual(c.phases[3]!.deliverables, ["test-report", "traceability-matrix"]);
  assert.deepEqual(c.phases[1]!.gate, {
    id: "design-gate",
    requires: ["human", { capability: "approve-gate" }],
    evidence: [],
    onFail: { action: "block" },
  });
  assert.equal(c.phases[1]!.deliverBy, "architect");
  assert.equal(c.phases[2]!.deliverBy, undefined);
  assert.deepEqual(c.changeControl, {
    requiresImpactAnalysis: true,
    approvers: ["human", { capability: "control-change" }],
  });
  assert.deepEqual(c.traceability, { from: "requirements", to: ["design", "verification"] });
  assert.equal(c.humanGates, "all");
  const some = validateWaterfallConfig({ humanGates: ["verification"] });
  assert.deepEqual(some.phases[0]!.gate.requires, [{ capability: "approve-gate" }]);
  assert.deepEqual(some.phases[3]!.gate.requires, ["human", { capability: "approve-gate" }]);
  const custom = validateWaterfallConfig({
    phases: [{ id: "spec" }, { id: "build", budget: { tokens: 10 } }],
  });
  assert.deepEqual(custom.traceability, { from: "spec", to: [] });
  assert.deepEqual(custom.phases[1]!.budget, { tokens: 10 });
  assert.equal(custom.phases[0]!.name, "Spec");
  assert.deepEqual(custom.phases[0]!.deliverables, []);
  bad({ phases: 5 }, /phases/);
  bad({ phases: [] }, /at least one phase/);
  bad({ phases: [{ id: "a" }, { id: "a" }] }, /duplicate phase id "a"/);
  bad({ phases: [{ id: "a", deliverables: "srs" }] }, /deliverables/);
  bad({ phases: [{ id: "a", budget: { tokens: -1 } }] }, /budget/);
  bad({ traceability: { from: "nope", to: [] } }, /traceability\.from/);
  bad({ traceability: { from: "design", to: ["requirements"] } }, /traceability\.to.*after/);
  bad({ humanGates: ["nope"] }, /humanGates/);
  bad({ changeControl: { approvers: [] } }, /approvers/);
  bad({ changeControl: { approvers: [{ capability: "fly" }] } }, /approvers/);
});

test("init with waterfall builds work/review/done, six roles and no phases yet", () => {
  const { state, warnings } = init({ methodology: waterfall(), config: {}, now: T0 });
  assert.deepEqual(
    state.stages.map((s) => s.id),
    ["work", "review", "done"],
  );
  assert.equal(state.stages[1]!.review, true);
  assert.deepEqual(state.stages[0]!.entryPolicy, [{ kind: "dependencies-done" }]);
  assert.deepEqual(Object.keys(state.roles), [
    "project-manager",
    "developer",
    "business-analyst",
    "architect",
    "qa",
    "release-manager",
  ]);
  assert.deepEqual(state.roles["project-manager"]!.canApprove, [
    ...DEFAULT_PHASE_IDS.map(GATE_ID),
    "change-control",
  ]);
  assert.deepEqual(warnings, []);
  assert.equal(state.phases, undefined);
  assert.deepEqual(
    phasesOf(state).map((p) => [p.id, p.status]),
    DEFAULT_PHASE_IDS.map((id) => [id, "pending"]),
  );
  assert.equal(currentPhase(state)!.id, "requirements");
  assert.equal(openPhase(state), undefined);
  assert.equal(waterfall().vocabulary.iteration, "Phase");
  assert.equal(waterfall().humanDefaults.gates, "all");
});

test("init fails resolvingly when a required capability has no role", () => {
  const roles = waterfall()
    .defaultRoles(validateWaterfallConfig({}))
    .filter((r) => r.id !== "qa");
  assert.throws(
    () => init({ methodology: waterfall(), config: {}, roles, now: T0 }),
    (e: unknown) =>
      e instanceof WorkflowError && e.code === "missing-capability" && /verify/.test(e.message),
  );
});

function project() {
  let s = init({ methodology: waterfall(), config: {}, now: T0 }).state;
  s = addItem(
    s,
    { id: "R1", title: "login", phase: "requirements", acceptance: ["ok"] },
    "human",
    T0,
  );
  // an escalation question is born with the thinker's role (core complete() sets it); mirror that here
  s = addItem(
    s,
    { id: "R1-q1", title: "q", type: "question", parent: "R1", role: "project-manager" },
    "human",
    T0,
  );
  s = addItem(
    s,
    { id: "D1", title: "auth design", phase: "design", acceptance: ["ok"] },
    "human",
    T0,
  );
  s = addItem(s, { id: "CR-1", title: "change", type: "change-request" }, "human", T0);
  return s;
}

test("phaseOf follows parents; candidates are the open phase's todo/review items, never change-requests", () => {
  let s = project();
  assert.equal(phaseOf(s, getItem(s, "R1")), "requirements");
  assert.equal(phaseOf(s, getItem(s, "R1-q1")), "requirements");
  assert.equal(phaseOf(s, getItem(s, "CR-1")), undefined);
  assert.deepEqual(waterfall().candidates(s), []);
  s = withPhases(
    s,
    phasesOf(s).map((p) => (p.id === "requirements" ? { ...p, status: "open" } : p)),
  );
  assert.deepEqual(
    new Set(
      waterfall()
        .candidates(s)
        .map((i) => i.id),
    ),
    new Set(["R1", "R1-q1"]),
  );
  assert.equal(openPhase(s)!.id, "requirements");
  assert.equal(isFrozen(s, getItem(s, "R1")), false);
  s = withPhases(
    s,
    phasesOf(s).map((p) => (p.id === "requirements" ? { ...p, status: "baselined" } : p)),
  );
  assert.equal(isFrozen(s, getItem(s, "R1")), true);
  assert.equal(isFrozen(s, getItem(s, "R1-q1")), true);
  assert.equal(currentPhase(s)!.id, "design");
});

test("next dispatches the phase's deliverer (deliverBy, else the first deliver role) and reviews with qa", () => {
  let s = project();
  s = withPhases(
    s,
    phasesOf(s).map((p) => (p.id === "requirements" ? { ...p, status: "open" } : p)),
  );
  assert.equal(deliverRoleFor(s, getItem(s, "R1")), "business-analyst");
  assert.equal(deliverRoleFor(s, getItem(s, "D1")), "architect");
  assert.equal(deliverRoleFor(s, getItem(s, "CR-1")), undefined);
  const r = next(s, waterfall(), { now: T1 });
  assert.deepEqual(
    Object.fromEntries(r.briefs.map((b) => [b.item.id, [b.role.id, b.item.stage]])),
    { R1: ["business-analyst", "work"], "R1-q1": ["project-manager", "work"] },
  );
  assert.equal(r.briefs[0]!.invariants.length, 4);
  assert.match(r.briefs[0]!.invariants[0]!, /Phase "Requirements" \(1\/6\)/);
  assert.match(r.briefs[0]!.invariants[2]!, /requirements.*design, verification/);
});

test("missingDeliverables counts item evidence, phase.produced and the extra list", () => {
  let s = project();
  const req = phasesOf(s)[0]!;
  assert.deepEqual(missingDeliverables(s, req), ["srs"]);
  assert.deepEqual(missingDeliverables(s, req, ["srs"]), []);
  s = withPhases(
    s,
    phasesOf(s).map((p) =>
      p.id === "requirements"
        ? { ...p, produced: [{ kind: "srs", ref: "docs/srs.md", by: "human", at: T0 }] }
        : p,
    ),
  );
  assert.deepEqual(missingDeliverables(s, phasesOf(s)[0]!), []);
  const ver = phasesOf(s)[3]!;
  assert.deepEqual(missingDeliverables(s, ver), ["test-report", "traceability-matrix"]);
});

test("phaseReport lists phases, the current and open phase, pending gates and readiness", () => {
  let s = project();
  const rep0 = phaseReport(s);
  assert.equal(rep0.current, "requirements");
  assert.equal(rep0.open, null);
  assert.deepEqual(rep0.pendingGates, []);
  assert.deepEqual(rep0.phases[0], {
    id: "requirements",
    name: "Requirements",
    status: "pending",
    items: 2,
    done: 0,
    missingDeliverables: ["srs"],
    readyForGate: false,
  });
  s = withPhases(
    s,
    phasesOf(s).map((p) => (p.id === "requirements" ? { ...p, status: "open" } : p)),
  );
  assert.equal(phaseReport(s).open, "requirements");
});
