import type { Action, Policy, Rule, Violation, WorkflowState } from "../types.ts";
import { ACTIVE, OPEN, onBoard } from "./columns.ts";
import { configOf } from "./config.ts";

const v = (
  rule: string,
  severity: Violation["severity"],
  message: string,
  fix: string,
  item?: string,
): Violation => (item ? { rule, severity, item, message, fix } : { rule, severity, message, fix });

const payloadOf = (a: Action): Record<string, unknown> =>
  (a.payload ?? {}) as Record<string, unknown>;
const itemsOf = (a: Action): string[] => {
  const items = payloadOf(a)["items"];
  return Array.isArray(items) ? (items as string[]) : [];
};
const activeIn = (s: WorkflowState, column: string) =>
  Object.values(s.items).filter((i) => i.stage === column && ACTIVE.has(i.status)).length;

export function kanbanRules(): Rule[] {
  const policyExplicit: Rule = {
    id: "policy-explicit",
    severity: "error",
    check(s, a) {
      const delivery = s.stages.find((st) => st.deliveryPoint)?.id;
      if (a.type === "init")
        return s.stages
          .filter((st) => st.id !== delivery && st.exitPolicy.length === 0)
          .map((st) =>
            v(
              "policy-explicit",
              "error",
              `column "${st.id}" has no explicit policy`,
              `give column "${st.id}" at least one policy, e.g. { "kind": "acceptance-written" }`,
            ),
          );
      if (a.type === "ceremony.service-delivery-review") {
        const policies = (payloadOf(a)["policies"] ?? {}) as Record<string, Policy[]>;
        return Object.entries(policies)
          .filter(([id, p]) => id !== delivery && Array.isArray(p) && p.length === 0)
          .map(([id]) =>
            v(
              "policy-explicit",
              "error",
              `column "${id}" would be left without a policy`,
              "keep at least one policy per column; Kanban policies are explicit",
            ),
          );
      }
      return [];
    },
  };

  const commitmentOnce: Rule = {
    id: "commitment-point-once",
    severity: "error",
    check(s, a) {
      if (a.type !== "init") return [];
      const out: Violation[] = [];
      const commits = s.stages.filter((st) => st.commitmentPoint);
      const delivers = s.stages.filter((st) => st.deliveryPoint);
      if (commits.length !== 1)
        out.push(
          v(
            "commitment-point-once",
            "error",
            `${commits.length} columns are marked commitmentPoint (${commits.map((c) => c.id).join(", ") || "none"})`,
            "mark exactly one column commitmentPoint: true",
          ),
        );
      if (delivers.length !== 1)
        out.push(
          v(
            "commitment-point-once",
            "error",
            `${delivers.length} columns are marked deliveryPoint (${delivers.map((c) => c.id).join(", ") || "none"})`,
            "mark exactly one column deliveryPoint: true",
          ),
        );
      if (commits.length === 1 && delivers.length === 1) {
        const ci = s.stages.indexOf(commits[0]!);
        const di = s.stages.indexOf(delivers[0]!);
        if (di !== s.stages.length - 1)
          out.push(
            v(
              "commitment-point-once",
              "error",
              `delivery column "${delivers[0]!.id}" is not the last column`,
              "move the delivery column to the end; finished cards leave the board there",
            ),
          );
        if (ci === 0)
          out.push(
            v(
              "commitment-point-once",
              "error",
              `commitment column "${commits[0]!.id}" is the first column`,
              "keep an Options column before the commitment point; replenishment pulls from it",
            ),
          );
        else if (ci >= di)
          out.push(
            v(
              "commitment-point-once",
              "error",
              `commitment column "${commits[0]!.id}" comes after the delivery column`,
              "order columns options → commitment → … → delivery",
            ),
          );
      }
      return out;
    },
  };

  const wipRespected: Rule = {
    id: "wip-respected",
    severity: "error",
    check(s, a) {
      if (a.type === "ceremony.replenishment") {
        const target = s.stages.find((st) => st.commitmentPoint);
        if (!target || target.wipLimit === undefined) return [];
        const items = itemsOf(a);
        const open = Object.values(s.items).filter(
          (i) => i.stage === target.id && OPEN.has(i.status),
        ).length;
        const bypass = items.some((id) => s.items[id]?.classOfService === "expedite")
          ? (configOf(s).classesOfService.expedite?.wipBypass ?? 1)
          : 0;
        const limit = target.wipLimit + bypass;
        if (open + items.length <= limit) return [];
        return [
          v(
            "wip-respected",
            "error",
            `column "${target.id}" holds ${open} card(s); pulling ${items.length} more exceeds its WIP limit of ${target.wipLimit}${bypass ? ` (+${bypass} expedite bypass)` : ""}`,
            `pull at most ${Math.max(0, limit - open)} card(s) now, or raise the limit in a service-delivery-review`,
          ),
        ];
      }
      if (a.type === "ceremony.service-delivery-review") {
        const wip = (payloadOf(a)["wip"] ?? {}) as Record<string, number | null>;
        const out: Violation[] = [];
        for (const [id, limit] of Object.entries(wip)) {
          if (typeof limit !== "number") continue;
          const active = activeIn(s, id);
          if (active > limit)
            out.push(
              v(
                "wip-respected",
                "warning",
                `column "${id}" has ${active} active card(s), above the new limit of ${limit}`,
                "nothing new is pulled into it until it drains; finish or move cards",
              ),
            );
        }
        return out;
      }
      return [];
    },
  };

  const pullNotPush: Rule = {
    id: "pull-not-push",
    severity: "error",
    check(s, a) {
      if (a.type !== "ceremony.replenishment") return [];
      const options = s.stages[0];
      const commit = s.stages.find((st) => st.commitmentPoint);
      if (!options || !commit) return [];
      const out: Violation[] = [];
      const column = payloadOf(a)["column"];
      if (column !== undefined && column !== commit.id)
        out.push(
          v(
            "pull-not-push",
            "error",
            `replenishment may only pull into the commitment column "${commit.id}", not "${String(column)}"`,
            "drop column or set it to the commitment column; later columns are pulled by the planner",
          ),
        );
      for (const id of itemsOf(a)) {
        const it = s.items[id];
        if (!it) continue;
        if (it.stage !== options.id || it.status !== "todo")
          out.push(
            v(
              "pull-not-push",
              "error",
              `item "${id}" is ${it.status} in "${it.stage}", not an option`,
              `only todo cards in "${options.id}" can be pulled; cards already on the board flow by pull`,
              id,
            ),
          );
      }
      return out;
    },
  };

  const blockerHasOwner: Rule = {
    id: "blocker-has-owner",
    severity: "error",
    check(s, a) {
      if (!a.type.startsWith("ceremony.")) return [];
      const out: Violation[] = [];
      if (a.type === "ceremony.operations-review") {
        const assign = (payloadOf(a)["assign"] ?? []) as Array<{
          item: string;
          blocker: string;
          owner: string;
        }>;
        for (const x of assign)
          if (typeof x.owner !== "string" || x.owner.trim() === "")
            out.push(
              v(
                "blocker-has-owner",
                "error",
                `blocker "${x.blocker}" on "${x.item}" would have no owner`,
                "name the role or person who clears it",
                x.item,
              ),
            );
      }
      for (const it of Object.values(s.items))
        for (const b of it.blockers)
          if (!b.clearedAt && b.owner.trim() === "")
            out.push(
              v(
                "blocker-has-owner",
                "warning",
                `blocker "${b.id}" on "${it.id}" has no owner`,
                `assign one in operations-review: { "assign": [{ "item": "${it.id}", "blocker": "${b.id}", "owner": "<who>" }] }`,
                it.id,
              ),
            );
      return out;
    },
  };

  const oneExpedite: Rule = {
    id: "one-expedite",
    severity: "error",
    check(s, a) {
      if (a.type !== "ceremony.replenishment") return [];
      const fresh = itemsOf(a).filter((id) => s.items[id]?.classOfService === "expedite");
      if (fresh.length === 0) return [];
      const already = Object.values(s.items)
        .filter((i) => i.classOfService === "expedite" && OPEN.has(i.status) && onBoard(s, i))
        .map((i) => i.id);
      const max = configOf(s).maxExpedite;
      if (already.length + fresh.length <= max) return [];
      return [
        v(
          "one-expedite",
          "error",
          `${already.length} expedite card(s) already on the board (${already.join(", ") || "none"}); pulling ${fresh.join(", ")} exceeds maxExpedite ${max}`,
          "deliver the current expedite first, reclassify the new card, or raise maxExpedite in a strategy-review",
        ),
      ];
    },
  };

  const fixedDate: Rule = {
    id: "fixed-date-needs-deadline",
    severity: "error",
    check(s, a) {
      if (a.type !== "ceremony.replenishment") return [];
      return itemsOf(a)
        .filter((id) => {
          const it = s.items[id];
          return (
            it?.classOfService === "fixed-date" &&
            !(it.deadline && Number.isFinite(Date.parse(it.deadline)))
          );
        })
        .map((id) =>
          v(
            "fixed-date-needs-deadline",
            "error",
            `fixed-date item "${id}" has no deadline`,
            `editItem("${id}", { deadline: "<ISO date>" }) before pulling it`,
            id,
          ),
        );
    },
  };

  return [
    policyExplicit,
    commitmentOnce,
    wipRespected,
    pullNotPush,
    blockerHasOwner,
    oneExpedite,
    fixedDate,
  ];
}
