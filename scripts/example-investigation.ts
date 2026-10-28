/** Synthetic, in-memory SDK demo. No procedure, model or external tool is actually run. */
import assert from "node:assert/strict";
import { init, next, complete } from "../src/index.ts";
import { investigation } from "../src/investigation/index.ts";

const method = investigation();
let { state } = init({
  methodology: method,
  config: {
    question: "Synthetic cache miss: key mismatch or expiry?",
    maxRounds: 3,
    budget: { tokens: 100_000, turns: 10 },
  },
});
const ceremony = (name: string, input: Record<string, unknown>, by = "investigator") => {
  state = method.ceremonies[name]!(state, { by, ...input }).state;
};
ceremony("intake", { item: "CACHE" });
ceremony("hypotheses", {
  hypotheses: [
    { id: "key", claim: "Keys differ", falsifiedBy: "Identical keys" },
    { id: "expiry", claim: "Entries expire", falsifiedBy: "Live entry" },
  ],
});
function run(id: string, replayOf?: string) {
  ceremony("preregister", {
    experiment: {
      id,
      procedureRef: "synthetic:compare-cache-keys",
      predictions: [
        { hypothesis: "key", prediction: "different keys, live entry" },
        { hypothesis: "expiry", prediction: "identical keys, expired entry" },
      ],
      ...(replayOf ? { replayOf } : {}),
    },
  });
  const dispatched = next(state, method);
  state = dispatched.state;
  assert.equal(dispatched.briefs.length, 1);
  const brief = dispatched.briefs[0]!;
  const item = state.investigation!.rounds.at(-1)!.item;
  const role = state.items[item]!.role!;
  assert.equal(brief.item.id, item);
  // A real host executes the frozen procedure here and supplies its actual output and usage.
  const output = `synthetic:${id}:different-keys-live-entry`;
  state = complete(
    state,
    method,
    {
      item,
      role,
      produced: [{ kind: "experiment-output", ref: output }],
      notes: "Synthetic observation: keys differ; entry remains live.",
      do_not: [],
      open_questions: [],
    },
    {
      item,
      role,
      model: "synthetic-demo",
      tokensIn: 10,
      tokensOut: 10,
      durationMs: 1,
      startedAt: "2026-10-28T00:00:00Z",
      endedAt: "2026-10-28T00:00:01Z",
    },
  ).state;
  ceremony("observe", {
    experiment: id,
    result: {
      id: `result-${id}`,
      valid: true,
      summary: "Synthetic keys differ while entry remains live",
      provenanceRefs: [output],
    },
  });
  ceremony("update-belief", {
    result: `result-${id}`,
    assessments: [
      { hypothesis: "key", assessment: "supported", reason: "Keys differ" },
      { hypothesis: "expiry", assessment: "refuted", reason: "Entry remains live" },
    ],
    next: "conclusion",
  });
}
function conclude() {
  ceremony("conclude", {
    outcome: "resolved",
    summary: "Synthetic evidence supports key mismatch",
    supportedHypothesis: "key",
    evidenceRefs: state.investigation!.rounds.flatMap((r) => r.result!.provenanceRefs),
  });
}
run("original");
conclude();
ceremony(
  "review-conclusion",
  { approve: false, reason: "Require an independent replay", next: "round" },
  "conclusion-reviewer",
);
run("replay", "original");
const rounds = state.investigation!.rounds;
assert.notEqual(state.items[rounds[0]!.item]!.role, state.items[rounds[1]!.item]!.role);
conclude();
ceremony(
  "review-conclusion",
  {
    approve: true,
    reason: "Synthetic independent replay supports conclusion",
    replayRefs: ["result-replay"],
  },
  "conclusion-reviewer",
);
assert.equal(state.investigation!.outcome, "resolved");
assert.equal(state.investigation!.reviewHistory?.length, 2);
console.log(
  JSON.stringify({
    synthetic: true,
    outcome: state.investigation!.outcome,
    rounds: rounds.length,
    reviewers: state.investigation!.reviewHistory?.map((r) => r.by),
  }),
);
