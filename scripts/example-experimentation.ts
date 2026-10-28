/** Synthetic, in-memory SDK demo. No worktree, Git operation or benchmark is actually run. */
import assert from "node:assert/strict";
import { init, addItem } from "../src/index.ts";
import { experimentation } from "../src/experimentation/index.ts";

const method = experimentation();
const baseSha = "a".repeat(40);
const harness = "synthetic:latency-harness-v1";
const spent = { tokens: 10, turns: 1, wallclockMs: 1 };
let { state } = init({
  methodology: method,
  config: {
    objective: "Lowest synthetic median latency",
    direction: "minimize",
    tieBreak: "candidate-id",
    concurrencyCap: 2,
    maxCandidates: 2,
    candidateBudget: { turns: 5 },
    totalBudget: { turns: 20 },
  },
});
const ceremony = (name: string, input: Record<string, unknown>, by = "coordinator") => {
  state = method.ceremonies[name]!(state, { by, ...input }).state;
};
for (const id of ["fast-invalid", "reproducible"])
  state = addItem(
    state,
    { id, title: id, acceptance: ["Pass the frozen harness reproducibly"] },
    "coordinator",
  );
ceremony("freeze", {
  baseSha,
  harness,
  candidates: [
    { id: "fast-invalid", item: "fast-invalid", author: "builder" },
    { id: "reproducible", item: "reproducible", author: "builder" },
  ],
});
for (const [id, sha, score, reproducible] of [
  ["fast-invalid", "b".repeat(40), 1, false],
  ["reproducible", "c".repeat(40), 2, true],
] as const) {
  const workspace = `synthetic:isolated-workspace-${id}`;
  // Real hosts create an isolated workspace at baseSha and verify ownership before attesting.
  ceremony("provision", { candidate: id, workspace, baseSha, isolated: true });
  ceremony("start", { candidate: id }, "builder");
  // Simulated host result: replace these identities and measurements with actual execution output.
  ceremony(
    "submit",
    {
      candidate: id,
      sha,
      score,
      spent,
      baseSha,
      workspace,
      harness,
      command: "synthetic:benchmark --frozen",
      log: `synthetic:${id}:benchmark-log`,
    },
    "builder",
  );
  ceremony(
    "validate",
    {
      candidate: id,
      sha,
      harness,
      passed: true,
      reproducible,
      evidence: `synthetic:${id}:independent-validation`,
      spent,
    },
    "validator",
  );
}
ceremony("compare", {});
assert.equal(state.experimentation!.selected, "reproducible");
assert.equal(state.experimentation!.candidates["fast-invalid"]!.status, "failed");
const selectedSha = "c".repeat(40);
const targetSha = "d".repeat(40); // synthetic target has advanced since the frozen baseline
const integrationSha = "e".repeat(40);
// A real host promotes the exact selected SHA against targetSha before recording integration.
ceremony("integrate", { selectedSha, targetSha, integrationSha, spent }, "integrator");
ceremony(
  "validate-integration",
  {
    sha: integrationSha,
    targetSha,
    harness,
    passed: true,
    evidence: "synthetic:fresh-integration-validation",
    spent,
  },
  "validator",
);
assert.equal(state.experimentation!.status, "integrated");
// A real host releases only its owned workspaces before recording cleanup.
ceremony("cleanup", {
  workspaces: Object.values(state.experimentation!.candidates).map((c) => c.workspace!),
});
assert.equal(state.experimentation!.released.length, 2);
console.log(
  JSON.stringify({
    synthetic: true,
    status: state.experimentation!.status,
    selected: state.experimentation!.selected,
    released: state.experimentation!.released.length,
  }),
);
