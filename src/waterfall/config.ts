import { assertId, fail } from "../errors.ts";
import type { Budget, Gate, GateRequirement, WorkflowState } from "../types.ts";

export interface WaterfallPhaseConfig {
  id: string;
  name: string;
  deliverables: string[];
  gate: Gate;
  budget?: Budget;
  /** role id that delivers this phase's items; default: the first role with "deliver" */
  deliverBy?: string;
}
export interface WaterfallConfig {
  phases: WaterfallPhaseConfig[];
  changeControl: { requiresImpactAnalysis: boolean; approvers: GateRequirement[] };
  /** phase ids: every item of `from` must trace to an item of each `to` phase before that phase's gate */
  traceability: { from: string; to: string[] };
  humanGates: "all" | string[];
  /** tokens per weight unit when there is no accounting history (default 20000, as Scrum) */
  fallbackTokensPerWeight?: number;
}

export const DEFAULT_PHASE_IDS: readonly string[] = [
  "requirements",
  "design",
  "implementation",
  "verification",
  "deployment",
  "maintenance",
];
export const DEFAULT_DELIVERABLES: Record<string, string[]> = {
  requirements: ["srs"],
  design: ["design-doc", "interface-spec"],
  implementation: ["code-baseline"],
  verification: ["test-report", "traceability-matrix"],
  deployment: ["release-notes", "deployment-record"],
  maintenance: ["change-log"],
};
export const DEFAULT_DELIVER_BY: Record<string, string> = {
  requirements: "business-analyst",
  design: "architect",
  deployment: "release-manager",
};
export const GATE_ID = (id: string): string => `${id}-gate`;
export const CHANGE_GATE = "change-control";
export const CAPABILITIES: readonly string[] = [
  "order-backlog",
  "define-acceptance",
  "facilitate",
  "deliver",
  "review",
  "verify",
  "approve-gate",
  "manage-flow",
  "control-change",
  "escalate",
];

const title = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);

export function defaultPhases(): WaterfallPhaseConfig[] {
  return DEFAULT_PHASE_IDS.map((id) => {
    const p: WaterfallPhaseConfig = {
      id,
      name: title(id),
      deliverables: [...(DEFAULT_DELIVERABLES[id] ?? [])],
      gate: {
        id: GATE_ID(id),
        requires: [{ capability: "approve-gate" }],
        evidence: [],
        onFail: { action: "block" },
      },
    };
    const by = DEFAULT_DELIVER_BY[id];
    if (by !== undefined) p.deliverBy = by;
    return p;
  });
}

export function configOf(state: WorkflowState): WaterfallConfig {
  return state.config as WaterfallConfig;
}

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const strings = (x: unknown): x is string[] =>
  Array.isArray(x) && x.every((s) => typeof s === "string" && s.trim() !== "");

function budget(raw: unknown, where: string): Budget | undefined {
  if (raw === undefined) return undefined;
  if (!isObj(raw))
    fail("config-invalid", `${where}.budget must be an object`, 'e.g. { "tokens": 400000 }');
  const out: Budget = {};
  for (const k of ["tokens", "turns", "wallclockMs"] as const) {
    const v = raw[k];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
      fail(
        "config-invalid",
        `${where}.budget.${k} must be a non-negative number`,
        "omit it for no limit",
      );
    out[k] = v;
  }
  return out;
}

function requirements(raw: unknown, where: string): GateRequirement[] {
  if (!Array.isArray(raw) || raw.length === 0)
    fail(
      "config-invalid",
      `${where} must be a non-empty array of "human" | { capability }`,
      'e.g. ["human", { "capability": "approve-gate" }]',
    );
  return raw.map((q: unknown): GateRequirement => {
    if (q === "human") return "human";
    if (isObj(q) && typeof q["capability"] === "string" && CAPABILITIES.includes(q["capability"]))
      return { capability: q["capability"] };
    return fail(
      "config-invalid",
      `${where} entry ${JSON.stringify(q)} is not "human" or a known capability`,
      `use "human" or { "capability": one of ${CAPABILITIES.join(", ")} }`,
    );
  });
}

function phase(raw: unknown, i: number, human: (id: string) => boolean): WaterfallPhaseConfig {
  const where = `waterfall config.phases[${i}]`;
  if (!isObj(raw)) fail("config-invalid", `${where} must be an object`, 'e.g. { "id": "design" }');
  assertId(raw["id"], `${where}.id`);
  const id = raw["id"] as string;
  const deliverables = raw["deliverables"] ?? DEFAULT_DELIVERABLES[id] ?? [];
  if (!strings(deliverables))
    fail(
      "config-invalid",
      `${where}.deliverables must be a string[] of evidence kinds`,
      'e.g. ["srs"]',
    );
  let gate: Gate;
  if (raw["gate"] === undefined) {
    gate = {
      id: GATE_ID(id),
      requires: [{ capability: "approve-gate" }],
      evidence: [],
      onFail: { action: "block" },
    };
  } else {
    const g = raw["gate"];
    if (!isObj(g) || typeof g["id"] !== "string" || g["id"].trim() === "")
      fail(
        "config-invalid",
        `${where}.gate must be a Gate with an id`,
        'e.g. { "id": "design-gate", "requires": [{ "capability": "approve-gate" }], "evidence": [] }',
      );
    const evidence = g["evidence"] ?? [];
    if (!strings(evidence))
      fail(
        "config-invalid",
        `${where}.gate.evidence must be a string[]`,
        "list evidence kinds or omit it",
      );
    gate = {
      id: g["id"],
      requires: requirements(
        g["requires"] ?? [{ capability: "approve-gate" }],
        `${where}.gate.requires`,
      ),
      evidence: [...evidence],
      onFail: { action: "block" },
    };
  }
  if (human(id) && !gate.requires.includes("human")) gate.requires = ["human", ...gate.requires];
  const out: WaterfallPhaseConfig = {
    id,
    name: typeof raw["name"] === "string" && raw["name"].trim() !== "" ? raw["name"] : title(id),
    deliverables: [...deliverables],
    gate,
  };
  const b = budget(raw["budget"], where);
  if (b !== undefined) out.budget = b;
  const by = raw["deliverBy"] ?? DEFAULT_DELIVER_BY[id];
  if (by !== undefined) {
    if (typeof by !== "string" || by.trim() === "")
      fail(
        "config-invalid",
        `${where}.deliverBy must be a role id`,
        "name the role that delivers this phase or omit it",
      );
    out.deliverBy = by;
  }
  return out;
}

