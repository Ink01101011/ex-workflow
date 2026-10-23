import { test } from "node:test";
import assert from "node:assert/strict";
import { init } from "../index.ts";
import { scrum } from "../scrum/index.ts";
import { kanban } from "../kanban/index.ts";
import { waterfall } from "../waterfall/index.ts";
import { WorkflowError } from "../errors.ts";
import type { Methodology } from "../types.ts";
import {
  assertValid,
  handoffSchema,
  itemPatchSchema,
  kanbanConfigSchema,
  newItemSchema,
  roleSchema,
  scrumConfigSchema,
  validate,
  waterfallConfigSchema,
  workflowStateSchema,
} from "./index.ts";
import type { JsonSchemaDocument } from "./index.ts";

const roundTrip = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const at = (v: unknown, schema = workflowStateSchema) =>
  validate(schema, v).map((e) => `${e.path} ${e.keyword}`);
const check = <C>(m: Methodology<C>, config: unknown, schema: JsonSchemaDocument) => {
  const validated = m.validateConfig(config);
  assert.deepEqual(validate(schema, roundTrip(validated)), [], `${m.name} config`);
  const state = init({ methodology: m, config, now: T0 }).state;
  assert.deepEqual(validate(workflowStateSchema, roundTrip(state)), [], `${m.name} state`);
  for (const role of Object.values(state.roles))
    assert.deepEqual(validate(roleSchema, roundTrip(role)), [], `${m.name} role ${role.id}`);
};

const T0 = "2026-10-23T00:00:00.000Z";
const SCRUM_CONFIG = {
  sprintBudget: { tokens: 300_000 },
  productGoal: "ship the checkout",
  definitionOfDone: [{ kind: "evidence", evidenceKind: "test-output" }],
};

test("every document resolves its root $ref and every $ref inside it", () => {
  const docs = {
    workflowStateSchema,
    roleSchema,
    newItemSchema,
    handoffSchema,
    itemPatchSchema,
    scrumConfigSchema,
    kanbanConfigSchema,
    waterfallConfigSchema,
  };
  for (const [name, doc] of Object.entries(docs)) {
    assert.equal(doc.$schema, "http://json-schema.org/draft-07/schema#", name);
    const refs = JSON.stringify(doc).match(/"\$ref":"#\/definitions\/([^"]+)"/g) ?? [];
    assert.ok(refs.length > 0, `${name} has refs`);
    for (const r of refs) {
      const target = r.slice('"$ref":"#/definitions/'.length, -1);
      assert.ok(Object.hasOwn(doc.definitions, target), `${name}: ${target} is defined`);
    }
  }
});

test("init() states, default roles and validated configs of all three methodologies validate after a JSON round trip", () => {
  check(scrum(), SCRUM_CONFIG, scrumConfigSchema);
  check(kanban(), {}, kanbanConfigSchema);
  check(waterfall(), {}, waterfallConfigSchema);
});

test("negative fixtures fail at the right path", () => {
  const state = roundTrip(init({ methodology: scrum(), config: SCRUM_CONFIG, now: T0 }).state);
  assert.deepEqual(at({ ...state, version: 2 }), ["/version const"]);
  const { lessons: _dropped, ...noLessons } = state;
  assert.deepEqual(at(noLessons), ["/lessons required"]);
  assert.deepEqual(at({ ...state, extra: 1 }), ["/extra additionalProperties"]);
  assert.deepEqual(at({ ...state, methodology: "xp" }), ["/methodology enum"]);
  assert.deepEqual(
    at({
      ...state,
      stages: [
        { ...state.stages[0], exitPolicy: [{ kind: "evidence" }] },
        ...state.stages.slice(1),
      ],
    }),
    ["/stages/0/exitPolicy/0/evidenceKind required"],
  );
  assert.deepEqual(at({ id: "x", title: "t", status: "nope" }, newItemSchema), [
    "/status additionalProperties",
  ]);
  assert.deepEqual(at({ id: "x", title: "t", type: "feature" }, newItemSchema), ["/type enum"]);
  assert.deepEqual(at({ foo: 1 }, itemPatchSchema), ["/foo additionalProperties"]);
  assert.deepEqual(at({ priority: "high" }, itemPatchSchema), ["/priority type"]);
  const validIteration = {
    id: "i1",
    goal: "g",
    budget: {},
    spent: { tokens: 0, turns: 0, wallclockMs: 0 },
    startedAt: T0,
    committed: [],
    carryover: [],
  };
  assert.deepEqual(at({ ...state, iterations: [{ ...validIteration, spent: {} }] }), [
    "/iterations/0/spent/tokens required",
    "/iterations/0/spent/turns required",
    "/iterations/0/spent/wallclockMs required",
  ]);
  assert.deepEqual(
    at(
      {
        item: "x",
        role: "dev",
        produced: [],
        notes: "",
        do_not: [],
        open_questions: [],
        verdict: "maybe",
      },
      handoffSchema,
    ),
    ["/verdict enum"],
  );
  assert.deepEqual(
    at(
      {
        id: "r",
        name: "R",
        modelTier: "huge",
        capabilities: [],
        canApprove: [],
        inputs: [],
        outputs: [],
        do_not: [],
      },
      roleSchema,
    ),
    ["/modelTier enum"],
  );
  assert.throws(
    () => assertValid(workflowStateSchema, { ...state, version: 2 }, ".workflow/state.json"),
    (e: unknown) =>
      e instanceof WorkflowError &&
      e.code === "invalid-input" &&
      /\/version expected 1/.test(e.message),
  );
});
