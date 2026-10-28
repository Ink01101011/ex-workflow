import test from "node:test";
import assert from "node:assert/strict";
import { init } from "../methodology.ts";
import { investigation } from "./index.ts";
const m = () => investigation();
test("configuration rejects unbounded or malformed investigation", () => {
  assert.throws(() => m().validateConfig({ question: "why", maxRounds: 0, budget: { turns: 2 } }));
  assert.throws(() =>
    m().validateConfig({ question: "why", maxRounds: 2, budget: { tokens: Infinity } }),
  );
});
test("scientific lifecycle requires competing predictions, provenance, replay, and independent review", () => {
  let s = init({
    methodology: m(),
    config: { question: "why", maxRounds: 3, budget: { turns: 10 } },
  }).state;
  const call = (name: string, input: Record<string, unknown>, by = "investigator") => {
    s = m().ceremonies[name]!(s, { by, ...input }).state;
  };
  call("intake", { item: "q" });
  const before = JSON.stringify(s);
  assert.throws(() =>
    call("hypotheses", { hypotheses: [{ id: "a", claim: "A", falsifiedBy: "not A" }] }),
  );
  assert.equal(JSON.stringify(s), before);
  call("hypotheses", {
    hypotheses: [
      { id: "a", claim: "A", falsifiedBy: "not A" },
      { id: "b", claim: "B", falsifiedBy: "not B" },
    ],
  });
  assert.throws(() =>
    call("preregister", {
      experiment: {
        id: "e1",
        procedureRef: "proc",
        predictions: [
          { hypothesis: "a", prediction: "yes" },
          { hypothesis: "b", prediction: "yes" },
        ],
      },
    }),
  );
  call("preregister", {
    experiment: {
      id: "e1",
      procedureRef: "proc",
      predictions: [
        { hypothesis: "a", prediction: "yes" },
        { hypothesis: "b", prediction: "no" },
      ],
    },
  });
  assert.throws(() =>
    call("observe", {
      experiment: "e1",
      result: { id: "r1", valid: true, summary: "yes", provenanceRefs: [] },
    }),
  );
  // A recorded observation requires a completed execution item, not a claim of execution.
  assert.throws(() =>
    call("observe", {
      experiment: "e1",
      result: { id: "r1", valid: true, summary: "yes", provenanceRefs: ["log"] },
    }),
  );
  call("stop", { reason: "execution unavailable" });
  assert.equal(s.investigation?.outcome, "stopped");
  assert.throws(() => call("hypotheses", { hypotheses: [] }));
  assert.equal(m().report!(s).outcome, "stopped");
});

