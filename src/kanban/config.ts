import { assertId, fail } from "../errors.ts";
import type { ClassOfService, Policy, WorkflowState } from "../types.ts";

export type KanbanCadence =
  | "replenishment"
  | "delivery-planning"
  | "service-delivery-review"
  | "operations-review"
  | "risk-review"
  | "strategy-review";
export const KANBAN_CADENCES: readonly KanbanCadence[] = [
  "replenishment",
  "delivery-planning",
  "service-delivery-review",
  "operations-review",
  "risk-review",
  "strategy-review",
];
export const CLASSES: readonly ClassOfService[] = [
  "expedite",
  "fixed-date",
  "standard",
  "intangible",
];
export const DAY_MS = 86_400_000;

export interface KanbanColumn {
  id: string;
  name: string;
  wipLimit?: number;
  /** Explicit policies a card must satisfy before it LEAVES the column (checked by complete()). */
  policies: Policy[];
  commitmentPoint?: boolean;
  deliveryPoint?: boolean;
  /** Cards entering this column wait for a reviewer (status "review"). */
  review?: boolean;
}
export interface ServiceLevel {
  percentile: number;
  targetMs: number;
}
export interface ClassConfig {
  wipBypass?: number;
  sle?: ServiceLevel;
}
export interface KanbanConfig {
  columns: KanbanColumn[];
  classesOfService: Partial<Record<ClassOfService, ClassConfig>>;
  fairness: { aging: boolean; maxDeferralRounds: number };
  cadences: Partial<Record<KanbanCadence, { everyTurns?: number }>>;
  throughputWindowMs: number;
  maxExpedite: number;
}

export function configOf(state: WorkflowState): KanbanConfig {
  return state.config as KanbanConfig;
}

export const DEFAULT_COLUMNS: KanbanColumn[] = [
  { id: "options", name: "Options", policies: [{ kind: "acceptance-written" }] },
  {
    id: "ready",
    name: "Ready",
    wipLimit: 4,
    commitmentPoint: true,
    policies: [{ kind: "dependencies-done" }],
  },
  {
    id: "dev",
    name: "Development",
    wipLimit: 3,
    policies: [{ kind: "evidence", evidenceKind: "test-output" }],
  },
  {
    id: "review",
    name: "Review",
    wipLimit: 2,
    review: true,
    policies: [{ kind: "no-open-blockers" }],
  },
  { id: "done", name: "Done", deliveryPoint: true, policies: [] },
];

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

function positive(v: unknown, field: string, fix: string, min = 1): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min)
    fail(
      "config-invalid",
      `kanban config.${field} must be a number >= ${min} (got ${JSON.stringify(v)})`,
      fix,
    );
  return v;
}

const BARE_POLICY_KINDS = [
  "acceptance-written",
  "estimate-present",
  "no-open-blockers",
  "dependencies-done",
];

const nonEmpty = (x: unknown): boolean => typeof x === "string" && x.trim() !== "";

/** Validate a Policy[]: every entry must be a core Policy object. Returns a fresh array. */
export function validatePolicies(raw: unknown, field: string): Policy[] {
  if (!Array.isArray(raw))
    fail(
      "config-invalid",
      `kanban config.${field} must be an array of Policy objects`,
      'e.g. [{ "kind": "evidence", "evidenceKind": "test-output" }]',
    );
  const out: Policy[] = [];
  raw.forEach((p: unknown, i: number) => {
    const at = `kanban config.${field}[${i}]`;
    const ok =
      isObj(p) &&
      (p["kind"] === "evidence"
        ? nonEmpty(p["evidenceKind"])
        : p["kind"] === "custom"
          ? nonEmpty(p["id"]) && nonEmpty(p["description"])
          : typeof p["kind"] === "string" && BARE_POLICY_KINDS.includes(p["kind"]));
    if (!ok)
      fail(
        "config-invalid",
        `${at} must be a Policy`,
        `use a Policy such as { "kind": "evidence", "evidenceKind": "test-output" }, { "kind": "custom", "id": "x", "description": "..." } or one of: ${BARE_POLICY_KINDS.join(", ")}`,
      );
    out.push(p as Policy);
  });
  return out;
}

function column(raw: unknown, i: number): KanbanColumn {
  if (!isObj(raw))
    fail(
      "config-invalid",
      `kanban config.columns[${i}] must be an object`,
      'e.g. { "id": "dev", "policies": [] }',
    );
  assertId(raw["id"], `kanban config.columns[${i}].id`);
  const id = raw["id"] as string;
  if (!Array.isArray(raw["policies"]))
    fail(
      "config-invalid",
      `kanban config.columns[${i}] ("${id}") needs policies: Policy[]`,
      'every column states its policies explicitly, e.g. [{ "kind": "acceptance-written" }]',
    );
  const out: KanbanColumn = {
    id,
    name: typeof raw["name"] === "string" && raw["name"].trim() !== "" ? raw["name"] : id,
    policies: validatePolicies(raw["policies"], `columns[${i}].policies`),
  };
  const wip = positive(raw["wipLimit"], `columns[${i}].wipLimit`, "omit wipLimit for no limit");
  if (wip !== undefined) out.wipLimit = wip;
  for (const flag of ["commitmentPoint", "deliveryPoint", "review"] as const) {
    if (raw[flag] === undefined) continue;
    if (typeof raw[flag] !== "boolean")
      fail(
        "config-invalid",
        `kanban config.columns[${i}].${flag} must be a boolean`,
        `set ${flag}: true or omit it`,
      );
    if (raw[flag]) out[flag] = true;
  }
  return out;
}