export function validateWaterfallConfig(raw: unknown): WaterfallConfig {
  const c = (raw ?? {}) as Record<string, unknown>;
  if (c["phases"] !== undefined && !Array.isArray(c["phases"]))
    fail(
      "config-invalid",
      "waterfall config.phases must be an array of phases",
      "omit phases for the six classic phases",
    );
  const hg = c["humanGates"] ?? "all";
  if (hg !== "all" && !strings(hg))
    fail(
      "config-invalid",
      'waterfall config.humanGates must be "all" or a string[] of phase ids',
      'omit it for "all"',
    );
  const human = hg === "all" ? () => true : (id: string) => (hg as string[]).includes(id);
  const phases =
    c["phases"] === undefined
      ? defaultPhases().map((p, i) => phase(p, i, human))
      : (c["phases"] as unknown[]).map((p, i) => phase(p, i, human));
  if (phases.length === 0)
    fail(
      "config-invalid",
      "waterfall config.phases needs at least one phase",
      'e.g. [{ "id": "requirements" }]',
    );
  const ids = phases.map((p) => p.id);
  const dupe = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dupe !== undefined)
    fail("config-invalid", `duplicate phase id "${dupe}"`, "give every phase a unique id");
  if (hg !== "all")
    for (const id of hg as string[])
      if (!ids.includes(id))
        fail(
          "config-invalid",
          `waterfall config.humanGates names unknown phase "${id}"`,
          `phases are: ${ids.join(", ")}`,
        );
  const cc = c["changeControl"] ?? {};
  if (!isObj(cc))
    fail(
      "config-invalid",
      "waterfall config.changeControl must be an object",
      'e.g. { "requiresImpactAnalysis": true, "approvers": ["human"] }',
    );
  if (
    cc["requiresImpactAnalysis"] !== undefined &&
    typeof cc["requiresImpactAnalysis"] !== "boolean"
  )
    fail(
      "config-invalid",
      "waterfall config.changeControl.requiresImpactAnalysis must be a boolean",
      "omit it for true",
    );
  const changeControl: WaterfallConfig["changeControl"] = {
    requiresImpactAnalysis:
      cc["requiresImpactAnalysis"] === undefined ? true : (cc["requiresImpactAnalysis"] as boolean),
    approvers: requirements(
      cc["approvers"] ?? ["human", { capability: "control-change" }],
      "waterfall config.changeControl.approvers",
    ),
  };
  const tr = c["traceability"];
  let traceability: WaterfallConfig["traceability"];
  if (tr === undefined) {
    traceability =
      ids.includes("requirements") && ids.includes("design") && ids.includes("verification")
        ? { from: "requirements", to: ["design", "verification"] }
        : { from: ids[0]!, to: [] };
  } else {
    if (!isObj(tr) || typeof tr["from"] !== "string" || !ids.includes(tr["from"]))
      fail(
        "config-invalid",
        "waterfall config.traceability.from must be a phase id",
        `phases are: ${ids.join(", ")}`,
      );
    const to = tr["to"] ?? [];
    if (!strings(to))
      fail(
        "config-invalid",
        "waterfall config.traceability.to must be a string[] of phase ids",
        `phases are: ${ids.join(", ")}`,
      );
    for (const t of to) {
      if (!ids.includes(t))
        fail(
          "config-invalid",
          `waterfall config.traceability.to names unknown phase "${t}"`,
          `phases are: ${ids.join(", ")}`,
        );
      if (ids.indexOf(t) <= ids.indexOf(tr["from"]))
        fail(
          "config-invalid",
          `waterfall config.traceability.to phase "${t}" must come after "${tr["from"]}"`,
          "trace forward only: from an earlier phase to later ones",
        );
    }
    traceability = { from: tr["from"], to: [...to] };
  }
  const fallback = c["fallbackTokensPerWeight"];
  if (
    fallback !== undefined &&
    (typeof fallback !== "number" || !Number.isFinite(fallback) || fallback <= 0)
  )
    fail(
      "config-invalid",
      "waterfall config.fallbackTokensPerWeight must be a positive finite number",
      "omit it for the default 20000",
    );
  const out: WaterfallConfig = {
    phases,
    changeControl,
    traceability,
    humanGates: hg === "all" ? "all" : [...(hg as string[])],
  };
  if (fallback !== undefined) out.fallbackTokensPerWeight = fallback;
  return out;
}