import { next } from "../brief.ts";
import { complete } from "../complete.ts";
import type { Accounting, Handoff, WorkflowState } from "../types.ts";
import { WorkflowError } from "../errors.ts";
function harness(maxRounds = 3, turns = 10) {
  const method = m();
  let state = init({
    methodology: method,
    config: { question: "why", maxRounds, budget: { turns } },
  }).state;
  const call = (name: string, input: Record<string, unknown>, by = "investigator") =>
    (state = method.ceremonies[name]!(state, { by, ...input }).state);
  call("intake", { item: "q" });
  call("hypotheses", {
    hypotheses: [
      { id: "a", claim: "A", falsifiedBy: "not A" },
      { id: "b", claim: "B", falsifiedBy: "not B" },
    ],
  });
  return {
    get state() {
      return state;
    },
    call,
    setState(value: WorkflowState) {
      state = value;
    },
    dispatch() {
      state = next(state, method).state;
    },
    finish(verdict: Handoff["verdict"] = "done", acc: Partial<Accounting> = {}, output = "actual") {
      const item = state.investigation!.rounds.at(-1)!.item;
      const role = state.items[item]!.role!;
      state = complete(
        state,
        method,
        {
          item,
          role,
          verdict,
          produced: output === "" ? [] : [{ kind: "experiment-output", ref: output }],
          notes: "execution",
          do_not: [],
          open_questions: [],
        },
        {
          item,
          role,
          model: "test",
          tokensIn: 1,
          tokensOut: 1,
          durationMs: 1,
          startedAt: "2026-01-01T00:00:00Z",
          endedAt: "2026-01-01T00:00:01Z",
          ...acc,
        },
      ).state;
    },
    run(id: string, valid = true, replayOf?: string, nextPhase = "conclusion") {
      call("preregister", {
        experiment: {
          id,
          procedureRef: "proc",
          predictions: [
            { hypothesis: "a", prediction: "yes" },
            { hypothesis: "b", prediction: "no" },
          ],
          ...(replayOf ? { replayOf } : {}),
        },
      });
      const planned = next(state, method);
      state = planned.state;
      const item = state.investigation!.rounds.at(-1)!.item;
      state = complete(
        state,
        method,
        {
          item,
          role: state.items[item]!.role!,
          produced: [{ kind: "experiment-output", ref: `log-${id}` }],
          notes: "execution",
          do_not: [],
          open_questions: [],
        },
        {
          item,
          role: state.items[item]!.role!,
          model: "test",
          tokensIn: 1,
          tokensOut: 1,
          durationMs: 1,
          startedAt: "2026-01-01T00:00:00Z",
          endedAt: "2026-01-01T00:00:01Z",
        },
      ).state;
      call("observe", {
        experiment: id,
        result: { id: `r-${id}`, valid, summary: "observed", provenanceRefs: [`log-${id}`] },
      });
      call("update-belief", {
        result: `r-${id}`,
        assessments: [
          {
            hypothesis: "a",
            assessment: valid ? "supported" : "uncertain",
            reason: "matches prediction",
          },
          { hypothesis: "b", assessment: valid ? "refuted" : "uncertain", reason: "differs" },
        ],
        next: nextPhase,
      });
    },
  };
}
test("resolved conclusion needs a successful replay and independent reviewer", () => {
  const h = harness();
  h.run("e1");
  h.call("conclude", {
    outcome: "resolved",
    summary: "A explains observation",
    supportedHypothesis: "a",
    evidenceRefs: ["log-e1"],
  });
  assert.throws(() =>
    h.call(
      "review-conclusion",
      { approve: true, reason: "ok", replayRefs: ["r-e1"] },
      "investigator",
    ),
  );
  assert.throws(() =>
    h.call(
      "review-conclusion",
      { approve: true, reason: "ok", replayRefs: ["r-e1"] },
      "conclusion-reviewer",
    ),
  );
  h.call("review-conclusion", { approve: false, reason: "replicate" }, "conclusion-reviewer");
  // conclusion can be revised, but new rounds must be explicitly requested via review rejection.
  h.call("conclude", {
    outcome: "inconclusive",
    summary: "replay unavailable",
    evidenceRefs: ["log-e1"],
  });
  h.call(
    "review-conclusion",
    { approve: true, reason: "appropriately uncertain" },
    "conclusion-reviewer",
  );
  assert.equal(h.state.investigation!.outcome, "inconclusive");
});
test("successful independent replay closes resolved and leaves previous states immutable", () => {
  const h = harness();
  h.run("e1", true, undefined, "round");
  const prior = h.state;
  const snapshot = JSON.stringify(prior);
  h.run("e2", true, "e1");
  h.call("conclude", {
    outcome: "resolved",
    summary: "replicated A",
    supportedHypothesis: "a",
    evidenceRefs: ["log-e1", "log-e2"],
  });
  h.call(
    "review-conclusion",
    { approve: true, reason: "evidence replayed", replayRefs: ["r-e2"] },
    "conclusion-reviewer",
  );
  assert.equal(h.state.investigation!.outcome, "resolved");
  assert.equal(JSON.stringify(prior), snapshot);
});
test("invalid runs consume round limit and stop without dispatching more work", () => {
  const h = harness(1);
  h.run("invalid", false, undefined, "round");
  assert.equal(h.state.investigation!.outcome, "stopped");
  assert.equal(m().candidates(h.state).length, 0);
  assert.equal(m().metrics(h.state).invalidRuns, 1);
});
test("spent turns prevent an additional run", () => {
  const h = harness(4, 1);
  h.run("e1", true, undefined, "round");
  assert.equal(h.state.investigation!.outcome, "stopped");
});
test("a replay cannot change the preregistered procedure or predictions", () => {
  const h = harness();
  h.run("e1", true, undefined, "round");
  assert.throws(() =>
    h.call("preregister", {
      experiment: {
        id: "e2",
        procedureRef: "different-procedure",
        replayOf: "e1",
        predictions: [
          { hypothesis: "a", prediction: "yes" },
          { hypothesis: "b", prediction: "no" },
        ],
      },
    }),
  );
});
test("closing only touches investigation-owned items", () => {
  const h = harness();
  const state = addItem(h.state, { id: "unrelated", title: "unrelated" }, "investigator");
  const stopped = m().ceremonies.stop!(state, { by: "investigator", reason: "stop" }).state;
  assert.equal(stopped.items.unrelated!.status, "todo");
});
import { addItem } from "../items.ts";
test("hypotheses can be revised between rounds while prior registrations retain snapshots", () => {
  const h = harness();
  h.run("e1", true, undefined, "round");
  h.call("hypotheses", {
    hypotheses: [
      { id: "a", claim: "revised A", falsifiedBy: "other" },
      { id: "b", claim: "B", falsifiedBy: "not B" },
    ],
  });
  assert.equal(h.state.investigation!.rounds[0]!.hypotheses[0]!.claim, "A");
});
test("replay execution uses an actor independent from the original execution", () => {
  const h = harness();
  h.run("e1", true, undefined, "round");
  h.run("e2", true, "e1");
  const rounds = h.state.investigation!.rounds;
  assert.notEqual(
    h.state.accounting.find((a) => a.item === rounds[0]!.item)!.role,
    h.state.accounting.find((a) => a.item === rounds[1]!.item)!.role,
  );
});
test("old support cannot override latest uncertain beliefs", () => {
  const h = harness();
  h.run("e1", true, undefined, "round");
  h.run("e2", false);
  assert.throws(() =>
    h.call("conclude", {
      outcome: "resolved",
      summary: "old A",
      supportedHypothesis: "a",
      evidenceRefs: ["log-e1"],
    }),
  );
});
test("completion rule refuses a role override that reuses original replay runner", () => {
  const h = harness();
  h.run("e1", true, undefined, "round");
  h.call("preregister", {
    experiment: {
      id: "e2",
      procedureRef: "proc",
      replayOf: "e1",
      predictions: [
        { hypothesis: "a", prediction: "yes" },
        { hypothesis: "b", prediction: "no" },
      ],
    },
  });
  const item = h.state.investigation!.rounds.at(-1)!.item;
  const violations = m().rules.flatMap((r) =>
    r.check(h.state, { type: "item.complete", by: "investigator", payload: { item } }),
  );
  assert.ok(violations.some((v) => v.rule === "independent-replay"));
});

