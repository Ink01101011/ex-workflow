import { test } from "node:test";
import assert from "node:assert/strict";
import { init } from "../methodology.ts";
import { addItem } from "../items.ts";
import { experimentation } from "./index.ts";
import type { WorkflowState } from "../types.ts";
const m = experimentation();
const sha = (n: number) => String(n).repeat(40);
const config = {
  objective: "latency",
  direction: "minimize",
  tieBreak: "candidate-id",
  concurrencyCap: 2,
  maxCandidates: 3,
  candidateBudget: { turns: 5 },
  totalBudget: { turns: 12 },
};
function call(
  s: WorkflowState,
  name: string,
  input: Record<string, unknown> = {},
  by = "coordinator",
) {
  if (["validate", "integrate", "validate-integration", "stop", "terminate"].includes(name))
    input = { spent: { tokens: 0, turns: 0, wallclockMs: 0 }, log: "failure-log", ...input };
  if (name === "provision")
    input = { baseSha: s.experimentation?.baseSha, isolated: true, ...input };
  if (name === "submit")
    input = {
      baseSha: s.experimentation?.baseSha,
      harness: s.experimentation?.harness,
      workspace: s.experimentation?.candidates[String(input.candidate)]?.workspace,
      ...input,
    };
  if (name === "submit") input = { command: "benchmark --frozen", log: "benchmark-log", ...input };
  return m.ceremonies[name]!(s, { by, now: "2026-10-28T00:00:00Z", ...input }).state;
}
function frozen() {
  let s = init({ methodology: m, config }).state;
  for (const id of ["a", "b"])
    s = addItem(s, { id, title: id, acceptance: ["benchmark"] }, "coordinator");
  return call(s, "freeze", {
    baseSha: sha(1),
    harness: "harness-v1",
    candidates: [
      { id: "a", item: "a", author: "builder" },
      { id: "b", item: "b", author: "builder" },
    ],
  });
}
function running() {
  let s = frozen();
  for (const id of ["a", "b"]) {
    s = call(s, "provision", { candidate: id, workspace: `workspace-${id}` });
    s = call(s, "start", { candidate: id }, "builder");
  }
  return s;
}
function submitted() {
  let s = running();
  for (const [id, n] of [
    ["a", 2],
    ["b", 3],
  ] as const) {
    s = call(
      s,
      "submit",
      { candidate: id, sha: sha(n), score: n, spent: { turns: 1, tokens: 0, wallclockMs: 0 } },
      "builder",
    );
    s = call(
      s,
      "validate",
      {
        candidate: id,
        sha: sha(n),
        harness: "harness-v1",
        passed: true,
        reproducible: true,
        evidence: "test-log",
      },
      "validator",
    );
  }
  return s;
}
test("parallel candidates independently validate and winner integrates at a changed target", () => {
  const initial = submitted();
  const snapshot = JSON.stringify(initial);
  let s = call(initial, "compare");
  assert.equal(s.experimentation?.selected, "a");
  assert.equal(JSON.stringify(initial), snapshot);
  s = call(
    s,
    "integrate",
    { selectedSha: sha(2), targetSha: sha(4), integrationSha: sha(5) },
    "integrator",
  );
  assert.throws(() =>
    call(
      s,
      "validate-integration",
      { sha: sha(2), targetSha: sha(4), harness: "harness-v1", passed: true, evidence: "fresh" },
      "validator",
    ),
  );
  s = call(
    s,
    "validate-integration",
    { sha: sha(5), targetSha: sha(4), harness: "harness-v1", passed: true, evidence: "fresh" },
    "validator",
  );
  assert.equal(s.experimentation?.status, "integrated");
  assert.deepEqual(m.report!(s).cleanup, ["workspace-a", "workspace-b"]);
});
test("failed and timed-out candidates produce no winner", () => {
  let s = running();
  s = call(s, "terminate", { candidate: "a", status: "failed", reason: "crash" });
  s = call(s, "terminate", { candidate: "b", status: "timed-out", reason: "deadline" });
  s = call(s, "compare");
  assert.equal(s.experimentation?.status, "stopped");
  assert.equal(s.experimentation?.selected, undefined);
});
test("rejects stale SHA, author validation, early compare, repeated submission and workspace reuse", () => {
  let s = running();
  assert.throws(() => call(s, "compare"));
  s = call(
    s,
    "submit",
    { candidate: "a", sha: sha(2), score: 1, spent: { turns: 1, tokens: 0, wallclockMs: 0 } },
    "builder",
  );
  assert.throws(() =>
    call(
      s,
      "submit",
      { candidate: "a", sha: sha(2), score: 1, spent: { turns: 1, tokens: 0, wallclockMs: 0 } },
      "builder",
    ),
  );
  assert.throws(() =>
    call(
      s,
      "validate",
      {
        candidate: "a",
        sha: sha(3),
        harness: "harness-v1",
        passed: true,
        reproducible: true,
        evidence: "log",
      },
      "validator",
    ),
  );
  assert.throws(() =>
    call(
      s,
      "validate",
      {
        candidate: "a",
        sha: sha(2),
        harness: "harness-v1",
        passed: true,
        reproducible: true,
        evidence: "log",
      },
      "builder",
    ),
  );
  let p = call(frozen(), "provision", { candidate: "a", workspace: "same" });
  assert.throws(() => call(p, "provision", { candidate: "b", workspace: "same" }));
});
test("rejects invalid config and stops over-budget candidate from winning", () => {
  for (const patch of [
    { concurrencyCap: 0 },
    { maxCandidates: Infinity },
    { candidateBudget: {} },
    { totalBudget: { turns: NaN } },
  ])
    assert.throws(() => m.validateConfig({ ...config, ...patch }));
  let s = running();
  s = call(
    s,
    "submit",
    { candidate: "a", sha: sha(2), score: 1, spent: { turns: 6, tokens: 0, wallclockMs: 0 } },
    "builder",
  );
  assert.equal(s.experimentation?.candidates.a?.status, "timed-out");
  assert.throws(() =>
    call(
      s,
      "validate",
      {
        candidate: "a",
        sha: sha(2),
        harness: "harness-v1",
        passed: true,
        reproducible: true,
        evidence: "log",
      },
      "validator",
    ),
  );
});
test("rejects ineligible harness provenance and exact selected-SHA mismatch", () => {
  let s = submitted();
  s = call(s, "compare");
  assert.throws(() =>
    call(
      s,
      "integrate",
      { selectedSha: sha(3), targetSha: sha(4), integrationSha: sha(5) },
      "integrator",
    ),
  );
  let p = running();
  p = call(
    p,
    "submit",
    { candidate: "a", sha: sha(2), score: 1, spent: { turns: 1, tokens: 0, wallclockMs: 0 } },
    "builder",
  );
  assert.throws(() =>
    call(
      p,
      "validate",
      {
        candidate: "a",
        sha: sha(2),
        harness: "wrong",
        passed: true,
        reproducible: true,
        evidence: "log",
      },
      "validator",
    ),
  );
});

