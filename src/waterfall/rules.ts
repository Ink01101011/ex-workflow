import { authorOf } from "../gates.ts";
import { approverIds, rolesWith } from "../roles.ts";
import type { Action, NewItem, Phase, Rule, Violation, WorkflowState } from "../types.ts";
import { configOf } from "./config.ts";
import {
  itemsInPhase,
  lastToPhase,
  missingDeliverables,
  openPhase,
  phaseOf,
  phasesOf,
} from "./phases.ts";
import { missingTraces } from "./traceability.ts";

const v = (rule: string, message: string, fix: string, item?: string): Violation =>
  item
    ? { rule, severity: "error", item, message, fix }
    : { rule, severity: "error", message, fix };
const payloadOf = (a: Action): Record<string, unknown> =>
  (a.payload ?? {}) as Record<string, unknown>;
const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const phaseArg = (a: Action): string | undefined => {
  const p = payloadOf(a)["phase"];
  return typeof p === "string" ? p : undefined;
};
const phaseById = (s: WorkflowState, id: string): Phase | undefined =>
  phasesOf(s).find((p) => p.id === id);
const phaseIds = (s: WorkflowState) =>
  phasesOf(s)
    .map((p) => p.id)
    .join(", ");
const itemById = (s: WorkflowState, id: unknown) =>
  typeof id === "string" && Object.hasOwn(s.items, id) ? s.items[id] : undefined;

/** Phase a NewItem would land in: its own, else its parent's. */
function phaseOfNew(s: WorkflowState, item: NewItem): string | undefined {
  if (item.phase !== undefined) return item.phase;
  const parent = itemById(s, item.parent);
  return parent ? phaseOf(s, parent) : undefined;
}
const governed = (item: NewItem) => item.type !== "change-request" && item.type !== "question";

const frozenFix = (item: string, phase: string) =>
  `raise a change-request: addItem({ type: "change-request", affects: ["${item}"], impactAnalysis: { summary, reopen: ["${phase}"], weight } }) and decide it in changeControlBoard`;

function changeOf(s: WorkflowState, a: Action) {
  const item = itemById(s, payloadOf(a)["change"]);
  return item && item.type === "change-request" ? item : undefined;
}

/** Shape check shared by add/edit and the change control board. */
function impactShape(s: WorkflowState, id: string, ia: unknown): Violation[] {
  const rule = "change-needs-impact-analysis";
  const fix = `editItem("${id}", { impactAnalysis: { summary: "what changes and why", reopen: ["<phase>"], weight: <points> } })`;
  if (ia === undefined) {
    return configOf(s).changeControl.requiresImpactAnalysis
      ? [v(rule, `change "${id}" has no impact analysis`, fix, id)]
      : [];
  }
  const out: Violation[] = [];
  const o = isObj(ia) ? ia : {};
  if (typeof o["summary"] !== "string" || o["summary"].trim() === "")
    out.push(v(rule, `change "${id}" impactAnalysis.summary is empty`, fix, id));
  if (!Array.isArray(o["reopen"]) || !o["reopen"].every((x) => typeof x === "string"))
    out.push(
      v(rule, `change "${id}" impactAnalysis.reopen must be a string[] of phase ids`, fix, id),
    );
  if (typeof o["weight"] !== "number" || !Number.isFinite(o["weight"]) || o["weight"] < 0)
    out.push(
      v(rule, `change "${id}" impactAnalysis.weight must be a non-negative number`, fix, id),
    );
  return out;
}

