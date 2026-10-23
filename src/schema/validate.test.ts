import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkflowError } from "../errors.ts";
import type { JsonSchema } from "./types.ts";
import { CORE_DEFINITIONS, WATERFALL_DEFINITIONS } from "./generated.ts";
import { assertValid, validate } from "./validate.ts";

const paths = (schema: JsonSchema, value: unknown) =>
  validate(schema, value).map((e) => `${e.path} ${e.keyword}`);

const def = (name: string): JsonSchema => ({
  $ref: `#/definitions/${name}`,
  definitions: CORE_DEFINITIONS,
});
const defW = (name: string): JsonSchema => ({
  $ref: `#/definitions/${name}`,
  definitions: WATERFALL_DEFINITIONS,
});

test("type, const, enum, number and string keywords", () => {
  assert.deepEqual(paths({ type: "string" }, "x"), []);
  assert.deepEqual(paths({ type: "string" }, 1), ["/ type"]);
  assert.deepEqual(paths({ type: ["string", "null"] }, null), []);
  assert.deepEqual(paths({ type: "integer" }, 1.5), ["/ type"]);
  assert.deepEqual(paths({ type: "array" }, {}), ["/ type"]);
  assert.deepEqual(paths({ type: "object" }, []), ["/ type"]);
  assert.deepEqual(paths({ type: "object" }, null), ["/ type"]);
  assert.deepEqual(paths({ const: 1, type: "number" }, 2), ["/ const"]);
  assert.deepEqual(paths({ enum: ["a", "b"] }, "c"), ["/ enum"]);
  assert.deepEqual(paths({ enum: ["a", "b"] }, "b"), []);
  assert.deepEqual(paths({ type: "number", minimum: 1, maximum: 3 }, 0), ["/ minimum"]);
  assert.deepEqual(paths({ type: "number", minimum: 1, maximum: 3 }, 4), ["/ maximum"]);
  assert.deepEqual(paths({ type: "string", minLength: 2 }, "a"), ["/ minLength"]);
  assert.deepEqual(paths({ type: "string", pattern: "^[a-z]+$" }, "A"), ["/ pattern"]);
  // an empty schema accepts anything
  assert.deepEqual(paths({}, undefined), []);
  assert.deepEqual(paths({}, { any: [1, null] }), []);
});

test("objects: required, properties, additionalProperties false or schema; paths are JSON pointers", () => {
  const s: JsonSchema = {
    type: "object",
    properties: { id: { type: "string" }, n: { type: "number" } },
    required: ["id"],
    additionalProperties: false,
  };
  assert.deepEqual(paths(s, { id: "a" }), []);
  assert.deepEqual(paths(s, { n: 1 }), ["/id required"]);
  assert.deepEqual(paths(s, { id: 1, bogus: true }), ["/id type", "/bogus additionalProperties"]);
  const map: JsonSchema = { type: "object", additionalProperties: { type: "number" } };
  assert.deepEqual(paths(map, { a: 1, "b/c": "x" }), ["/b~1c type"]);
  // a key that is present with undefined counts as present (in-memory objects); JSON drops it anyway
  assert.deepEqual(paths(s, { id: undefined }), ["/id type"]);
});

test("arrays: items, nested paths", () => {
  const s: JsonSchema = {
    type: "object",
    properties: {
      xs: {
        type: "array",
        items: { type: "object", properties: { k: { type: "string" } }, required: ["k"] },
      },
    },
  };
  assert.deepEqual(paths(s, { xs: [{ k: "a" }, {}, { k: 2 }] }), [
    "/xs/1/k required",
    "/xs/2/k type",
  ]);
});

test("$ref resolves into the root document's definitions", () => {
  const doc: JsonSchema = {
    $ref: "#/definitions/A",
    definitions: {
      A: { type: "object", properties: { b: { $ref: "#/definitions/B" } }, required: ["b"] },
      B: { type: "object", properties: { v: { type: "number" } }, required: ["v"] },
    },
  };
  assert.deepEqual(paths(doc, { b: { v: 1 } }), []);
  assert.deepEqual(paths(doc, { b: { v: "x" } }), ["/b/v type"]);
  assert.throws(
    () => validate({ $ref: "#/definitions/Missing", definitions: {} }, 1),
    (e: unknown) =>
      e instanceof WorkflowError && e.code === "invalid-input" && /Missing/.test(e.message),
  );
  assert.throws(
    () => validate({ $ref: "https://example.com/x.json" }, 1),
    (e: unknown) => e instanceof WorkflowError && /\$ref/.test(e.message),
  );
});

test("anyOf: a branch that matches wins; otherwise the branch whose discriminator matched reports", () => {
  const policy: JsonSchema = {
    anyOf: [
      {
        type: "object",
        properties: {
          kind: { const: "evidence", type: "string" },
          evidenceKind: { type: "string" },
        },
        required: ["kind", "evidenceKind"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { kind: { const: "acceptance-written", type: "string" } },
        required: ["kind"],
        additionalProperties: false,
      },
    ],
  };
  assert.deepEqual(paths(policy, { kind: "acceptance-written" }), []);
  assert.deepEqual(paths(policy, { kind: "evidence", evidenceKind: "test-output" }), []);
  // discriminator says branch 0; its single missing field is the report, not branch 1's const mismatch
  assert.deepEqual(paths(policy, { kind: "evidence" }), ["/evidenceKind required"]);
  // unknown discriminator: every branch has a const error at /kind, so it is reported once as an enum
  assert.deepEqual(paths(policy, { kind: "nope" }), ["/kind enum"]);
  // wrong type entirely: every branch weighs the same (a root type error), so the first branch reports
  assert.deepEqual(paths(policy, "str"), ["/ type"]);
});

test("anyOf discriminators: a typo is reported as an enum of the discriminator values; a scalar against object branches names the const", () => {
  const policy = validate(def("Policy"), { kind: "nope" });
  assert.deepEqual(
    policy.map((e) => `${e.path} ${e.keyword}`),
    ["/kind enum"],
  );
  assert.match(policy[0]?.expected ?? "", /"evidence"/);
  assert.match(policy[0]?.expected ?? "", /"custom"/);
  assert.deepEqual(paths(def("LessonChange"), { kind: "nope", text: "t" }), ["/kind enum"]);
  const req = validate(def("GateRequirement"), "humna");
  assert.deepEqual(
    req.map((e) => `${e.path} ${e.keyword}`),
    ["/ const"],
  );
  assert.equal(req[0]?.expected, '"human"');
  assert.deepEqual(
    paths(defW("Gate"), { id: "g", requires: [], evidence: [], onFail: { action: "blok" } }),
    ["/onFail/action enum"],
  );
});

test("assertValid throws invalid-input naming what, the first path, the count and a fix", () => {
  const s: JsonSchema = {
    type: "object",
    properties: { a: { type: "number" }, b: { type: "number" } },
    required: ["a", "b"],
  };
  assertValid(s, { a: 1, b: 2 }, "thing");
  assert.throws(
    () => assertValid(s, { a: "x" }, "role manifest r.json"),
    (e: unknown) =>
      e instanceof WorkflowError &&
      e.code === "invalid-input" &&
      e.message ===
        "role manifest r.json does not match its schema: /a expected number, got string (+1 more)" &&
      e.fix === 'fix role manifest r.json at /a: expected number, found "x"',
  );
  assert.throws(
    () => assertValid(s, { a: 1 }, "thing"),
    (e: unknown) =>
      e instanceof WorkflowError &&
      e.message === 'thing does not match its schema: /b missing required property "b"',
  );
});
