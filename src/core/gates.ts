import { fail } from "./errors.ts";
import { resolvedGate } from "./gate-escalation.ts";
import { advanceItem, clearRole, moveItem } from "./items/move.ts";
import { freshEvidence } from "./items/evidence.ts";
import { getItem } from "./items/record.ts";
import { raiseBlocker } from "./items/blockers.ts";
import { authorsOf } from "./authors.ts";
import { approverIds } from "./roles/lookup.ts";
import { appendEvent, nowOf } from "./state.ts";
import type {
  Gate,
  Methodology,
  PendingHuman,
  Violation,
  WorkItem,
  WorkflowState,
} from "./types.ts";

export type GateResult =
  | { outcome: "pass" }
  | { outcome: "human" }
  | { outcome: "fail"; violations: Violation[] };

export function checkGate(
  state: WorkflowState<string>,
  item: WorkItem,
  gate: Gate,
  by: string,
): GateResult;
export function checkGate(state: WorkflowState, item: WorkItem, gate: Gate, by: string): GateResult;
export function checkGate(
  state: WorkflowState<string>,
  item: WorkItem,
  gate: Gate,
  by: string,
): GateResult {
  const violations: Violation[] = [];
  const fresh = freshEvidence(state, item);
  for (const kind of gate.evidence) {
    if (!fresh.some((e) => e.kind === kind)) {
      violations.push({
        rule: "gate:evidence",
        severity: "error",
        item: item.id,
        message: `gate "${gate.id}" needs evidence "${kind}" on item "${item.id}"`,
        fix: `attach evidence { kind: "${kind}" } before approving`,
      });
    }
  }
  if (violations.length) return { outcome: "fail", violations };

  let needsHuman = false;
  let authors: string[] | undefined;
  for (const req of gate.requires) {
    if (req === "human") {
      if (by !== "human") needsHuman = true;
      continue;
    }
    const ok = approverIds(state, gate.id, req.capability).includes(by);
    if (!ok) {
      violations.push({
        rule: "gate:capability",
        severity: "error",
        item: item.id,
        message: `"${by}" may not approve gate "${gate.id}" (needs capability "${req.capability}" and canApprove "${gate.id}")`,
        fix: `approve as one of: ${approverIds(state, gate.id, req.capability).join(", ") || "(no role qualifies; register one)"}`,
      });
      continue;
    }
    if ((authors ??= authorsOf(state, item)).includes(by)) {
      const others = approverIds(state, gate.id, req.capability, by);
      violations.push({
        rule: "conflict-of-interest",
        severity: "error",
        item: item.id,
        message: `role "${by}" did the work on "${item.id}" and may not approve it`,
        fix: `approve as a different role: ${others.join(", ") || "(register another approver)"}`,
      });
    }
  }
  if (violations.length) return { outcome: "fail", violations };
  return needsHuman ? { outcome: "human" } : { outcome: "pass" };
}

export function raisePending<N extends string>(
  state: WorkflowState<N>,
  pending: Omit<PendingHuman, "id" | "raisedAt">,
  now?: string,
): WorkflowState<N>;
export function raisePending(
  state: WorkflowState,
  pending: Omit<PendingHuman, "id" | "raisedAt">,
  now?: string,
): WorkflowState;
export function raisePending<N extends string>(
  state: WorkflowState<N>,
  pending: Omit<PendingHuman, "id" | "raisedAt">,
  now?: string,
): WorkflowState<N> {
  const at = nowOf(now);
  const id = `p${state.events.filter((e) => e.type === "pending.raised").length + 1}`;
  const entry: PendingHuman = { ...pending, id, raisedAt: at };
  let next: WorkflowState<N> = { ...state, pending: [...state.pending, entry] };
  if (pending.item) {
    const item = getItem(next, pending.item);
    if (item.status !== "awaiting_human")
      next = moveItem(next, pending.item, { status: "awaiting_human" }, "system", at);
  }
  return appendEvent(
    next,
    "pending.raised",
    "system",
    { id, kind: pending.kind, item: pending.item ?? null, gate: pending.gate ?? null },
    at,
  );
}

