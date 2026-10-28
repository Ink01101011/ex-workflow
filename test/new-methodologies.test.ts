import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCommand } from "../src/cli/commands.ts";
import { loadState, saveState } from "../src/adapters/file.ts";
import * as schema from "../src/schema/index.ts";

for (const name of ["investigation", "experimentation"] as const) {
  test(`${name}: CLI init, persistence, report, metrics and unknown ceremony`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), `exwf-${name}-`));
    try {
      const config =
        name === "investigation"
          ? {
              question: "Why does the repeated request miss the cache?",
              maxRounds: 3,
              budget: { tokens: 100000, turns: 20 },
            }
          : {
              objective: "Lowest median latency",
              direction: "minimize",
              tieBreak: "candidate-id",
              concurrencyCap: 2,
              maxCandidates: 2,
              candidateBudget: { tokens: 40000 },
              totalBudget: { tokens: 100000 },
            };
      const file = path.join(root, "config.json");
      await writeFile(file, JSON.stringify(config));
      const result = await runCommand(["init", name, "--config", file], root);
      assert.equal(result.exit, 0, JSON.stringify(result.out));
      const ceremony = async (ceremonyName: string, input: object, by: string) => {
        await writeFile(file, JSON.stringify(input));
        const ceremonyResult = await runCommand(["ceremony", ceremonyName, file, "--by", by], root);
        assert.equal(ceremonyResult.exit, 0, JSON.stringify(ceremonyResult.out));
        const persisted = await loadState(root);
        assert.deepEqual(schema.validate(schema.workflowStateSchema, persisted), []);
        await saveState(root, persisted);
        assert.deepEqual(await loadState(root), persisted);
      };
      if (name === "investigation") {
        await ceremony("intake", { item: "INV" }, "investigator");
        await ceremony(
          "hypotheses",
          {
            hypotheses: [
              { id: "cache", claim: "Cache key differs", falsifiedBy: "Same cache key" },
              { id: "expiry", claim: "Entry expires", falsifiedBy: "Live entry" },
            ],
          },
          "investigator",
        );
        await ceremony(
          "preregister",
          {
            experiment: {
              id: "probe",
              procedureRef: "probe.ts",
              predictions: [
                { hypothesis: "cache", prediction: "different keys" },
                { hypothesis: "expiry", prediction: "identical keys, expired entry" },
              ],
            },
          },
          "investigator",
        );
      } else {
        await writeFile(
          file,
          JSON.stringify({ id: "A", title: "Candidate A", acceptance: ["Lower latency"] }),
        );
        const added = await runCommand(["add", file, "--by", "coordinator"], root);
        assert.equal(added.exit, 0, JSON.stringify(added.out));
        await ceremony(
          "freeze",
          {
            baseSha: "a".repeat(40),
            harness: "bench-v1",
            candidates: [{ id: "a", item: "A", author: "builder" }],
          },
          "coordinator",
        );
        await ceremony(
          "provision",
          { candidate: "a", workspace: "/isolated/a", baseSha: "a".repeat(40), isolated: true },
          "coordinator",
        );
        await ceremony("start", { candidate: "a" }, "builder");
        await ceremony(
          "submit",
          {
            candidate: "a",
            sha: "b".repeat(40),
            score: 12,
            baseSha: "a".repeat(40),
            workspace: "/isolated/a",
            harness: "bench-v1",
            command: "node bench.mjs",
            log: "bench.log",
            spent: { tokens: 100, turns: 1, wallclockMs: 25 },
          },
          "builder",
        );
        await ceremony(
          "validate",
          {
            candidate: "a",
            sha: "b".repeat(40),
            harness: "bench-v1",
            passed: true,
            reproducible: true,
            evidence: "bench-output.json",
            spent: { tokens: 10, turns: 1, wallclockMs: 10 },
          },
          "validator",
        );
      }
      const state = await loadState(root);
      assert.equal(state.methodology, name);
      assert.equal((await runCommand(["status"], root)).exit, 0);
      assert.equal((await runCommand(["metrics"], root)).exit, 0);
      assert.equal((await runCommand(["board"], root)).exit, 0);
      const unknown = await runCommand(["ceremony", "missing"], root);
      assert.equal(unknown.exit, 1);
      assert.equal((unknown.out as { error: { code: string } }).error.code, "unknown-ceremony");
      assert.deepEqual(await loadState(root), state);
      await saveState(root, state);
      assert.deepEqual(await loadState(root), state);
      assert.equal((await runCommand(["next"], root)).exit, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("standalone methodology config schemas are public and reject malformed contracts", () => {
  for (const name of ["investigationConfigSchema", "experimentationConfigSchema"] as const) {
    assert.ok(name in schema, `${name} must be exported`);
    const document = (schema as Record<string, unknown>)[name] as schema.JsonSchemaDocument;
    assert.ok(schema.validate(document, { budget: "unbounded", objective: 3 }).length > 0);
  }
});
