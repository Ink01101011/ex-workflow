import { addSpent } from "./budget.ts";
import { fail } from "./errors.ts";
import { checkGate, lastDispatchBefore, raisePending } from "./gates.ts";
import {
  addEvidence,
  addItem,
  advanceItem,
  clearRole,
  getItem,
  moveItem,
  patchItem,
  raiseBlocker,
  stageOf,
} from "./items.ts";
import { assertPolicies } from "./policies.ts";
import { openIteration } from "./planner.ts";
import { rolesWith } from "./roles.ts";
import { appendEvent, nowOf } from "./state.ts";
import type {
  Accounting,
  ApplyResult,
  Handoff,
  Methodology,
  NewItem,
  Violation,
  WorkItem,
  WorkflowState,
} from "./types.ts";

const VERDICTS: readonly string[] = ["done", "needs-review", "rework", "blocked", "escalate"];
const LESSON_SCOPES: readonly string[] = ["policy", "skill", "memory", "spec", "review"];

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown) => typeof x === "string";

function validate(state: WorkflowState, handoff: Handoff, acc: Accounting): void {
  const item = getItem(state, handoff.item);
  if (item.status !== "in_progress")
    fail(
      "invalid-transition",
      `item "${item.id}" is ${item.status}, not in_progress`,
      "only dispatched items can be completed; call next() first",
      { items: [item.id] },
    );
  if (!Array.isArray(handoff.do_not))
    fail(
      "handoff-invalid",
      `handoff for "${item.id}" has no do_not array`,
      "set handoff.do_not to [] when there is nothing to forbid",
      { items: [item.id] },
    );
  if (!Array.isArray(handoff.produced) || !Array.isArray(handoff.open_questions))
    fail(
      "handoff-invalid",
      `handoff for "${item.id}" needs produced[] and open_questions[]`,
      "pass empty arrays when there is nothing",
      { items: [item.id] },
    );
  const bad = (what: string, fix: string) =>
    fail("handoff-invalid", `handoff for "${item.id}": ${what}`, fix, { items: [item.id] });
  const verdict = handoff.verdict ?? "done";
  if (!VERDICTS.includes(verdict))
    bad(`unknown verdict ${JSON.stringify(verdict)}`, `use one of: ${VERDICTS.join(", ")}`);
  if (!handoff.produced.every((p) => isObj(p) && str(p.kind) && str(p.ref)))
    bad("produced[] entries need string kind and ref", 'use { "kind": "code", "ref": "src/a.ts" }');
  const lessons: unknown = handoff.lessons ?? [];
  if (
    !Array.isArray(lessons) ||
    !lessons.every((l) => isObj(l) && str(l.text) && LESSON_SCOPES.includes(l.scope as string))
  )
    bad(
      "lessons[] entries need a text and a scope",
      `scope is one of: ${LESSON_SCOPES.join(", ")}`,
    );
  const followUps: unknown = handoff.follow_ups ?? [];
  if (!Array.isArray(followUps) || !followUps.every((f) => isObj(f) && str(f.id) && str(f.title)))
    bad("follow_ups[] entries need a string id and title", "describe each follow-up as a new item");
  if (handoff.role !== item.role)
    fail(
      "handoff-invalid",
      `handoff role "${handoff.role}" differs from the dispatched role "${item.role}"`,
      `complete as "${item.role}" or re-dispatch`,
      { items: [item.id] },
    );
  if (!acc.model || acc.model.trim() === "")
    fail(
      "accounting-invalid",
      `accounting for "${item.id}" has no model`,
      "record the model id that actually ran the work",
      { items: [item.id] },
    );
  for (const k of ["tokensIn", "tokensOut", "durationMs"] as const) {
    if (!Number.isFinite(acc[k]) || acc[k] < 0)
      fail(
        "accounting-invalid",
        `accounting.${k} must be a non-negative number`,
        `measure ${k} from the host's usage report`,
        { items: [item.id] },
      );
  }
  if (acc.tokensIn + acc.tokensOut === 0 && acc.estimate !== true)
    fail(
      "accounting-invalid",
      `accounting for "${item.id}" records 0 tokens`,
      "pass the host's usage figures, or set estimate: true (CLI --estimate) to record a placeholder and correct it later with correctAccounting / exwf account",
      { items: [item.id] },
    );
}

/** Stage the item was pulled from: the `from.stage` of its last transition into in_progress, else its current stage. */
function pulledFromStage(item: WorkItem): string {
  for (let i = item.transitions.length - 1; i >= 0; i--) {
    const t = item.transitions[i]!;
    if (t.to.status === "in_progress") return t.from.stage;
  }
  return item.stage;
}

/** Stage a reworked item returns to: the from.stage of the last dispatch made from a stage strictly before the current one (so a reviewer's rework lands where the work was pulled from), else the plain pulled-from stage. */
function reworkStage(state: WorkflowState, item: WorkItem): string {
  return lastDispatchBefore(state, item)?.from.stage ?? pulledFromStage(item);
}