test("start enforces dependencies and terminal outcomes release item WIP", () => {
  let s = frozen();
  s = call(s, "provision", { candidate: "a", workspace: "wa" });
  s = { ...s, items: { ...s.items, a: { ...s.items.a!, dependsOn: ["b"] } } };
  assert.throws(() => call(s, "start", { candidate: "a" }, "builder"));
  let p = running();
  p = call(p, "terminate", {
    candidate: "a",
    status: "failed",
    reason: "crash",
    spent: { tokens: 4, turns: 2, wallclockMs: 1 },
    log: "crash-log",
  });
  assert.equal(p.items.a?.status, "dropped");
  assert.equal((m.metrics(p).spent as Record<string, number>).turns, 2);
});
test("records control costs, invalidates prior integration on target drift, and cleans only owned identities", () => {
  let s = call(submitted(), "compare");
  s = call(
    s,
    "integrate",
    {
      selectedSha: sha(2),
      targetSha: sha(4),
      integrationSha: sha(5),
      spent: { tokens: 0, turns: 2, wallclockMs: 0 },
    },
    "integrator",
  );
  s = call(
    s,
    "integrate",
    {
      selectedSha: sha(2),
      targetSha: sha(6),
      integrationSha: sha(7),
      spent: { tokens: 0, turns: 1, wallclockMs: 0 },
    },
    "integrator",
  );
  assert.throws(() =>
    call(
      s,
      "validate-integration",
      {
        sha: sha(5),
        targetSha: sha(4),
        harness: "harness-v1",
        passed: true,
        evidence: "old",
        spent: { tokens: 0, turns: 1, wallclockMs: 0 },
      },
      "validator",
    ),
  );
  s = call(
    s,
    "validate-integration",
    {
      sha: sha(7),
      targetSha: sha(6),
      harness: "harness-v1",
      passed: true,
      evidence: "fresh",
      spent: { tokens: 0, turns: 1, wallclockMs: 0 },
    },
    "validator",
  );
  assert.equal((m.metrics(s).spent as Record<string, number>).turns, 6);
  assert.throws(() => call(s, "cleanup", { workspaces: ["unowned"] }));
  s = call(s, "cleanup", { workspaces: ["workspace-a"] });
  assert.deepEqual(m.report!(s).cleanup, ["workspace-b"]);
});