function preregister(h: ReturnType<typeof harness>, id = "e1", replayOf?: string) {
  h.call("preregister", {
    experiment: {
      id,
      procedureRef: "proc",
      predictions: [
        { hypothesis: "a", prediction: "yes" },
        { hypothesis: "b", prediction: "no" },
      ],
      ...(replayOf ? { replayOf } : {}),
    },
  });
}
function observe(h: ReturnType<typeof harness>, id = "e1", provenanceRefs = ["actual"]) {
  h.call("observe", {
    experiment: id,
    result: { id: `r-${id}`, valid: true, summary: "observed", provenanceRefs },
  });
}
function update(h: ReturnType<typeof harness>, id = "e1", nextPhase = "round") {
  h.call("update-belief", {
    result: `r-${id}`,
    assessments: [
      { hypothesis: "a", assessment: "supported", reason: "yes" },
      { hypothesis: "b", assessment: "refuted", reason: "no" },
    ],
    next: nextPhase,
  });
}
function conclude(h: ReturnType<typeof harness>) {
  h.call("conclude", {
    outcome: "resolved",
    summary: "A",
    supportedHypothesis: "a",
    evidenceRefs: h.state.investigation!.rounds[0]!.result!.provenanceRefs,
  });
}
function revise(h: ReturnType<typeof harness>) {
  h.call("hypotheses", {
    hypotheses: [
      { id: "a", claim: "different A", falsifiedBy: "different criterion" },
      { id: "b", claim: "B", falsifiedBy: "not B" },
    ],
  });
}
test("replay rejects changed hypothesis definitions that reuse IDs", () => {
  const h = harness();
  h.run("e1", true, undefined, "round");
  revise(h);
  assert.throws(() => preregister(h, "e2", "e1"), /hypothes/);
});
test("replay for an old hypothesis version cannot resolve a newly supported version", () => {
  const h = harness(4);
  h.run("e1", true, undefined, "round");
  h.run("e2", true, "e1", "round");
  revise(h);
  h.run("e3");
  conclude(h);
  assert.throws(
    () =>
      h.call(
        "review-conclusion",
        { approve: true, reason: "ok", replayRefs: ["r-e2"] },
        "conclusion-reviewer",
      ),
    /replay/,
  );
});
for (const spoof of [
  { role: "fake" },
  { item: "unrelated" },
  { role: "fake", item: "unrelated" },
]) {
  test(`replay identity ignores spoofed accounting ${JSON.stringify(spoof)}`, () => {
    const h = harness(4);
    preregister(h);
    h.dispatch();
    h.finish("done", spoof);
    observe(h);
    update(h);
    preregister(h, "e2", "e1");
    h.dispatch();
    h.finish("done", spoof);
    observe(h, "e2");
    update(h, "e2");
    const second = h.state.items["q-run-2"]!.transitions.find(
      (t) => t.to.status === "in_progress",
    )!.by;
    preregister(h, "e3", "e2");
    h.dispatch();
    assert.notEqual(h.state.items["q-run-3"]!.role, second);
    const violations = m().rules.flatMap((r) =>
      r.check(h.state, { type: "item.complete", by: second, payload: { item: "q-run-3" } }),
    );
    assert.ok(violations.some((v) => v.rule === "independent-replay" && v.item === "q-run-3"));
  });
}
test("review independence includes real execution actors despite spoofed accounting", () => {
  const h = harness();
  preregister(h);
  const state = h.state;
  h.setState({
    ...state,
    roles: {
      ...state.roles,
      investigator: {
        ...state.roles.investigator!,
        capabilities: ["facilitate", "define-acceptance", "verify"],
      },
      "conclusion-reviewer": {
        ...state.roles["conclusion-reviewer"]!,
        capabilities: ["review", "deliver", "define-acceptance"],
      },
    },
  });
  h.dispatch();
  h.finish("done", { role: "fake", item: "unrelated" });
  observe(h);
  update(h, "e1", "conclusion");
  conclude(h);
  assert.throws(
    () =>
      h.call("review-conclusion", { approve: false, reason: "own work" }, "conclusion-reviewer"),
    /independent/,
  );
});
test("observation provenance must include the completed experiment output", () => {
  const h = harness();
  preregister(h);
  h.dispatch();
  h.finish();
  assert.throws(() => observe(h, "e1", ["unproduced"]), /experiment-output/);
  observe(h, "e1", ["actual", "supplemental"]);
});
test("observation cannot link superseded output after execution rework", () => {
  const h = harness();
  preregister(h);
  h.dispatch();
  h.finish("rework", {}, "old");
  h.dispatch();
  h.finish("done", {}, "fresh");
  assert.throws(() => observe(h, "e1", ["old"]), /experiment-output/);
  observe(h, "e1", ["fresh"]);
});
test("review rejection can request and retain a new replay round", () => {
  const h = harness();
  h.run("e1");
  conclude(h);
  h.call(
    "review-conclusion",
    { approve: false, reason: "run replay", next: "round" },
    "conclusion-reviewer",
  );
  assert.equal(h.state.investigation!.phase, "preregister");
  h.run("e2", true, "e1");
  conclude(h);
  h.call(
    "review-conclusion",
    { approve: true, reason: "replayed", replayRefs: ["r-e2"] },
    "conclusion-reviewer",
  );
  assert.equal(h.state.investigation!.outcome, "resolved");
  assert.ok(
    (
      h.state.investigation as unknown as { reviewHistory: Array<{ reason: string }> }
    ).reviewHistory.some((r) => r.reason === "run replay"),
  );
});
test("review rejection validates its next phase and defaults to conclusion", () => {
  const h = harness();
  h.run("e1");
  conclude(h);
  assert.throws(
    () =>
      h.call(
        "review-conclusion",
        { approve: false, reason: "again", next: "arbitrary" },
        "conclusion-reviewer",
      ),
    /next/,
  );
  h.call("review-conclusion", { approve: false, reason: "wording" }, "conclusion-reviewer");
  assert.equal(h.state.investigation!.phase, "conclusion");
});
for (const [maxRounds, turns] of [
  [1, 10],
  [3, 1],
]) {
  test(`review requesting evidence enforces bounds ${maxRounds}/${turns}`, () => {
    const h = harness(maxRounds, turns);
    h.run("e1");
    conclude(h);
    h.call(
      "review-conclusion",
      { approve: false, reason: "replay", next: "round" },
      "conclusion-reviewer",
    );
    assert.equal(h.state.investigation!.outcome, "stopped");
  });
}
for (const verdict of ["rework", "blocked"] as const) {
  test(`budget-exhausted ${verdict} execution automatically stops`, () => {
    const h = harness(3, 1);
    preregister(h);
    h.dispatch();
    h.finish(verdict);
    assert.equal(h.state.investigation!.outcome, "stopped");
    assert.equal(h.state.items["q-run-1"]!.status, "dropped");
    assert.match(h.state.investigation!.stopReason!, /budget/);
  });
}
test("successful last-budget execution remains observable", () => {
  const h = harness(3, 1);
  preregister(h);
  h.dispatch();
  h.finish();
  assert.equal(h.state.investigation!.phase, "observe");
  observe(h);
  update(h, "e1", "conclusion");
  assert.equal(h.state.investigation!.phase, "conclusion");
});
test("missing independent deliver role fails before replay dispatch", () => {
  const h = harness();
  h.run("e1", true, undefined, "round");
  preregister(h, "e2", "e1");
  const state = h.state;
  h.setState({
    ...state,
    roles: Object.fromEntries(Object.entries(state.roles).filter(([id]) => id !== "replay-worker")),
  });
  assert.throws(
    () => h.dispatch(),
    (e: unknown) =>
      e instanceof WorkflowError &&
      e.code === "missing-capability" &&
      e.items?.includes("q-run-2") === true &&
      /independent/.test(e.fix),
  );
  assert.equal(h.state.items["q-run-2"]!.status, "todo");
});
test("ceremony errors identify the field, phase and investigation item", () => {
  const h = harness();
  assert.throws(
    () => observe(h),
    (e: unknown) =>
      e instanceof WorkflowError &&
      e.items?.includes("q") === true &&
      /observe/.test(e.message) &&
      /preregister/.test(e.fix),
  );
  assert.throws(
    () => h.call("preregister", { experiment: {} }),
    (e: unknown) =>
      e instanceof WorkflowError && e.items?.includes("q") === true && /experiment/.test(e.fix),
  );
});
test("execution-only violations identify their rejected item", () => {
  const h = harness();
  const violations = m().rules.flatMap((r) =>
    r.check(h.state, { type: "item.complete", by: "investigator", payload: { item: "unrelated" } }),
  );
  assert.ok(
    violations.some((v) => v.rule === "investigation-execution-only" && v.item === "unrelated"),
  );
});

