import { fail } from "../errors.ts";
import { getItem, moveItem, stageOf } from "../items.ts";
import { applyAction } from "../methodology.ts";
import { assertPolicies } from "../policies.ts";
import { requireCap } from "../roles.ts";
import { appendEvent, nowOf } from "../state.ts";
import type {
  Ceremony,
  CeremonyInput,
  ClassOfService,
  Methodology,
  Policy,
  Stage,
  WorkflowState,
} from "../types.ts";
import { commitmentColumn, deliveryColumn, optionsColumn } from "./columns.ts";
import { CLASSES, configOf, type KanbanColumn, type ServiceLevel } from "./config.ts";

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/** input.items as a non-empty, duplicate-free string[] of existing item ids. */
export function wantItems(state: WorkflowState, input: CeremonyInput, cadence: string): string[] {
  const items = input["items"];
  if (!Array.isArray(items) || items.length === 0 || !items.every((x) => typeof x === "string"))
    fail("invalid-input", `${cadence} needs items: string[]`, 'pass ["A", "B"]');
  const dupe = items.find((id, i) => items.indexOf(id) !== i);
  if (dupe !== undefined)
    fail("invalid-input", `item "${dupe}" appears twice in items[]`, "list each item once", {
      items: [dupe],
    });
  for (const id of items) getItem(state, id);
  return items;
}

function validLevel(x: unknown): x is ServiceLevel {
  return (
    isObj(x) &&
    typeof x["percentile"] === "number" &&
    x["percentile"] >= 0 &&
    x["percentile"] <= 100 &&
    typeof x["targetMs"] === "number" &&
    Number.isFinite(x["targetMs"]) &&
    x["targetMs"] > 0
  );
}

function withWip<T extends Stage | KanbanColumn>(x: T, limit: number | null): T {
  const { wipLimit: _w, ...rest } = x;
  return (limit === null ? rest : { ...rest, wipLimit: limit }) as T;
}