test("next dispatches isolated candidates, complete enforces submission and accounts once", async () => {
  const { next } = await import("../brief.ts");
  const { complete } = await import("../complete.ts");
  let s = frozen();
  s = call(s, "provision", { candidate: "a", workspace: "wa" });
  s = call(s, "provision", { candidate: "b", workspace: "wb" });
  const scheduled = next(s, m);
  assert.equal(scheduled.briefs.length, 2);
  s = scheduled.state;
  assert.equal(next(s, m).briefs.length, 0);
  const handoff = {
    item: "a",
    role: "builder",
    produced: [
      { kind: "candidate-sha", ref: sha(2) },
      { kind: "benchmark-result", ref: "benchmark-log" },
    ],
    notes: "done",
    do_not: [],
    open_questions: [],
  };
  const accounting = {
    item: "a",
    role: "builder",
    model: "test-model",
    tokensIn: 2,
    tokensOut: 2,
    durationMs: 1,
    startedAt: "2026-10-28T00:00:00Z",
    endedAt: "2026-10-28T00:00:01Z",
  };
  assert.throws(() => complete(s, m, handoff, accounting));
  s = call(
    s,
    "submit",
    { candidate: "a", sha: sha(2), score: 1, spent: { tokens: 4, turns: 1, wallclockMs: 1 } },
    "builder",
  );
  s = complete(s, m, handoff, accounting).state;
  assert.equal(s.items.a?.stage, "validation");
  assert.equal((m.metrics(s).spent as Record<string, number>).tokens, 4);
  s = call(
    s,
    "validate",
    {
      candidate: "a",
      sha: sha(2),
      harness: "harness-v1",
      passed: true,
      reproducible: true,
      evidence: "independent-log",
    },
    "validator",
  );
  assert.equal(s.items.a?.status, "done");
});
test("concurrency limit and budget exhaustion stop new candidates", () => {
  let s = frozen();
  s = { ...s, config: { ...config, concurrencyCap: 1, totalBudget: { turns: 1 } } };
  for (const id of ["a", "b"]) s = call(s, "provision", { candidate: id, workspace: `w-${id}` });
  s = call(s, "start", { candidate: "a" }, "builder");
  assert.throws(() => call(s, "start", { candidate: "b" }, "builder"));
  s = call(
    s,
    "submit",
    { candidate: "a", sha: sha(2), score: 1, spent: { tokens: 0, turns: 1, wallclockMs: 0 } },
    "builder",
  );
  assert.throws(() => call(s, "start", { candidate: "b" }, "builder"));
  assert.equal(m.candidates(s).length, 0);
  s = call(s, "terminate", {
    candidate: "a",
    status: "cancelled",
    reason: "budget reached",
    spent: { tokens: 0, turns: 1, wallclockMs: 0 },
    log: "final",
  });
  s = call(s, "stop", { reason: "budget reached" });
  assert.equal(s.items.b?.status, "dropped");
  assert.equal(s.items.a?.status, "dropped");
});
test("nonreproducible candidate cannot win and failed integration stops", () => {
  let s = running();
  for (const [id, n] of [
    ["a", 2],
    ["b", 3],
  ] as const) {
    s = call(
      s,
      "submit",
      { candidate: id, sha: sha(n), score: n, spent: { tokens: 0, turns: 1, wallclockMs: 0 } },
      "builder",
    );
    s = call(
      s,
      "validate",
      {
        candidate: id,
        sha: sha(n),
        harness: "harness-v1",
        passed: true,
        reproducible: id === "b",
        evidence: "log",
      },
      "validator",
    );
  }
  s = call(s, "compare");
  assert.equal(s.experimentation?.selected, "b");
  s = call(
    s,
    "integrate",
    { selectedSha: sha(3), targetSha: sha(4), integrationSha: sha(5) },
    "integrator",
  );
  s = call(
    s,
    "validate-integration",
    { sha: sha(5), targetSha: sha(4), harness: "harness-v1", passed: false, evidence: "failure" },
    "validator",
  );
  assert.equal(s.experimentation?.status, "stopped");
});

