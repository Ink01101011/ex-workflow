import { remaining } from "./budget.ts";
import { fail } from "./errors.ts";
import { stageOf } from "./items.ts";
import { openIteration, plan, type PlanOptions, type PlanReason, type Skipped } from "./planner.ts";
import { roleOf } from "./roles.ts";
import type { Brief, Handoff, Methodology, Verdict, WorkItem, WorkflowState } from "./types.ts";

interface CompletedPayload {
  id: string;
  role: string;
  verdict: Verdict;
  produced: Handoff["produced"];
  notes: string;
  do_not: string[];
  open_questions?: string[];
}

function completions(
  state: WorkflowState,
  itemId: string,
): Array<CompletedPayload & { at: string }> {
  const out: Array<CompletedPayload & { at: string }> = [];
  for (const ev of state.events) {
    if (ev.type === "item.completed" && (ev.payload as CompletedPayload).id === itemId)
      out.push({ ...(ev.payload as CompletedPayload), at: ev.at });
  }
  return out;
}

function lastCompletion(state: WorkflowState, itemId: string): CompletedPayload | undefined {
  const all = completions(state, itemId);
  return all[all.length - 1];
}

export function synthesizeBrief(
  state: WorkflowState,
  methodology: Methodology,
  item: WorkItem,
): Brief {
  if (!item.role)
    fail(
      "unknown-role",
      `item "${item.id}" has no role assigned`,
      "dispatch it with next() or set item.role",
      { items: [item.id] },
    );
  const role = roleOf(state, item.role);
  if (!role)
    fail(
      "unknown-role",
      `role "${item.role}" does not exist`,
      `registered roles: ${Object.keys(state.roles).join(", ")}`,
    );
  const upstream: Brief["upstream"] = [];
  const doNot = [...role.do_not];
  const sources = [
    ...item.dependsOn,
    ...(item.type === "bug" || item.type === "change-request" ? (item.affects ?? []) : []),
  ];
  for (const dep of sources) {
    const p = lastCompletion(state, dep);
    if (!p) continue;
    upstream.push({ item: dep, produced: p.produced, notes: p.notes });
    for (const d of p.do_not) if (!doNot.includes(d)) doNot.push(d);
  }
  const priorHandoffs: Brief["priorHandoffs"] = completions(state, item.id).map((p) => ({
    role: p.role,
    verdict: p.verdict,
    notes: p.notes,
    produced: p.produced,
    at: p.at,
  }));
  const touched = new Set([item.id, ...item.dependsOn]);
  const relatedBugs: Brief["relatedBugs"] = Object.values(state.items)
    .filter(
      (b) =>
        (b.type === "bug" || b.type === "change-request") &&
        b.id !== item.id &&
        b.status !== "done" &&
        b.status !== "dropped" &&
        (b.affects ?? []).some((a) => touched.has(a)),
    )
    .map((b) => ({ id: b.id, title: b.title, affects: b.affects ?? [] }));
  const it = openIteration(state);
  const gate = stageOf(state, item.stage).gate;
  const brief: Brief = {
    item,
    role,
    modelTier: role.modelTier,
    invariants: [...methodology.invariants(state, item), ...state.agreements],
    do_not: doNot,
    acceptance: item.acceptance,
    upstream,
    priorHandoffs,
    relatedBugs,
    budgetRemaining: it ? remaining(it.budget, it.spent) : {},
  };
  if (gate) brief.gateAhead = gate;
  if (item.type === "question" && item.parent) {
    const p = lastCompletion(state, item.parent);
    if (p) {
      brief.parent = {
        item: item.parent,
        role: p.role,
        notes: p.notes,
        produced: p.produced,
        open_questions: p.open_questions ?? [],
        do_not: p.do_not,
      };
      for (const d of p.do_not) if (!doNot.includes(d)) doNot.push(d);
    }
  }
  return brief;
}

/** Open questions of finished items: the last completion per item, verdict done/needs-review, with open_questions left unanswered. */
export function openQuestions(
  state: WorkflowState,
): Array<{ item: string; role: string; questions: string[]; at: string }> {
  const last = new Map<string, CompletedPayload & { at: string }>();
  for (const ev of state.events) {
    if (ev.type !== "item.completed") continue;
    const p = ev.payload as CompletedPayload;
    last.delete(p.id);
    last.set(p.id, { ...p, at: ev.at });
  }
  return [...last.values()]
    .filter(
      (p) =>
        (p.verdict === "done" || p.verdict === "needs-review") &&
        (p.open_questions ?? []).length > 0,
    )
    .map((p) => ({ item: p.id, role: p.role, questions: p.open_questions ?? [], at: p.at }));
}

export interface NextResult {
  state: WorkflowState;
  briefs: Brief[];
  skipped: Skipped[];
  reason?: PlanReason;
}

export function next(
  state: WorkflowState,
  methodology: Methodology,
  opts: PlanOptions = {},
): NextResult {
  const res = plan(state, methodology, opts);
  const briefs = res.dispatched.map((d) =>
    synthesizeBrief(res.state, methodology, res.state.items[d.id]!),
  );
  return res.reason
    ? { state: res.state, briefs, skipped: res.skipped, reason: res.reason }
    : { state: res.state, briefs, skipped: res.skipped };
}
