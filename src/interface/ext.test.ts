import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createState } from "../core/state.ts";
import { WorkflowError } from "../core/errors.ts";
import type { InvestigationState } from "../core/records/investigation.ts";
import type { WorkflowState } from "../core/types.ts";
import { readExt, writeExt } from "./ext.ts";

const T0 = "2026-11-03T00:00:00.000Z";
const base = (): WorkflowState =>
  createState({ methodology: "investigation", config: {}, stages: [], roles: [], now: T0 });
const record = (phase: InvestigationState["phase"]): InvestigationState => ({
  item: "q",
  phase,
  hypotheses: [],
  rounds: [],
  contributors: [],
});

test("writeExt stores under ext and mirrors the legacy investigation/experimentation field", () => {
  const s0 = base();
  const s1 = writeExt(s0, "investigation", record("hypotheses"));
  assert.deepEqual(s1.ext, { investigation: record("hypotheses") });
  assert.deepEqual(s1.investigation, record("hypotheses"));
  assert.equal(s0.ext, undefined, "the input state is not mutated");
  assert.equal(s0.investigation, undefined);
  const s2 = writeExt(s1, "experimentation", {
    status: "running",
    baseSha: "a".repeat(40),
    harness: "h",
    candidates: {},
    released: [],
    overhead: { tokens: 0, turns: 0, wallclockMs: 0 },
  });
  assert.deepEqual(Object.keys(s2.ext!), ["investigation", "experimentation"]);
  assert.deepEqual(s2.experimentation, s2.ext!["experimentation"]);
});

test("writeExt of any other key writes only ext", () => {
  const s = writeExt(base(), "triage", { queue: ["t1"] });
  assert.deepEqual(s.ext, { triage: { queue: ["t1"] } });
  assert.equal(Object.hasOwn(s, "triage"), false);
  assert.deepEqual(readExt<{ queue: string[] }>(s, "triage"), { queue: ["t1"] });
});

test("writeExt with undefined removes the key and its legacy mirror", () => {
  const s1 = writeExt(writeExt(base(), "investigation", record("observe")), "triage", 1);
  const s2 = writeExt(s1, "investigation", undefined);
  assert.deepEqual(s2.ext, { triage: 1 });
  assert.equal(Object.hasOwn(s2, "investigation"), false);
});

test("writeExt with undefined on a state without ext adds no empty ext (U11 N4)", () => {
  const s0 = base();
  const s1 = writeExt(s0, "triage", undefined);
  assert.equal(Object.hasOwn(s1, "ext"), false);
  assert.notEqual(s1, s0, "still a copy");
  // a 1.1 state with only the legacy field: removing it leaves neither field
  const legacy = { ...base(), investigation: record("observe") };
  const s2 = writeExt(legacy, "investigation", undefined);
  assert.equal(Object.hasOwn(s2, "ext"), false);
  assert.equal(Object.hasOwn(s2, "investigation"), false);
  assert.deepEqual(legacy.investigation, record("observe"), "the input state is not mutated");
  // an ext the input already had stays, even when it ends up empty
  const s3 = writeExt(writeExt(base(), "triage", 1), "triage", undefined);
  assert.deepEqual(s3.ext, {});
  const s4 = writeExt({ ...base(), ext: {} }, "triage", undefined);
  assert.deepEqual(s4.ext, {});
});

test("readExt reads ext first and falls back to the legacy field of a 1.1 state", () => {
  const legacy: WorkflowState = { ...base(), investigation: record("observe") };
  assert.deepEqual(readExt(legacy, "investigation"), record("observe"));
  assert.equal(readExt(legacy, "experimentation"), undefined);
  const both: WorkflowState = {
    ...legacy,
    ext: { investigation: record("conclusion") },
  };
  assert.equal(readExt(both, "investigation")?.phase, "conclusion");
  assert.equal(readExt(base(), "triage"), undefined);
});

test("ext keys are ids", () => {
  for (const key of ["", "__proto__", "a b", "../x"])
    assert.throws(
      () => writeExt(base(), key, 1),
      (e: unknown) => e instanceof WorkflowError && e.code === "invalid-input",
    );
  assert.throws(() => readExt(base(), "__proto__"), WorkflowError);
});

// The accessors are the only way to read or write ext and the legacy mirrors (spec 26).
test("no source outside src/interface/ext.ts touches ext or the legacy fields directly", () => {
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return files(full);
      return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [full] : [];
    });
  const exempt = new Set(
    ["interface/ext.ts", "core/types.ts", "schema/generated.ts"].map((f) => path.join(src, f)),
  );
  // a property read (`s.ext`, `s.investigation`) or a spread write (`{ ...s, investigation: x }`)
  const direct =
    /\.(ext|investigation|experimentation)\b(?!\.ts)|\.\.\.\w+,\s*(ext|investigation|experimentation):/;
  const offenders = files(src)
    .filter((f) => !exempt.has(f))
    .flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .map((line, i) => ({ line, at: `${path.relative(src, f)}:${i + 1}` }))
        .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line) && direct.test(line))
        .map(({ at, line }) => `${at}: ${line.trim()}`),
    );
  assert.deepEqual(offenders, []);
});