test("requires host provenance matching the frozen workspace and harness", () => {
  let s = frozen();
  assert.throws(() =>
    m.ceremonies.provision!(s, {
      by: "coordinator",
      candidate: "a",
      workspace: "wa",
      baseSha: sha(9),
      isolated: true,
    }),
  );
  s = call(s, "provision", { candidate: "a", workspace: "wa" });
  s = call(s, "start", { candidate: "a" }, "builder");
  assert.throws(() =>
    call(
      s,
      "submit",
      {
        candidate: "a",
        sha: sha(2),
        score: 1,
        spent: { tokens: 0, turns: 1, wallclockMs: 0 },
        harness: "changed",
      },
      "builder",
    ),
  );
  assert.throws(() =>
    m.ceremonies.submit!(s, {
      by: "builder",
      candidate: "a",
      sha: sha(2),
      score: 1,
      spent: { tokens: 0, turns: 1, wallclockMs: 0 },
    }),
  );
});
test("rejects malformed ceremony inputs without changing state", () => {
  const s = frozen();
  const copy = JSON.stringify(s);
  for (const invalid of [null, [], { by: 4 }, { by: "coordinator", now: "yesterday" }])
    assert.throws(() => m.ceremonies.provision!(s, invalid as never));
  assert.equal(JSON.stringify(s), copy);
});

test("independent authorization follows capabilities and an author with verify still cannot validate", () => {
  let s = running();
  s = {
    ...s,
    roles: {
      ...s.roles,
      builder: { ...s.roles.builder!, capabilities: [...s.roles.builder!.capabilities, "verify"] },
      auditor: { ...s.roles.validator!, id: "auditor" },
    },
  };
  s = call(
    s,
    "submit",
    { candidate: "a", sha: sha(2), score: 1, spent: { tokens: 0, turns: 1, wallclockMs: 0 } },
    "builder",
  );
  const input = {
    candidate: "a",
    sha: sha(2),
    harness: "harness-v1",
    passed: true,
    reproducible: true,
    evidence: "log",
  };
  assert.throws(() => call(s, "validate", input, "builder"));
  s = call(s, "validate", input, "auditor");
  assert.equal(s.experimentation?.candidates.a?.validation?.by, "auditor");
});
test("a submitted candidate can time out during independent validation", () => {
  let s = running();
  s = call(
    s,
    "submit",
    { candidate: "a", sha: sha(2), score: 1, spent: { tokens: 0, turns: 1, wallclockMs: 0 } },
    "builder",
  );
  s = call(s, "terminate", {
    candidate: "a",
    status: "timed-out",
    reason: "validator timeout",
    spent: { tokens: 2, turns: 2, wallclockMs: 100 },
    log: "validator-timeout",
  });
  assert.equal(s.experimentation?.candidates.a?.status, "timed-out");
  assert.equal(s.items.a?.status, "dropped");
});

