// U9 P9, U11 O11: exported built-in constants are shared by every caller in the process, so they
// are frozen (deeply); a validated config gets its own copy of the defaults.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ZERO_SPENT } from "../src/index.ts";
import { SCRUM_VOCABULARY } from "../src/methodologies/scrum/index.ts";
import {
  CLASSES,
  DEFAULT_COLUMNS,
  KANBAN_CADENCES,
  KANBAN_VOCABULARY,
  validateKanbanConfig,
} from "../src/methodologies/kanban/index.ts";
import {
  DEFAULT_DELIVERABLES,
  DEFAULT_DELIVER_BY,
  DEFAULT_PHASE_IDS,
  WATERFALL_VOCABULARY,
} from "../src/methodologies/waterfall/index.ts";

const deeplyFrozen = (v: unknown, at: string): void => {
  if (typeof v !== "object" || v === null) return;
  assert.ok(Object.isFrozen(v), `${at} is frozen`);
  for (const [k, x] of Object.entries(v)) deeplyFrozen(x, `${at}.${k}`);
};

test("exported default constants are deeply frozen, with the same values", () => {
  const constants = {
    ZERO_SPENT,
    SCRUM_VOCABULARY,
    CLASSES,
    DEFAULT_COLUMNS,
    KANBAN_CADENCES,
    KANBAN_VOCABULARY,
    DEFAULT_DELIVERABLES,
    DEFAULT_DELIVER_BY,
    DEFAULT_PHASE_IDS,
    WATERFALL_VOCABULARY,
  };
  for (const [name, v] of Object.entries(constants)) deeplyFrozen(v, name);
  assert.deepEqual(ZERO_SPENT, { tokens: 0, turns: 0, wallclockMs: 0 });
  assert.equal(DEFAULT_COLUMNS.length, 5);
  assert.deepEqual(DEFAULT_DELIVERABLES["design"], ["design-doc", "interface-spec"]);
  assert.throws(() => (DEFAULT_COLUMNS[0]!.policies as unknown[]).push({ kind: "x" }), TypeError);
});

test("the default kanban columns in a validated config are a deep copy", () => {
  const cfg = validateKanbanConfig({});
  assert.deepEqual(cfg.columns, DEFAULT_COLUMNS);
  assert.notEqual(cfg.columns[0]!.policies, DEFAULT_COLUMNS[0]!.policies);
  cfg.columns[0]!.policies.push({ kind: "no-open-blockers" });
  assert.equal(DEFAULT_COLUMNS[0]!.policies.length, 1);
});