export function decide<N extends string>(
  state: WorkflowState<N>,
  pendingId: string,
  decision: "approve" | "reject",
  by: string,
  note: string,
  now?: string,
  methodology?: Methodology<unknown, N>,
): WorkflowState<N>;
export function decide(
  state: WorkflowState,
  pendingId: string,
  decision: "approve" | "reject",
  by: string,
  note: string,
  now?: string,
  methodology?: Methodology,
): WorkflowState;
export function decide<N extends string>(
  state: WorkflowState<N>,
  pendingId: string,
  decision: "approve" | "reject",
  by: string,
  note: string,
  now?: string,
  methodology?: Methodology<unknown, N>,
): WorkflowState<N> {
  if (decision !== "approve" && decision !== "reject")
    fail(
      "invalid-input",
      `decision must be "approve" or "reject" (got ${JSON.stringify(decision)})`,
      "pass approve or reject",
    );
  const entry = state.pending.find((p) => p.id === pendingId);
  if (!entry)
    fail(
      "unknown-pending",
      `no pending decision "${pendingId}"`,
      `open decisions: ${state.pending.map((p) => p.id).join(", ") || "(none)"}`,
    );
  const item0 = entry.kind === "gate" && entry.item ? getItem(state, entry.item) : undefined;
  const gate0 =
    item0 &&
    (state.stages.find((s) => entry.gate !== undefined && s.gate?.id === entry.gate)?.gate ??
      state.stages.find((s) => s.id === item0.stage)?.gate);
  // one backward scan: the item's last item.completed (does it want review?) and the pending's own
  // pending.raised, whose gate.resolved is the escalation complete() recorded (spec 27, #35, G3-1)
  let wantsReview = false;
  let done = false;
  let raised = -1;
  if (item0)
    for (let i = state.events.length - 1; i >= 0 && (!done || raised < 0); i--) {
      const e = state.events[i]!;
      const p = e.payload as { id?: string; verdict?: string } | null;
      if (!done && e.type === "item.completed" && p?.id === item0.id) {
        done = true;
        wantsReview = p.verdict === "needs-review";
      } else if (raised < 0 && e.type === "pending.raised" && p?.id === pendingId) raised = i;
    }
  const gate = gate0 && resolvedGate(state, item0.id, gate0, raised);
  if (item0 && gate && by !== "human") {
    const res = gate.requires.includes("human") ? undefined : checkGate(state, item0, gate, by);
    if (res?.outcome !== "pass")
      fail(
        "gate-unmet",
        `"${by}" may not decide gate "${gate.id}" on "${item0.id}"`,
        `decide as one of: human${gate.requires
          .flatMap((q) => (q === "human" ? [] : approverIds(state, gate.id, q.capability)))
          .map((r) => `, ${r}`)
          .join("")}`,
        { items: [item0.id], rule: "gate" },
      );
  }
  const at = nowOf(now);
  let next: WorkflowState<N> = {
    ...state,
    pending: state.pending.filter((p) => p.id !== pendingId),
  };
  next = appendEvent(
    next,
    "pending.decided",
    by,
    { id: pendingId, decision, note, item: entry.item ?? null, gate: entry.gate ?? null },
    at,
  );
  if (item0) {
    const id = item0.id;
    const gateId = entry.gate ?? gate?.id ?? null;
    if (decision === "approve") {
      next = advanceItem(next, id, by, wantsReview, at);
      next = appendEvent(next, "gate.passed", by, { item: id, gate: gateId }, at);
    } else {
      const onFail = gate?.onFail ?? { action: "block" as const };
      if (onFail.action === "return-to")
        next = clearRole(moveItem(next, id, { stage: onFail.stage, status: "todo" }, by, at), id);
      else
        next = raiseBlocker(
          next,
          id,
          `gate "${gateId ?? "?"}" rejected: ${note || "no reason given"}`,
          by,
          by,
          at,
        );
      next = appendEvent(next, "gate.failed", by, { item: id, gate: gateId, note }, at);
    }
  }
  if (methodology?.afterDecide) next = methodology.afterDecide(next, entry, decision, by, note, at);
  return next;
}