test("replay excludes every real runner from prior execution retries", () => {
  const h = harness();
  preregister(h);
  h.dispatch();
  h.finish("rework", { role: "fake" });
  const state = h.state;
  h.setState({
    ...state,
    items: { ...state.items, "q-run-1": { ...state.items["q-run-1"]!, role: "replay-worker" } },
  });
  h.dispatch();
  h.finish("done", { item: "unrelated" });
  observe(h);
  update(h);
  preregister(h, "e2", "e1");
  assert.throws(
    () => h.dispatch(),
    (e: unknown) => e instanceof WorkflowError && e.code === "missing-capability",
  );
  const violations = m().rules.flatMap((rule) =>
    ["investigator", "replay-worker"].flatMap((by) =>
      rule.check(h.state, { type: "item.complete", by, payload: { item: "q-run-2" } }),
    ),
  );
  assert.equal(violations.filter((v) => v.rule === "independent-replay").length, 2);
});
test("a completion reusing old item evidence cannot establish fresh observation provenance", () => {
  const h = harness();
  preregister(h);
  h.dispatch();
  h.finish("rework", {}, "old");
  h.dispatch();
  assert.throws(
    () => h.finish("done", {}, ""),
    (e: unknown) => e instanceof WorkflowError && e.code === "policy-unmet",
  );
  h.finish("done", {}, "fresh");
  assert.throws(() => observe(h, "e1", ["old"]), /fresh experiment-output/);
});