export function validateKanbanConfig(raw: unknown): KanbanConfig {
  const c = (raw ?? {}) as Record<string, unknown>;
  if (c["columns"] !== undefined && !Array.isArray(c["columns"]))
    fail(
      "config-invalid",
      "kanban config.columns must be an array of columns",
      "omit columns for the default board (options, ready, dev, review, done)",
    );
  const columns =
    c["columns"] === undefined
      ? DEFAULT_COLUMNS.map((x) => ({ ...x }))
      : (c["columns"] as unknown[]).map(column);
  const seen = new Set<string>();
  for (const col of columns) {
    if (seen.has(col.id))
      fail("config-invalid", `duplicate column id "${col.id}"`, "give every column a unique id");
    seen.add(col.id);
  }
  const classesOfService: KanbanConfig["classesOfService"] = {};
  const cos = c["classesOfService"] ?? {};
  if (!isObj(cos))
    fail(
      "config-invalid",
      "kanban config.classesOfService must be an object keyed by class",
      'e.g. { "expedite": { "wipBypass": 1 } }',
    );
  for (const [k, v] of Object.entries(cos)) {
    if (!(CLASSES as readonly string[]).includes(k))
      fail(
        "config-invalid",
        `kanban config.classesOfService.${k} is not a class of service`,
        `use one of: ${CLASSES.join(", ")}`,
      );
    if (!isObj(v))
      fail(
        "config-invalid",
        `kanban config.classesOfService.${k} must be an object`,
        'e.g. { "wipBypass": 1, "sle": { "percentile": 85, "targetMs": 604800000 } }',
      );
    const entry: ClassConfig = {};
    const bypass = positive(
      v["wipBypass"],
      `classesOfService.${k}.wipBypass`,
      "omit it for the default 1",
      0,
    );
    if (bypass !== undefined) entry.wipBypass = bypass;
    if (v["sle"] !== undefined) {
      const sle = v["sle"];
      if (
        !isObj(sle) ||
        typeof sle["percentile"] !== "number" ||
        sle["percentile"] < 0 ||
        sle["percentile"] > 100
      )
        fail(
          "config-invalid",
          `kanban config.classesOfService.${k}.sle.percentile must be 0..100`,
          'e.g. { "percentile": 85, "targetMs": 604800000 }',
        );
      const target = positive(
        sle["targetMs"],
        `classesOfService.${k}.sle.targetMs`,
        "state the service level target in milliseconds",
      );
      if (target === undefined)
        fail(
          "config-invalid",
          `kanban config.classesOfService.${k}.sle.targetMs is required`,
          "state the service level target in milliseconds",
        );
      entry.sle = { percentile: sle["percentile"], targetMs: target };
    }
    classesOfService[k as ClassOfService] = entry;
  }
  const f = c["fairness"] ?? {};
  if (!isObj(f) || (f["aging"] !== undefined && typeof f["aging"] !== "boolean"))
    fail(
      "config-invalid",
      "kanban config.fairness must be { aging: boolean, maxDeferralRounds?: number }",
      "omit it for aging on",
    );
  const rounds = positive(
    f["maxDeferralRounds"],
    "fairness.maxDeferralRounds",
    "omit it for 5 rounds",
  );
  const fairness: KanbanConfig["fairness"] = {
    aging: f["aging"] === undefined ? true : (f["aging"] as boolean),
    maxDeferralRounds: rounds ?? 5,
  };
  const cadences: KanbanConfig["cadences"] = {};
  const cad = c["cadences"] ?? {};
  if (!isObj(cad))
    fail(
      "config-invalid",
      "kanban config.cadences must be an object keyed by cadence",
      'e.g. { "replenishment": { "everyTurns": 10 } }',
    );
  for (const [k, v] of Object.entries(cad)) {
    if (!(KANBAN_CADENCES as readonly string[]).includes(k))
      fail(
        "config-invalid",
        `kanban config.cadences.${k} is not a cadence`,
        `use one of: ${KANBAN_CADENCES.join(", ")}`,
      );
    if (!isObj(v))
      fail(
        "config-invalid",
        `kanban config.cadences.${k} must be an object`,
        'e.g. { "everyTurns": 10 }',
      );
    const every = positive(
      v["everyTurns"],
      `cadences.${k}.everyTurns`,
      "omit it when the cadence is run by hand",
    );
    cadences[k as KanbanCadence] = every === undefined ? {} : { everyTurns: every };
  }
  return {
    columns,
    classesOfService,
    fairness,
    cadences,
    throughputWindowMs:
      positive(c["throughputWindowMs"], "throughputWindowMs", "omit it for one week") ?? 7 * DAY_MS,
    maxExpedite: positive(c["maxExpedite"], "maxExpedite", "omit it for 1") ?? 1,
  };
}
