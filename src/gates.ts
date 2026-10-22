import { fail } from "./errors.ts";
import { advanceItem, clearRole, getItem, moveItem, raiseBlocker } from "./items.ts";
import { approverIds } from "./roles.ts";
import { appendEvent, nowOf } from "./state.ts";
import type {
  Gate,
  Methodology,
  PendingHuman,
  Transition,
  Violation,
  WorkItem,
  WorkflowState,
} from "./types.ts";

export type GateResult =
  | { outcome: "pass" }
  | { outcome: "human" }
  | { outcome: "fail"; violations: Violation[] };

/** Last in_progress dispatch made from a stage that comes STRICTLY BEFORE the item's current stage in `state.stages` order (unknown stage ids count as not-before). */
export function lastDispatchBefore(state: WorkflowState, item: WorkItem): Transition | undefined {
  const order = new Map(state.stages.map((s, i) => [s.id, i] as const));
  const here = order.get(item.stage);
  if (here === undefined) return undefined;
  for (let i = item.transitions.length - 1; i >= 0; i--) {
    const t = item.transitions[i]!;
    const from = order.get(t.from.stage);
    if (t.to.status === "in_progress" && from !== undefined && from < here) return t;
  }
  return undefined;
}

/** Role that did the work the gate guards: the last dispatch made from a stage strictly before the current one (so a reviewer dispatched into the gated stage is not its author); else the last dispatch of any stage; undefined if never dispatched. */
export function authorOf(state: WorkflowState, item: WorkItem): string | undefined {
  const before = lastDispatchBefore(state, item);
  if (before) return before.by;
  for (let i = item.transitions.length - 1; i >= 0; i--) {
    const t = item.transitions[i]!;
    if (t.to.status === "in_progress") return t.by;
  }
  return undefined;
}

export function checkGate(
  state: WorkflowState,
  item: WorkItem,
  gate: Gate,
  by: string,
): GateResult {
  const violations: Violation[] = [];
  for (const kind of gate.evidence) {
    if (!item.evidence.some((e) => e.kind === kind)) {
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
    const author = authorOf(state, item);
    if (author !== undefined && author === by) {
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

export function raisePending(
  state: WorkflowState,
  pending: Omit<PendingHuman, "id" | "raisedAt">,
  now?: string,
): WorkflowState {
  const at = nowOf(now);
  const id = `p${state.events.filter((e) => e.type === "pending.raised").length + 1}`;
  const entry: PendingHuman = { ...pending, id, raisedAt: at };
  let next: WorkflowState = { ...state, pending: [...state.pending, entry] };
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

export function decide(
  state: WorkflowState,
  pendingId: string,
  decision: "approve" | "reject",
  by: string,
  note: string,
  now?: string,
  methodology?: Methodology,
): WorkflowState {
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
  const gate =
    item0 &&
    (state.stages.find((s) => entry.gate !== undefined && s.gate?.id === entry.gate)?.gate ??
      state.stages.find((s) => s.id === item0.stage)?.gate);
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
  let next: WorkflowState = { ...state, pending: state.pending.filter((p) => p.id !== pendingId) };
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
      next = advanceItem(next, id, by, false, at);
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