export function kanbanCeremonies(methodology: () => Methodology): Record<string, Ceremony> {
  const act = (
    state: WorkflowState,
    type: string,
    input: CeremonyInput,
    reduce: (s: WorkflowState, now: string) => WorkflowState,
  ) =>
    applyAction(state, methodology(), { type, by: input.by, payload: input }, (s) =>
      reduce(s, nowOf(input.now)),
    );

  const replenishment: Ceremony = (state, input) => {
    requireCap(state, input.by, "order-backlog", "manage-flow");
    const items = wantItems(state, input, "replenishment");
    const target = commitmentColumn(state);
    const options = optionsColumn(state);
    for (const id of items)
      assertPolicies(state, getItem(state, id), options.exitPolicy, `leave "${options.id}"`);
    return act(state, "ceremony.replenishment", input, (s, now) => {
      for (const id of items)
        s = moveItem(s, id, { stage: target.id, status: "todo" }, input.by, now);
      return appendEvent(
        s,
        "cadence.replenishment",
        input.by,
        {
          column: target.id,
          items: items.map((id) => {
            const it = getItem(s, id);
            return {
              id,
              classOfService: it.classOfService ?? "standard",
              deadline: it.deadline ?? null,
            };
          }),
        },
        now,
      );
    });
  };

  const deliveryPlanning: Ceremony = (state, input) => {
    requireCap(state, input.by, "facilitate", "manage-flow");
    const items = wantItems(state, input, "delivery-planning");
    const delivery = deliveryColumn(state);
    const last = state.stages[state.stages.findIndex((st) => st.id === delivery.id) - 1]!;
    for (const id of items) {
      const it = getItem(state, id);
      if (it.stage !== last.id && it.stage !== delivery.id)
        fail(
          "invalid-input",
          `item "${id}" is in "${it.stage}", not ready for delivery`,
          `only cards in "${last.id}" or "${delivery.id}" can be planned for delivery`,
          { items: [id] },
        );
    }
    return act(state, "ceremony.delivery-planning", input, (s, now) =>
      appendEvent(
        s,
        "cadence.delivery-planning",
        input.by,
        {
          items,
          window: typeof input["window"] === "string" ? input["window"] : null,
          delivered: items.filter((id) => getItem(s, id).status === "done"),
        },
        now,
      ),
    );
  };

  const serviceDeliveryReview: Ceremony = (state, input) => {
    requireCap(state, input.by, "manage-flow");
    const wip = input["wip"] ?? {};
    const policies = input["policies"] ?? {};
    const sle = input["sle"] ?? {};
    if (!isObj(wip) || !isObj(policies) || !isObj(sle))
      fail(
        "invalid-input",
        "service-delivery-review takes wip, policies and sle objects keyed by column or class",
        'e.g. { "wip": { "dev": 2 }, "policies": { "dev": [{ "kind": "no-open-blockers" }] }, "sle": { "standard": { "percentile": 85, "targetMs": 604800000 } } }',
      );
    for (const [id, limit] of Object.entries(wip)) {
      stageOf(state, id);
      if (limit !== null && (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1))
        fail(
          "invalid-input",
          `wip.${id} must be a positive number or null`,
          "null removes the limit",
        );
    }
    for (const [id, p] of Object.entries(policies)) {
      stageOf(state, id);
      if (!Array.isArray(p))
        fail(
          "invalid-input",
          `policies.${id} must be a Policy[]`,
          'e.g. [{ "kind": "no-open-blockers" }]',
        );
    }
    for (const [cls, level] of Object.entries(sle)) {
      if (!(CLASSES as readonly string[]).includes(cls))
        fail(
          "invalid-input",
          `sle.${cls} is not a class of service`,
          `use one of: ${CLASSES.join(", ")}`,
        );
      if (level !== null && !validLevel(level))
        fail(
          "invalid-input",
          `sle.${cls} must be { percentile: 0..100, targetMs: > 0 } or null`,
          "null removes the service level",
        );
    }
    return act(state, "ceremony.service-delivery-review", input, (s, now) => {
      const cfg = configOf(s);
      let stages = s.stages;
      let columns = cfg.columns;
      let classesOfService = { ...cfg.classesOfService };
      const wipChanges: Array<{ column: string; before: number | null; after: number | null }> = [];
      const policyChanges: Array<{ column: string; before: Policy[]; after: Policy[] }> = [];
      const sleChanges: Array<{
        classOfService: string;
        before: ServiceLevel | null;
        after: ServiceLevel | null;
      }> = [];
      for (const [id, limit] of Object.entries(wip) as Array<[string, number | null]>) {
        const before = stages.find((st) => st.id === id)!.wipLimit ?? null;
        if (before === limit) continue;
        wipChanges.push({ column: id, before, after: limit });
        stages = stages.map((st) => (st.id === id ? withWip(st, limit) : st));
        columns = columns.map((col) => (col.id === id ? withWip(col, limit) : col));
      }
      for (const [id, p] of Object.entries(policies) as Array<[string, Policy[]]>) {
        const before = stages.find((st) => st.id === id)!.exitPolicy;
        if (JSON.stringify(before) === JSON.stringify(p)) continue;
        policyChanges.push({ column: id, before, after: p });
        stages = stages.map((st) => (st.id === id ? { ...st, exitPolicy: p } : st));
        columns = columns.map((col) => (col.id === id ? { ...col, policies: p } : col));
      }
      for (const [cls, level] of Object.entries(sle) as Array<
        [ClassOfService, ServiceLevel | null]
      >) {
        const before = classesOfService[cls]?.sle ?? null;
        if (JSON.stringify(before) === JSON.stringify(level)) continue;
        sleChanges.push({ classOfService: cls, before, after: level });
        const { sle: _old, ...rest } = classesOfService[cls] ?? {};
        classesOfService = {
          ...classesOfService,
          [cls]: level === null ? rest : { ...rest, sle: level },
        };
      }
      s = { ...s, stages, config: { ...cfg, columns, classesOfService } };
      return appendEvent(
        s,
        "cadence.service-delivery-review",
        input.by,
        { wip: wipChanges, policies: policyChanges, sle: sleChanges },
        now,
      );
    });
  };

  return {
    replenishment,
    "delivery-planning": deliveryPlanning,
    "service-delivery-review": serviceDeliveryReview,
  };
}