export function waterfallRules(): Rule[] {
  const sequential: Rule = {
    id: "phase-sequential",
    severity: "error",
    check(s, a) {
      const out: Violation[] = [];
      if (a.type === "ceremony.kickoff") {
        const id = phaseArg(a);
        const p = id === undefined ? undefined : phaseById(s, id);
        if (!p) return [];
        if (p.status === "open")
          out.push(
            v(
              "phase-sequential",
              `phase "${p.id}" is already open`,
              `gateReview "${p.id}" when its work is done`,
            ),
          );
        if (p.status === "baselined")
          out.push(
            v(
              "phase-sequential",
              `phase "${p.id}" is baselined`,
              "only an approved change-request reopens a baselined phase",
            ),
          );
        const open = openPhase(s);
        if (open && open.id !== p.id)
          out.push(
            v(
              "phase-sequential",
              `phase "${open.id}" is still open`,
              `pass its gate (gateReview "${open.id}") before opening "${p.id}"`,
            ),
          );
      } else if (a.type === "item.add") {
        const item = payloadOf(a)["item"] as NewItem | undefined;
        if (!isObj(item) || !governed(item)) return [];
        const phase = phaseOfNew(s, item);
        if (phase === undefined)
          out.push(
            v(
              "phase-sequential",
              `item "${item.id}" belongs to no phase`,
              `set phase to one of: ${phaseIds(s)}`,
              item.id,
            ),
          );
        else if (!phaseById(s, phase))
          out.push(
            v(
              "phase-sequential",
              `item "${item.id}" names unknown phase "${phase}"`,
              `phases are: ${phaseIds(s)}`,
              item.id,
            ),
          );
      } else if (a.type === "item.edit") {
        const id = payloadOf(a)["id"];
        const patch = payloadOf(a)["patch"];
        const item = itemById(s, id);
        if (!item || !isObj(patch) || patch["phase"] === undefined || patch["phase"] === item.phase)
          return [];
        out.push(
          v(
            "phase-sequential",
            `item "${item.id}" cannot move from phase "${item.phase ?? "(none)"}" to "${String(patch["phase"])}"`,
            `drop "${item.id}" and add a new item in phase "${String(patch["phase"])}"`,
            item.id,
          ),
        );
      }
      return out;
    },
  };

  const gateBefore: Rule = {
    id: "gate-before-next-phase",
    severity: "error",
    check(s, a) {
      if (a.type !== "ceremony.kickoff") return [];
      const id = phaseArg(a);
      const phases = phasesOf(s);
      const idx = id === undefined ? -1 : phases.findIndex((p) => p.id === id);
      if (idx < 0) return [];
      const earlier = phases
        .slice(0, idx)
        .filter((p) => p.status !== "baselined")
        .map((p) => p.id);
      if (earlier.length === 0) return [];
      return [
        v(
          "gate-before-next-phase",
          `phase(s) ${earlier.join(", ")} before "${id}" are not baselined`,
          `kickoff and gateReview them in order, starting with "${earlier[0]}"`,
        ),
      ];
    },
  };

  const immutable: Rule = {
    id: "baseline-immutable",
    severity: "error",
    check(s, a) {
      const version = (phase: string) =>
        (s.baselines ?? []).filter((b) => b.phase === phase).length || 1;
      if (a.type === "item.edit") {
        const item = itemById(s, payloadOf(a)["id"]);
        if (!item) return [];
        const phase = phaseOf(s, item);
        if (phase === undefined || phaseById(s, phase)?.status !== "baselined") return [];
        return [
          v(
            "baseline-immutable",
            `item "${item.id}" is frozen: phase "${phase}" is baselined (v${version(phase)})`,
            frozenFix(item.id, phase),
            item.id,
          ),
        ];
      }
      if (a.type === "item.add") {
        const item = payloadOf(a)["item"] as NewItem | undefined;
        if (!isObj(item) || !governed(item)) return [];
        const phase = phaseOfNew(s, item);
        if (phase === undefined || phaseById(s, phase)?.status !== "baselined") return [];
        return [
          v(
            "baseline-immutable",
            `cannot add "${item.id}" to baselined phase "${phase}" (v${version(phase)})`,
            frozenFix(item.id, phase),
            item.id,
          ),
        ];
      }
      return [];
    },
  };

  const impact: Rule = {
    id: "change-needs-impact-analysis",
    severity: "error",
    check(s, a) {
      if (a.type === "item.add") {
        const item = payloadOf(a)["item"] as NewItem | undefined;
        if (!isObj(item) || item.type !== "change-request") return [];
        return impactShape(s, String(item.id), item.impactAnalysis);
      }
      if (a.type === "item.edit") {
        const patch = payloadOf(a)["patch"];
        const cr = itemById(s, payloadOf(a)["id"]);
        if (!cr || cr.type !== "change-request" || !isObj(patch) || !("impactAnalysis" in patch))
          return [];
        return impactShape(s, cr.id, patch["impactAnalysis"]);
      }
      if (a.type !== "ceremony.changeControlBoard") return [];
      const cr = changeOf(s, a);
      if (!cr) return [];
      const out = impactShape(s, cr.id, cr.impactAnalysis);
      if (out.length || cr.impactAnalysis === undefined) return out;
      const approve = payloadOf(a)["decision"] === "approve";
      for (const id of cr.impactAnalysis.reopen) {
        const p = phaseById(s, id);
        if (!p)
          out.push(
            v(
              "change-needs-impact-analysis",
              `change "${cr.id}" impactAnalysis.reopen names unknown phase "${id}"`,
              `phases are: ${phaseIds(s)}`,
              cr.id,
            ),
          );
        else if (approve && p.status === "pending")
          out.push(
            v(
              "change-needs-impact-analysis",
              `phase "${id}" was never baselined; it cannot be reopened`,
              `remove "${id}" from impactAnalysis.reopen`,
              cr.id,
            ),
          );
      }
      return out;
    },
  };

  const traceIds: Rule = {
    id: "trace-ids-valid",
    severity: "error",
    check(s, a) {
      let id: string;
      let traces: unknown;
      let ia: unknown;
      let isCr: boolean;
      if (a.type === "item.add") {
        const item = payloadOf(a)["item"] as NewItem | undefined;
        if (!isObj(item)) return [];
        id = String(item.id);
        traces = item.traces;
        ia = item.impactAnalysis;
        isCr = item.type === "change-request";
      } else if (a.type === "item.edit") {
        const cur = itemById(s, payloadOf(a)["id"]);
        const patch = payloadOf(a)["patch"];
        if (!cur || !isObj(patch)) return [];
        id = cur.id;
        traces = patch["traces"];
        ia = patch["impactAnalysis"];
        isCr = cur.type === "change-request";
      } else return [];
      const out: Violation[] = [];
      if (Array.isArray(traces)) {
        const cfg = configOf(s).traceability;
        const ok = [cfg.from, ...cfg.to].flatMap((p) =>
          itemsInPhase(s, p)
            .filter((i) => i.type !== "question" && i.type !== "change-request")
            .map((i) => i.id),
        );
        const fix = `traceable items: ${ok.length ? ok.join(", ") : "(none yet)"}`;
        for (const t of traces) {
          if (typeof t !== "string") continue;
          const target = itemById(s, t);
          if (!target || target.status === "dropped")
            out.push(v("trace-ids-valid", `item "${id}" traces unknown item "${t}"`, fix, id));
        }
      }
      if (isCr && isObj(ia) && Array.isArray(ia["reopen"])) {
        for (const r of ia["reopen"]) {
          if (typeof r === "string" && !phaseById(s, r))
            out.push(
              v(
                "trace-ids-valid",
                `change "${id}" impactAnalysis.reopen names unknown phase "${r}"`,
                `phases are: ${phaseIds(s)}`,
                id,
              ),
            );
        }
      }
      return out;
    },
  };

  const traced: Rule = {
    id: "requirement-traced",
    severity: "error",
    check(s, a) {
      if (a.type !== "ceremony.gateReview") return [];
      const id = phaseArg(a);
      const cfg = configOf(s).traceability;
      if (id === undefined || !cfg.to.includes(id) || !phaseById(s, id)) return [];
      return missingTraces(s, id).map((item) =>
        v(
          "requirement-traced",
          `item "${item}" of phase "${cfg.from}" has no trace into "${id}"`,
          `editItem a "${id}" item with traces: ["${item}"] (or editItem("${item}", { traces: [...] }) while "${cfg.from}" is not baselined)`,
          item,
        ),
      );
    },
  };

  const deliverables: Rule = {
    id: "deliverables-present",
    severity: "error",
    check(s, a) {
      if (a.type !== "ceremony.gateReview") return [];
      const id = phaseArg(a);
      const p = id === undefined ? undefined : phaseById(s, id);
      if (!p) return [];
      const out: Violation[] = [];
      const open = itemsInPhase(s, p.id)
        .filter((i) => i.status !== "done")
        .map((i) => i.id);
      if (open.length)
        out.push(
          v(
            "deliverables-present",
            `${open.length} item(s) in phase "${p.id}" are not done: ${open.join(", ")}`,
            "finish them (next/complete) or drop them before the gate",
          ),
        );
      const given = payloadOf(a)["deliverables"];
      const extra = Array.isArray(given)
        ? given
            .filter((d) => isObj(d) && typeof d["kind"] === "string")
            .map((d) => (d as { kind: string }).kind)
        : [];
      if (p.id === lastToPhase(s)) extra.push("traceability-matrix");
      for (const kind of missingDeliverables(s, p, extra))
        out.push(
          v(
            "deliverables-present",
            `phase "${p.id}" has no deliverable "${kind}"`,
            `pass deliverables: [{ "kind": "${kind}", "ref": "<where it lives>" }] to gateReview, or attach evidence of kind "${kind}" on an item of the phase`,
          ),
        );
      return out;
    },
  };

  const notAuthor: Rule = {
    id: "approver-not-author",
    severity: "error",
    check(s, a) {
      if (a.by === "human") return [];
      if (a.type === "ceremony.gateReview") {
        const id = phaseArg(a);
        const p = id === undefined ? undefined : phaseById(s, id);
        if (!p) return [];
        const mine = itemsInPhase(s, p.id)
          .filter((i) => authorOf(s, i) === a.by)
          .map((i) => i.id);
        if (mine.length === 0) return [];
        const others = approverIds(s, p.gate.id, "approve-gate", a.by);
        return [
          v(
            "approver-not-author",
            `"${a.by}" authored ${mine.join(", ")} in phase "${p.id}" and may not approve its gate`,
            `review the gate as one of: human${others.map((r) => `, ${r}`).join("")}`,
          ),
        ];
      }
      if (a.type === "ceremony.changeControlBoard") {
        const cr = changeOf(s, a);
        if (!cr) return [];
        const added = s.events.find(
          (e) => e.type === "item.added" && (e.payload as { id: string }).id === cr.id,
        );
        if (!added || added.by !== a.by) return [];
        const others = rolesWith(s, "control-change")
          .map((r) => r.id)
          .filter((r) => r !== a.by);
        return [
          v(
            "approver-not-author",
            `"${a.by}" raised change "${cr.id}" and may not decide it`,
            `decide as human${others.map((r) => `, ${r}`).join("")}`,
            cr.id,
          ),
        ];
      }
      return [];
    },
  };

  return [sequential, gateBefore, immutable, impact, traced, deliverables, notAuthor, traceIds];
}