// Review regressions exercise both public dispatch paths and the shared completion seam.
import { next } from "../brief.ts";
import { complete } from "../complete.ts";
import { editItem } from "../items.ts";
import { WorkflowError } from "../errors.ts";
const zero = { tokens: 0, turns: 0, wallclockMs: 0 };
const handoff = {
  item: "a",
  role: "builder",
  produced: [{ kind: "candidate-sha", ref: sha(2) }],
  notes: "redo",
  do_not: [],
  open_questions: [],
};
const accounting = {
  item: "a",
  role: "builder",
  model: "test",
  tokensIn: 2,
  tokensOut: 2,
  durationMs: 3,
  startedAt: "2026-10-28T00:00:00Z",
  endedAt: "2026-10-28T00:00:01Z",
};
function ready(patch: Record<string, unknown> = {}) {
  let s = frozen();
  s = { ...s, config: { ...config, ...patch } };
  for (const candidate of ["a", "b"])
    s = call(s, "provision", { candidate, workspace: `w-${candidate}` });
  return s;
}
function submitA(s = running(), turns = 1) {
  return call(
    s,
    "submit",
    { candidate: "a", sha: sha(2), score: 1, spent: { tokens: 0, turns, wallclockMs: 0 } },
    "builder",
  );
}
test("E1 terminal cumulative usage never decreases and preserves submission log", () => {
  let s = submitA(running(), 4);
  s = call(s, "terminate", {
    candidate: "a",
    status: "timed-out",
    reason: "review timeout",
    spent: zero,
    log: "terminal-log",
  });
  assert.equal((m.metrics(s).spent as Record<string, number>).turns, 4);
  assert.equal(s.experimentation!.candidates.a!.log, "benchmark-log");
  assert.equal(s.experimentation!.candidates.a!.terminalLog, "terminal-log");
});
test("E2 unsupported completion verdicts reject before changing the submitted attempt", () => {
  const s = submitA();
  const snapshot = JSON.stringify(s);
  for (const verdict of ["rework", "blocked", "escalate"] as const)
    assert.throws(() => complete(s, m, { ...handoff, verdict }, accounting), /terminate/);
  assert.equal(JSON.stringify(s), snapshot);
});
test("E3 both dispatch paths reserve turns and expose bounded remaining budget", () => {
  const s = ready({ totalBudget: { turns: 1 } });
  const n = next(s, m);
  assert.equal(n.briefs.length, 1);
  assert.deepEqual(n.briefs[0]!.budgetRemaining, { turns: 1 });
  assert.equal(next(n.state, m).briefs.length, 0);
  const started = call(s, "start", { candidate: "a" }, "builder");
  assert.throws(() => call(started, "start", { candidate: "b" }, "builder"), /budget/);
});
test("E3 ceremony costs synchronize iteration budget without completion double-charge", () => {
  let s = submitA();
  s = complete(s, m, handoff, accounting).state;
  assert.deepEqual(s.iterations.find((i) => !i.endedAt)?.spent, {
    tokens: 4,
    turns: 1,
    wallclockMs: 3,
  });
  s = call(
    s,
    "validate",
    {
      candidate: "a",
      sha: sha(2),
      harness: "harness-v1",
      passed: true,
      reproducible: true,
      evidence: "log",
      spent: { ...zero, turns: 2 },
    },
    "validator",
  );
  assert.equal(s.iterations.find((i) => !i.endedAt)?.spent.turns, 3);
});
test("E4 dependency graph is retained until the planner selects runnable work", () => {
  const s = editItem(ready({ concurrencyCap: 1 }), "a", { dependsOn: ["b"] }, "coordinator");
  assert.deepEqual(
    m.candidates(s).map((i) => i.id),
    ["a", "b"],
  );
  assert.deepEqual(
    next(s, m).briefs.map((b) => b.item.id),
    ["b"],
  );
});
test("E5 frozen author must agree with item assignment and retain delivery capability", () => {
  let s = init({ methodology: m, config }).state;
  s = addItem(s, { id: "a", title: "a", role: "validator", acceptance: ["ok"] }, "coordinator");
  assert.throws(
    () =>
      call(s, "freeze", {
        baseSha: sha(1),
        harness: "h",
        candidates: [{ id: "a", item: "a", author: "builder" }],
      }),
    /author/,
  );
  const r = ready();
  const changed = editItem(r, "a", { role: "validator" }, "coordinator");
  assert.equal(
    next(changed, m).briefs.some((b) => b.item.id === "a"),
    false,
  );
  const retired = {
    ...r,
    roles: { ...r.roles, builder: { ...r.roles.builder!, capabilities: [] } },
  };
  assert.equal(next(retired, m).briefs.length, 0);
});
test("E6 stop requires final per-attempt usage and logs before closing", () => {
  let s = running();
  assert.throws(() => call(s, "stop", { reason: "cancel" }), /terminate/);
  for (const candidate of ["a", "b"])
    s = call(s, "terminate", {
      candidate,
      status: "cancelled",
      reason: "cancel",
      spent: { ...zero, turns: 2 },
      log: `final-${candidate}`,
    });
  s = call(s, "stop", { reason: "cancel" });
  assert.equal((m.metrics(s).spent as Record<string, number>).turns, 4);
  assert.equal(s.experimentation!.candidates.a!.terminalLog, "final-a");
  assert.equal(
    call(ready(), "stop", { reason: "never started" }).experimentation!.status,
    "stopped",
  );
});
test("E7 next and start enforce acceptance and shared role resource capacity", () => {
  const s = editItem(ready(), "a", { acceptance: [] }, "coordinator");
  assert.throws(() => call(s, "start", { candidate: "a" }, "builder"));
  assert.equal(
    next(s, m).briefs.some((b) => b.item.id === "a"),
    false,
  );
  let capped = ready();
  capped = {
    ...capped,
    roles: { ...capped.roles, builder: { ...capped.roles.builder!, maxConcurrent: 1 } },
  };
  capped = call(capped, "start", { candidate: "a" }, "builder");
  assert.throws(() => call(capped, "start", { candidate: "b" }, "builder"), /resource/);
  assert.equal(next(capped, m).briefs.length, 0);
});
test("E8 malformed extra payloads cannot make successful state non-JSON or mutate input", () => {
  const s = frozen();
  const snapshot = JSON.stringify(s);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const extra of [1n, cycle, () => 1, new Date()])
    assert.throws(
      () => call(s, "provision", { candidate: "a", workspace: "w", extra }),
      WorkflowError,
    );
  const input = { candidate: "a", workspace: "w", extra: { safe: [1, "x"] } };
  const result = call(s, "provision", input);
  input.extra.safe.push(2);
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.equal(JSON.stringify(s), snapshot);
  assert.deepEqual((result.events.at(-1)!.payload as typeof input).extra.safe, [1, "x"]);
});
test("completion provenance attributes usage to validated event item and author", () => {
  let s = submitA();
  s = complete(s, m, handoff, { ...accounting, item: "b", role: "validator" }).state;
  assert.deepEqual(m.metrics(s).candidateTokens, { a: 4, b: 0 });
  assert.equal((m.metrics(s).spent as Record<string, number>).tokens, 4);
});
test("role prototypes and reserved candidate IDs produce actionable errors", () => {
  assert.throws(
    () => call(frozen(), "provision", { candidate: "a", workspace: "w" }, "constructor"),
    WorkflowError,
  );
  for (const id of ["constructor", "prototype", "a..b"]) {
    let s = init({ methodology: m, config }).state;
    s = addItem(s, { id: "a", title: "a", acceptance: ["ok"] }, "coordinator");
    assert.throws(
      () =>
        call(s, "freeze", {
          baseSha: sha(1),
          harness: "h",
          candidates: [{ id, item: "a", author: "builder" }],
        }),
      WorkflowError,
    );
  }
});

