import { fail } from "./errors.ts";
import { getItem, isTerminalStage, moveItem, nextStageOf, raiseBlocker } from "./items.ts";
import { appendEvent, nowOf } from "./state.ts";
import type { Gate, PendingHuman, Violation, WorkItem, WorkflowState } from "./types.ts";

export type GateResult =
  | { outcome: "pass" }
  | { outcome: "human" }
  | { outcome: "fail"; violations: Violation[] };

/** Role id that last moved the item into in_progress; undefined if never. */
export function authorOf(item: WorkItem): string | undefined {
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
    const role = state.roles[by];
    const ok =
      role !== undefined &&
      (role.capabilities as readonly string[]).includes(req.capability) &&
      role.canApprove.includes(gate.id);
    if (!ok) {
      const candidates = Object.values(state.roles)
        .filter(
          (r) =>
            (r.capabilities as readonly string[]).includes(req.capability) &&
            r.canApprove.includes(gate.id),
        )
        .map((r) => r.id);
      violations.push({
        rule: "gate:capability",
        severity: "error",
        item: item.id,
        message: `"${by}" may not approve gate "${gate.id}" (needs capability "${req.capability}" and canApprove "${gate.id}")`,
        fix: `approve as one of: ${candidates.join(", ") || "(no role qualifies; register one)"}`,
      });
      continue;
    }
    const author = authorOf(item);
    if (author !== undefined && author === by) {
      const others = Object.values(state.roles)
        .filter(
          (r) =>
            r.id !== by &&
            (r.capabilities as readonly string[]).includes(req.capability) &&
            r.canApprove.includes(gate.id),
        )
        .map((r) => r.id);
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
  const id = `p${state.pending.length + 1 + state.events.filter((e) => e.type === "pending.decided").length}`;
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
): WorkflowState {
  const entry = state.pending.find((p) => p.id === pendingId);
  if (!entry)
    fail(
      "unknown-pending",
      `no pending decision "${pendingId}"`,
      `open decisions: ${state.pending.map((p) => p.id).join(", ") || "(none)"}`,
    );
  const at = nowOf(now);
  let next: WorkflowState = { ...state, pending: state.pending.filter((p) => p.id !== pendingId) };
  next = appendEvent(
    next,
    "pending.decided",
    by,
    { id: pendingId, decision, note, item: entry.item ?? null, gate: entry.gate ?? null },
    at,
  );
  if (entry.kind === "gate" && entry.item) {
    const item = getItem(next, entry.item);
    const stage = next.stages.find((s) => s.id === item.stage);
    const gate = stage?.gate;
    if (decision === "approve") {
      const to = nextStageOf(next, item.stage);
      if (!to || isTerminalStage(next, to.id))
        next = moveItem(next, item.id, { stage: to?.id ?? item.stage, status: "done" }, by, at);
      else next = moveItem(next, item.id, { stage: to.id, status: "todo" }, by, at);
      next = appendEvent(
        next,
        "gate.passed",
        by,
        { item: item.id, gate: entry.gate ?? gate?.id ?? null },
        at,
      );
    } else {
      const onFail = gate?.onFail ?? { action: "block" as const };
      if (onFail.action === "return-to")
        next = moveItem(next, item.id, { stage: onFail.stage, status: "todo" }, by, at);
      else
        next = raiseBlocker(
          next,
          item.id,
          `gate "${entry.gate ?? gate?.id ?? "?"}" rejected: ${note || "no reason given"}`,
          by,
          by,
          at,
        );
      next = appendEvent(
        next,
        "gate.failed",
        by,
        { item: item.id, gate: entry.gate ?? gate?.id ?? null, note },
        at,
      );
    }
  }
  return next;
}
