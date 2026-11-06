import { test } from "node:test";
import assert from "node:assert/strict";
import { createState } from "../../core/state.ts";
import { addItem, getItem } from "../../core/items/record.ts";
import { moveItem } from "../../core/items/move.ts";
import { WorkflowError } from "../../core/errors.ts";
import type { Action, Methodology, Role, Rule, WorkflowState } from "../../core/types.ts";
import { recordRiskAssessment, type RiskAssessmentInput } from "./assessment.ts";

const T0 = "2026-11-06T00:00:00.000Z";
const r = (id: string, caps: Role["capabilities"]): Role => ({
  id,
  name: id,
  modelTier: "small",
  capabilities: caps,
  canApprove: [],
  inputs: [],
  outputs: [],
  do_not: [],
});
const roles = [r("dev", ["deliver", "verify"]), r("risk", ["verify"]), r("pm", ["order-backlog"])];
const m = (rules: Rule[] = []): Methodology => ({
  name: "kanban",
  vocabulary: {} as Methodology["vocabulary"],
  validateConfig: (c) => c,
  defaultStages: () => [],
  defaultRoles: () => roles,
  requiredCapabilities: [],
  exclusiveCapabilities: [],
  plannerOptions: () => ({ schedulerMode: "throughput" }),
  candidates: () => [],
  invariants: () => [],
  ceremonies: {},
  rules,
  metrics: () => ({}),
  humanDefaults: { gates: "none" },
});
const base = (): WorkflowState => {
  let s = createState({
    methodology: "kanban",
    config: {},
    stages: [{ id: "dev", name: "Dev", entryPolicy: [], exitPolicy: [] }],
    roles,
    now: T0,
  });
  s = addItem(s, { id: "A", title: "a" }, "pm", T0);
  return moveItem(s, "A", { stage: "dev", status: "in_progress" }, "dev", T0);
};
const input = (over: Partial<Record<keyof RiskAssessmentInput, unknown>> = {}) =>
  ({
    item: "A",
    level: "high",
    factors: ["ci-cd"],
    ref: "risk/A.md",
    by: "risk",
    now: T0,
    ...over,
  }) as RiskAssessmentInput;
const refused = (over: Partial<Record<keyof RiskAssessmentInput, unknown>>, re: RegExp) =>
  assert.throws(
    () => recordRiskAssessment(base(), m(), input(over)),
    (e) => e instanceof WorkflowError && e.code === "invalid-input" && re.test(e.message),
    JSON.stringify(over),
  );

test("records evidence risk-assessment with data copied field by field", () => {
  const factors = ["ci-cd", "secrets"];
  const { state, warnings } = recordRiskAssessment(
    base(),
    m(),
    input({ factors, subject: "abc123" }),
  );
  assert.deepEqual(warnings, []);
  assert.deepEqual(getItem(state, "A").evidence, [
    {
      kind: "risk-assessment",
      ref: "risk/A.md",
      by: "risk",
      at: T0,
      data: { level: "high", factors: ["ci-cd", "secrets"], subject: "abc123" },
    },
  ]);
  factors.push("later");
  assert.deepEqual(getItem(state, "A").evidence[0]!.data!["factors"], ["ci-cd", "secrets"]);
  assert.deepEqual(state.events.at(-1)!.payload, {
    id: "A",
    kind: "risk-assessment",
    ref: "risk/A.md",
  });
  // human may always assess; subject is optional and absent when omitted
  const h = recordRiskAssessment(base(), m(), input({ by: "human", subject: undefined })).state;
  assert.deepEqual(getItem(h, "A").evidence[0]!.data, { level: "high", factors: ["ci-cd"] });
});

test("goes through applyAction: rules see action risk.assess and can refuse it", () => {
  const seen: Action[] = [];
  const watch: Rule = {
    id: "watch",
    severity: "warning",
    check: (_s, a) => {
      seen.push(a);
      return a.type === "risk.assess"
        ? [{ rule: "watch", severity: "warning", message: "seen", fix: "none" }]
        : [];
    },
  };
  const res = recordRiskAssessment(base(), m([watch]), input());
  assert.equal(seen[0]!.type, "risk.assess");
  assert.equal(seen[0]!.by, "risk");
  assert.deepEqual(seen[0]!.payload, {
    item: "A",
    ref: "risk/A.md",
    level: "high",
    factors: ["ci-cd"],
  });
  assert.equal(res.warnings.length, 1);
  const deny: Rule = {
    ...watch,
    severity: "error",
    check: () => [{ ...watch, rule: "deny", severity: "error", message: "no", fix: "no" }],
  };
  assert.throws(
    () => recordRiskAssessment(base(), m([deny]), input()),
    (e) => e instanceof WorkflowError && e.code === "rule-violation",
  );
});

test("refuses malformed input with invalid-input", () => {
  refused({ level: "severe" }, /unknown level "severe"/);
  refused({ factors: "ci-cd" }, /factors/);
  refused({ factors: [1] }, /factors/);
  refused({ ref: "" }, /ref/);
  refused({ ref: "  " }, /ref/);
  refused({ subject: 7 }, /subject/);
  refused({ now: 7 }, /now/);
  refused({ by: "" }, /by/);
  refused({ item: 3 }, /item/);
  refused({ extra: 1 } as never, /unknown key "extra"/);
  assert.throws(
    () => recordRiskAssessment(base(), m(), null as never),
    (e) => e instanceof WorkflowError && e.code === "invalid-input",
  );
  assert.throws(
    () => recordRiskAssessment(base(), m(), input({ item: "Z" })),
    (e) => e instanceof WorkflowError && e.code === "unknown-item",
  );
});

test("refuses an assessor without verify and the item's author or assigned role", () => {
  refused({ by: "pm" }, /"pm" may not assess risk/);
  refused({ by: "ghost" }, /"ghost" may not assess risk/);
  // dev dispatched the item (author) and holds verify
  refused({ by: "dev" }, /did the work/);
  let s = base();
  s = { ...s, items: { ...s.items, A: { ...getItem(s, "A"), role: "risk" } } };
  assert.throws(
    () => recordRiskAssessment(s, m(), input()),
    (e) => e instanceof WorkflowError && /did the work/.test(e.message),
  );
});