test("token estimates reserve capacity across manual and planner dispatch calls", () => {
  let s = ready({ totalBudget: { tokens: 1 } });
  s = editItem(s, "a", { weight: 2 }, "coordinator");
  s = editItem(s, "b", { weight: 2 }, "coordinator");
  assert.equal(next(s, m).briefs.length, 0);
  assert.throws(() => call(s, "start", { candidate: "a" }, "builder"), /budget/);
  // Synchronize the changed test configuration through an ordinary ceremony.
  const fresh = ready({ totalBudget: { tokens: 2 } });
  let weighted = editItem(fresh, "a", { weight: 2 }, "coordinator");
  weighted = editItem(weighted, "b", { weight: 2 }, "coordinator");
  const first = next(weighted, m, { max: 1 });
  assert.equal(first.briefs.length, 1);
  assert.equal(next(first.state, m).briefs.length, 0);
  const started = call(weighted, "start", { candidate: "a" }, "builder");
  assert.throws(() => call(started, "start", { candidate: "b" }, "builder"), /budget/);
});

test("token budgeting batches runnable candidates without reserving blocked dependencies", () => {
  const cfg = {
    ...config,
    concurrencyCap: 3,
    maxCandidates: 4,
    totalBudget: { tokens: 100 },
    candidateBudget: { tokens: 100 },
  };
  let s = init({ methodology: m, config: cfg }).state;
  for (const id of ["a", "b", "c", "z"])
    s = addItem(
      s,
      {
        id,
        title: id,
        acceptance: ["ok"],
        weight: id === "z" ? 99 : 1,
        ...(id === "z" ? { dependsOn: ["a"] } : {}),
      },
      "coordinator",
    );
  s = call(s, "freeze", {
    baseSha: sha(1),
    harness: "h",
    candidates: ["a", "b", "c", "z"].map((id) => ({ id, item: id, author: "builder" })),
  });
  for (const id of ["a", "b", "c", "z"]) s = call(s, "provision", { candidate: id, workspace: id });
  assert.deepEqual(
    next(s, m)
      .briefs.map((b) => b.item.id)
      .sort(),
    ["a", "b", "c"],
  );
});

test("token budgeting skips resource-capped work before admitting other authors", () => {
  const cfg = {
    ...config,
    concurrencyCap: 3,
    maxCandidates: 3,
    totalBudget: { tokens: 10 },
    candidateBudget: { tokens: 10 },
  };
  let s = init({ methodology: m, config: cfg }).state;
  s = {
    ...s,
    roles: {
      ...s.roles,
      builder: { ...s.roles.builder!, maxConcurrent: 1 },
      other: { ...s.roles.builder!, id: "other", name: "other" },
    },
  };
  for (const id of ["a", "b", "c"])
    s = addItem(
      s,
      { id, title: id, acceptance: ["ok"], weight: id === "b" ? 9 : 1 },
      "coordinator",
    );
  s = call(s, "freeze", {
    baseSha: sha(1),
    harness: "h",
    candidates: ["a", "b", "c"].map((id) => ({
      id,
      item: id,
      author: id === "c" ? "other" : "builder",
    })),
  });
  for (const id of ["a", "b", "c"]) s = call(s, "provision", { candidate: id, workspace: id });
  s = call(s, "start", { candidate: "a" }, "builder");
  assert.deepEqual(
    next(s, m).briefs.map((b) => b.item.id),
    ["c"],
  );
});