test("split capabilities allow a delivery worker to execute the first experiment", () => {
  const method = m();
  const config = { question: "why", maxRounds: 3, budget: { turns: 10 } };
  const roles = method
    .defaultRoles(config)
    .map((r) =>
      r.id === "investigator"
        ? { ...r, capabilities: r.capabilities.filter((c) => c !== "deliver") }
        : r,
    );
  let s = init({ methodology: method, config, roles }).state;
  const call = (name: string, input: Record<string, unknown>) => {
    s = method.ceremonies[name]!(s, { by: "investigator", ...input }).state;
  };
  call("intake", { item: "q" });
  call("hypotheses", {
    hypotheses: [
      { id: "a", claim: "A", falsifiedBy: "not A" },
      { id: "b", claim: "B", falsifiedBy: "not B" },
    ],
  });
  call("preregister", {
    experiment: {
      id: "e1",
      procedureRef: "proc",
      predictions: [
        { hypothesis: "a", prediction: "yes" },
        { hypothesis: "b", prediction: "no" },
      ],
    },
  });
  assert.equal(next(s, method).briefs[0]?.role.id, "replay-worker");
});
test("prototype actor produces a workflow error", () => {
  const method = m();
  const s = init({
    methodology: method,
    config: { question: "why", maxRounds: 3, budget: { turns: 10 } },
  }).state;
  assert.throws(
    () => method.ceremonies.intake!(s, { by: "constructor", item: "q" }),
    WorkflowError,
  );
});
