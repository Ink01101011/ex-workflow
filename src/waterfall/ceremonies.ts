import { ZERO_SPENT } from "../budget.ts";
import { fail } from "../errors.ts";
import { raisePending } from "../gates.ts";
import { applyAction } from "../methodology.ts";
import { getItem } from "../items.ts";
import { approverIds, canDo, requireCap, rolesWith } from "../roles.ts";
import { appendEvent, nowOf } from "../state.ts";
import type {
  Capability,
  Ceremony,
  CeremonyInput,
  Methodology,
  PendingHuman,
  Phase,
  WorkflowState,
} from "../types.ts";
import { baselinePhase } from "./baseline.ts";
import { approveChange, rejectChange } from "./change.ts";
import { configOf } from "./config.ts";
import { getPhase, itemsInPhase, lastToPhase, phasesOf, withPhases } from "./phases.ts";
import { phaseRetrospective } from "./retro.ts";
import { traceabilityMatrix } from "./traceability.ts";

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/** input.phase as an existing phase. */
export function wantPhase(state: WorkflowState, input: CeremonyInput, ceremony: string): Phase {
  const id = input["phase"];
  if (typeof id !== "string" || id.trim() === "")
    fail(
      "invalid-input",
      `${ceremony} needs phase: string`,
      `pass one of: ${phasesOf(state)
        .map((p) => p.id)
        .join(", ")}`,
    );
  return getPhase(state, id);
}

/** Append a deliverable to the phase and record it. */
function recordDeliverable(
  state: WorkflowState,
  phaseId: string,
  kind: string,
  ref: string,
  by: string,
  now: string,
): WorkflowState {
  const s = withPhases(
    state,
    phasesOf(state).map((p) =>
      p.id === phaseId
        ? { ...p, produced: [...(p.produced ?? []), { kind, ref, by, at: now }] }
        : p,
    ),
  );
  return appendEvent(s, "phase.deliverable", by, { phase: phaseId, kind, ref }, now);
}

export { approveChange, rejectChange } from "./change.ts";

export function waterfallCeremonies(methodology: () => Methodology): Record<string, Ceremony> {
  const act = (
    state: WorkflowState,
    type: string,
    input: CeremonyInput,
    reduce: (s: WorkflowState, now: string) => WorkflowState,
  ) =>
    applyAction(state, methodology(), { type, by: input.by, payload: input }, (s) =>
      reduce(s, nowOf(input.now)),
    );

  const kickoff: Ceremony = (state, input) => {
    requireCap(state, input.by, "facilitate");
    const phase = wantPhase(state, input, "kickoff");
    return act(state, "ceremony.kickoff", input, (s, now) => {
      const version =
        s.events.filter(
          (e) => e.type === "phase.opened" && (e.payload as { phase: string }).phase === phase.id,
        ).length + 1;
      const items = itemsInPhase(s, phase.id)
        .filter((i) => i.status !== "done")
        .map((i) => i.id);
      s = withPhases(
        s,
        phasesOf(s).map((p) => (p.id === phase.id ? { ...p, status: "open" as const } : p)),
      );
      const budget = phase.budget ?? {};
      s = {
        ...s,
        iterations: [
          ...s.iterations,
          {
            id: `${phase.id}#${version}`,
            goal: phase.name,
            budget,
            spent: ZERO_SPENT,
            startedAt: now,
            committed: items,
            carryover: [],
          },
        ],
      };
      return appendEvent(
        s,
        "phase.opened",
        input.by,
        { phase: phase.id, version, items, budget },
        now,
      );
    });
  };

  const gateReview: Ceremony = (state, input) => {
    const phase = wantPhase(state, input, "gateReview");
    if (phase.status !== "open")
      fail(
        "invalid-transition",
        `phase "${phase.id}" is ${phase.status}, not open`,
        phase.status === "baselined"
          ? "it is already baselined; a change-request reopens it"
          : `kickoff "${phase.id}" first`,
      );
    const gate = phase.gate;
    const approvers = approverIds(state, gate.id, "approve-gate");
    if (input.by !== "human" && !approvers.includes(input.by))
      fail(
        "gate-unmet",
        `"${input.by}" may not review gate "${gate.id}"`,
        `review as one of: human${approvers.map((r) => `, ${r}`).join("")}`,
        { rule: "gate" },
      );
    const already = state.pending.find(
      (p) => p.kind === "gate" && p.item === undefined && p.gate === gate.id,
    );
    if (already)
      fail(
        "no-op",
        `gate "${gate.id}" is already awaiting a decision (${already.id})`,
        `decide ${already.id} approve|reject`,
      );
    const given = input["deliverables"] ?? [];
    if (
      !Array.isArray(given) ||
      !given.every(
        (d) =>
          isObj(d) &&
          typeof d["kind"] === "string" &&
          d["kind"].trim() !== "" &&
          typeof d["ref"] === "string",
      )
    )
      fail(
        "invalid-input",
        "gateReview.deliverables must be [{ kind, ref }]",
        'e.g. { "deliverables": [{ "kind": "srs", "ref": "docs/srs.md" }] }',
      );
    const deliverables = given as Array<{ kind: string; ref: string }>;
    return act(state, "ceremony.gateReview", input, (s, now) => {
      for (const d of deliverables)
        s = recordDeliverable(s, phase.id, d.kind, d.ref, input.by, now);
      if (configOf(s).traceability.to.includes(phase.id)) {
        const m = traceabilityMatrix(s);
        s = appendEvent(
          s,
          "traceability.computed",
          input.by,
          {
            phase: phase.id,
            from: m.from,
            to: m.to,
            coverage: m.coverage,
            missing: m.missing,
            rows: m.rows,
          },
          now,
        );
        if (phase.id === lastToPhase(s) && m.missing.length === 0)
          s = recordDeliverable(
            s,
            phase.id,
            "traceability-matrix",
            `traceability.computed#${s.events[s.events.length - 1]!.seq}`,
            input.by,
            now,
          );
      }
      if (gate.requires.includes("human") && input.by !== "human") {
        s = raisePending(
          s,
          {
            kind: "gate",
            gate: gate.id,
            question: `Approve gate "${gate.id}" and baseline phase "${phase.name}"?`,
          },
          now,
        );
        const pending = s.pending[s.pending.length - 1]!.id;
        return appendEvent(
          s,
          "phase.gate-pending",
          input.by,
          { phase: phase.id, gate: gate.id, by: input.by, pending },
          now,
        );
      }
      return baselinePhase(s, phase.id, [input.by], now);
    });
  };

  const changeControlBoard: Ceremony = (state, input) => {
    requireCap(state, input.by, "control-change");
    const id = input["change"];
    if (typeof id !== "string" || id.trim() === "")
      fail(
        "invalid-input",
        "changeControlBoard needs change: string (a change-request id)",
        'e.g. { "change": "CR-1", "decision": "approve", "note": "why" }',
      );
    const cr = getItem(state, id);
    if (cr.type !== "change-request")
      fail(
        "invalid-input",
        `item "${id}" is a ${cr.type}, not a change-request`,
        "only change-request items go through the board",
        { items: [id] },
      );
    if (cr.status === "done" || cr.status === "dropped")
      fail(
        "invalid-transition",
        `change "${id}" is already ${cr.status === "done" ? "approved" : "rejected"}`,
        "raise a new change-request",
        { items: [id] },
      );
    if (cr.status === "awaiting_human") {
      const p = state.pending.find((x) => x.item === id);
      fail(
        "no-op",
        `change "${id}" is awaiting the human decision${p ? ` (${p.id})` : ""}`,
        `decide ${p?.id ?? "<pending id>"} approve|reject`,
        { items: [id] },
      );
    }
    const decision = input["decision"];
    if (decision !== "approve" && decision !== "reject")
      fail(
        "invalid-input",
        'changeControlBoard.decision must be "approve" or "reject"',
        "state the board's decision",
      );
    const note = typeof input["note"] === "string" ? input["note"] : "";
    const approvers = configOf(state).changeControl.approvers;
    for (const q of approvers) {
      if (
        q === "human" ||
        input.by === "human" ||
        canDo(state, input.by, q.capability as Capability)
      )
        continue;
      fail(
        "gate-unmet",
        `"${input.by}" lacks capability "${q.capability}" required by change control`,
        `decide as one of: human${rolesWith(state, q.capability as Capability)
          .map((r) => `, ${r.id}`)
          .join("")}`,
        { rule: "change-control", items: [id] },
      );
    }
    const needsHuman = approvers.includes("human") && input.by !== "human";
    return act(state, "ceremony.changeControlBoard", input, (s, now) => {
      if (needsHuman) {
        s = raisePending(
          s,
          {
            kind: "decision",
            item: id,
            question: `Change "${id}" (${cr.title}): the board (${input.by}) recommends ${decision}${note ? `: ${note}` : ""}. Approve or reject the change?`,
          },
          now,
        );
        const pending = s.pending[s.pending.length - 1]!.id;
        return appendEvent(
          s,
          "change.recommended",
          input.by,
          { change: id, decision, note, pending },
          now,
        );
      }
      return decision === "approve"
        ? approveChange(s, id, input.by, note, now)
        : rejectChange(s, id, input.by, note, now);
    });
  };

  return {
    kickoff,
    gateReview,
    changeControlBoard,
    phaseRetrospective: phaseRetrospective(methodology),
  };
}