export function complete(
  state: WorkflowState,
  methodology: Methodology,
  handoff: Handoff,
  acc: Accounting,
  now?: string,
): ApplyResult {
  validate(state, handoff, acc);
  const at = nowOf(now);
  const id = handoff.item;
  const role = handoff.role;
  let s: WorkflowState = { ...state, accounting: [...state.accounting, acc] };
  for (const p of handoff.produced)
    s = addEvidence(s, id, { kind: p.kind, ref: p.ref, by: role }, at);
  const it = openIteration(s);
  if (it && (it.committed.includes(id) || getItem(s, id).iteration === it.id)) {
    s = {
      ...s,
      iterations: s.iterations.map((x) =>
        x.id === it.id ? { ...x, spent: addSpent(x.spent, acc) } : x,
      ),
    };
  }

  for (const l of handoff.lessons ?? []) {
    const lid = `L${s.lessons.length + 1}`;
    s = {
      ...s,
      lessons: [
        ...s.lessons,
        { id: lid, at, text: l.text, scope: l.scope, status: "raised", from: role, item: id },
      ],
    };
    s = appendEvent(
      s,
      "lesson.raised",
      role,
      { id: lid, from: role, item: id, scope: l.scope },
      at,
    );
  }

  const followUps: string[] = [];
  for (const n of handoff.follow_ups ?? []) {
    const first = s.stages[0]!;
    const { iteration: _drop, ...rest } = n;
    s = addItem(
      s,
      { ...rest, stage: first.id, parent: id, tags: [...(n.tags ?? []), "follow-up"] },
      role,
      at,
    );
    followUps.push(n.id);
  }

  const verdict = handoff.verdict ?? "done";
  const warnings: Violation[] = [];
  if ((verdict === "done" || verdict === "needs-review") && handoff.open_questions.length > 0)
    warnings.push({
      rule: "open-questions-ignored",
      severity: "warning",
      item: id,
      message: `"${id}" finished with ${handoff.open_questions.length} open question(s) nobody will see: ${handoff.open_questions.join(" | ")}`,
      fix: 'use verdict "escalate" to route them to a role with capability escalate, or answer them in the next brief',
    });
  if (verdict === "rework") {
    if (!handoff.notes || handoff.notes.trim() === "")
      fail(
        "handoff-invalid",
        `rework on "${id}" needs notes`,
        "say what must change in handoff.notes",
        { items: [id] },
      );
    const item = getItem(s, id);
    s = clearRole(moveItem(s, id, { stage: reworkStage(s, item), status: "todo" }, role, at), id);
    s = appendEvent(s, "item.rework", role, { id, by: role, notes: handoff.notes }, at);
  } else if (
    (verdict === "done" || verdict === "needs-review") &&
    getItem(s, id).type === "question"
  ) {
    // a question is answered, not delivered: it skips exit policies and gates
    const lastStageId = s.stages[s.stages.length - 1]!.id;
    s = moveItem(s, id, { stage: lastStageId, status: "done" }, role, at);
  } else if (verdict === "done" || verdict === "needs-review") {
    const item = getItem(s, id);
    const stage = stageOf(s, item.stage);
    assertPolicies(s, item, stage.exitPolicy, `leave "${stage.id}"`);
    if (stage.gate) {
      const res = checkGate(s, item, stage.gate, role);
      if (res.outcome === "fail")
        fail(
          "gate-unmet",
          `gate "${stage.gate.id}" blocks "${id}": ${res.violations.map((v) => v.message).join("; ")}`,
          res.violations.map((v) => v.fix).join("; "),
          { items: [id], rule: res.violations[0]!.rule },
        );
      if (res.outcome === "human") {
        s = raisePending(
          s,
          {
            kind: "gate",
            item: id,
            gate: stage.gate.id,
            question: `Approve gate "${stage.gate.id}" for "${item.title}" (${id})?`,
          },
          at,
        );
      } else {
        s = appendEvent(
          advanceItem(s, id, role, verdict === "needs-review", at),
          "gate.passed",
          role,
          { item: id, gate: stage.gate.id },
          at,
        );
      }
    } else {
      s = advanceItem(s, id, role, verdict === "needs-review", at);
    }
  } else if (verdict === "blocked") {
    s = raiseBlocker(s, id, handoff.notes || "blocked by worker", role, role, at);
  } else if (verdict === "escalate") {
    const thinker = rolesWith(s, "escalate")[0];
    if (!thinker)
      fail(
        "missing-capability",
        `no role has capability "escalate" to receive the question from "${id}"`,
        "register a role with capability escalate",
        { items: [id] },
      );
    const n = Object.keys(s.items).filter((k) => k.startsWith(`${id}-q`)).length + 1;
    const qid = `${id}-q${n}`;
    const parent = getItem(s, id);
    const pulledFrom = pulledFromStage(parent);
    const q: NewItem = {
      id: qid,
      type: "question",
      title: handoff.open_questions.join(" | ") || handoff.notes || `question from ${id}`,
      parent: id,
      role: thinker.id,
      priority: Number.MAX_SAFE_INTEGER,
      stage: pulledFrom,
    };
    if (parent.iteration !== undefined) q.iteration = parent.iteration;
    s = addItem(s, q, role, at);
    s = moveItem(s, id, { stage: pulledFrom, status: "todo" }, role, at);
    s = patchItem(s, id, (x) => ({ ...x, dependsOn: [...x.dependsOn, qid] }));
    s = appendEvent(s, "item.escalated", role, { id, question: qid, to: thinker.id }, at);
  }

  s = appendEvent(
    s,
    "item.completed",
    role,
    {
      id,
      role,
      verdict,
      produced: handoff.produced,
      notes: handoff.notes,
      do_not: handoff.do_not,
      open_questions: handoff.open_questions,
      followUps,
      tokens: acc.tokensIn + acc.tokensOut,
      durationMs: acc.durationMs,
      model: acc.model,
    },
    at,
  );
  if (methodology.afterComplete) s = methodology.afterComplete(s, id, at);
  return { state: s, warnings };
}