/** decide() hook: a phase gate's human decision baselines the phase or records the failure. */
export function waterfallAfterDecide(
  state: WorkflowState,
  entry: PendingHuman,
  decision: "approve" | "reject",
  by: string,
  note: string,
  now: string,
): WorkflowState {
  if (entry.kind === "gate" && entry.item === undefined && entry.gate !== undefined) {
    const phase = phasesOf(state).find((p) => p.gate.id === entry.gate);
    if (!phase) return state;
    // core decide() checks the decider only for item gates; a phase gate pending exists because the gate requires a human
    if (by !== "human")
      fail(
        "gate-unmet",
        `"${by}" may not decide phase gate "${entry.gate}" (${entry.id}); it awaits a human`,
        `decide ${entry.id} as human`,
        { rule: "gate" },
      );
    let reviewer: string | undefined;
    for (let i = state.events.length - 1; i >= 0; i--) {
      const e = state.events[i]!;
      if (
        e.type === "phase.gate-pending" &&
        (e.payload as { pending: string }).pending === entry.id
      ) {
        reviewer = e.by;
        break;
      }
    }
    const approvedBy = reviewer !== undefined && reviewer !== by ? [reviewer, by] : [by];
    if (decision === "approve") return baselinePhase(state, phase.id, approvedBy, now);
    return appendEvent(
      state,
      "phase.gate-failed",
      by,
      { phase: phase.id, gate: entry.gate, note },
      now,
    );
  }
  if (
    entry.kind === "decision" &&
    entry.item !== undefined &&
    Object.hasOwn(state.items, entry.item)
  ) {
    const item = state.items[entry.item]!;
    if (item.type !== "change-request") return state;
    if (by !== "human")
      fail(
        "gate-unmet",
        `"${by}" may not decide change "${item.id}" (${entry.id}); change control awaits a human`,
        `decide ${entry.id} as human`,
        { rule: "change-control", items: [item.id] },
      );
    return decision === "approve"
      ? approveChange(state, item.id, by, note, now)
      : rejectChange(state, item.id, by, note, now);
  }
  return state;
}
