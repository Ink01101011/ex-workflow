import { timSort } from "exsorted";
import { estimateTokens, remaining } from "../budget.ts";
import { fail } from "../errors.ts";
import { applyLessonInput, parseLessonInput } from "../lessons.ts";
import {
  addItem,
  editItem,
  getItem,
  moveItem,
  patchItem,
  stageOf,
  stripItemFields,
  type ItemPatch,
} from "../items.ts";
import { applyAction } from "../methodology.ts";
import { assertPolicies, evaluatePolicies } from "../policies.ts";
import { openIteration } from "../planner.ts";
import { approverIds, canDo, requireCap } from "../roles.ts";
export { canDo };
import { appendEvent, nowOf } from "../state.ts";
import type {
  Budget,
  Ceremony,
  CeremonyInput,
  ItemStatus,
  Iteration,
  Methodology,
  NewItem,
  Policy,
  WorkItem,
  WorkflowState,
} from "../types.ts";
import { closeSprint, configOf, resumeStageOf } from "./index.ts";

const STATUSES: ItemStatus[] = [
  "todo",
  "in_progress",
  "blocked",
  "review",
  "awaiting_human",
  "done",
  "dropped",
];

export interface DailyReport {
  sprint: string | null;
  goal: string | null;
  byStatus: Record<ItemStatus, number>;
  blockers: Array<{ item: string; blocker: string; owner: string; reason: string }>;
  spent: Required<Budget>;
  remaining: Budget;
  remainingWeight: number;
  raisedLessons: number;
  velocity: number | null;
  forecast: "on-track" | "at-risk" | "unknown";
}

export function velocityOf(state: WorkflowState): number | null {
  const closed = state.events.filter(
    (e) => e.type === "sprint.closed" && (e.payload as { reason: string }).reason !== "cancel",
  );
  if (closed.length === 0) return null;
  return (
    closed.reduce((sum, e) => sum + (e.payload as { doneWeight: number }).doneWeight, 0) /
    closed.length
  );
}

export function dailyReport(state: WorkflowState): DailyReport {
  const it = openIteration(state);
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<ItemStatus, number>;
  const blockers: DailyReport["blockers"] = [];
  let remainingWeight = 0;
  for (const id of it?.committed ?? []) {
    const item = state.items[id];
    if (!item) continue;
    byStatus[item.status] += 1;
    if (item.status !== "done") remainingWeight += item.weight ?? 0;
    for (const b of item.blockers)
      if (!b.clearedAt)
        blockers.push({ item: id, blocker: b.id, owner: b.owner, reason: b.reason });
  }
  const spent = it?.spent ?? { tokens: 0, turns: 0, wallclockMs: 0 };
  const rem = it ? remaining(it.budget, it.spent) : {};
  const velocity = velocityOf(state);
  let forecast: DailyReport["forecast"] = "unknown";
  if (it && velocity !== null && it.budget.tokens) {
    const share = (rem.tokens ?? 0) / it.budget.tokens;
    forecast = remainingWeight <= velocity * share ? "on-track" : "at-risk";
  }
  const raisedLessons = state.lessons.filter((l) => l.status === "raised").length;
  return {
    sprint: it?.id ?? null,
    goal: it?.goal ?? null,
    byStatus,
    blockers,
    spent,
    remaining: rem,
    remainingWeight,
    raisedLessons,
    velocity,
    forecast,
  };
}

function lastClosedIteration(state: WorkflowState): Iteration | undefined {
  for (let i = state.iterations.length - 1; i >= 0; i--) {
    const it = state.iterations[i]!;
    if (it.endedAt !== undefined) return it;
  }
  return undefined;
}

/** Event seq of the sprint.closed event of `id`; infinity when it is missing, so nothing counts as "after" it. */
export function closedSeq(state: WorkflowState, id: string): number {
  return (
    state.events.find((e) => e.type === "sprint.closed" && (e.payload as { id: string }).id === id)
      ?.seq ?? Number.POSITIVE_INFINITY
  );
}

function backlogOrdered(state: WorkflowState): WorkItem[] {
  const carry = new Set(lastClosedIteration(state)?.carryover ?? []);
  const items = Object.values(state.items).filter(
    (i) => i.stage === "backlog" && i.status === "todo" && i.type !== "question",
  );
  return timSort([...items], (x, y) => {
    const cx = carry.has(x.id) ? 1 : 0;
    const cy = carry.has(y.id) ? 1 : 0;
    if (cx !== cy) return cy - cx;
    return (y.priority ?? 0) - (x.priority ?? 0);
  });
}

/** Throw unless the item sits in the Product Backlog and meets the backlog exit policy. */
function assertCommittable(state: WorkflowState, id: string): void {
  const item = getItem(state, id);
  if (item.stage !== "backlog" || item.status !== "todo")
    fail(
      "invalid-input",
      `item "${id}" is not in the Product Backlog (${item.stage}/${item.status})`,
      "only backlog items can be committed",
      { items: [id] },
    );
  assertPolicies(state, item, stageOf(state, "backlog").exitPolicy, "enter the Sprint Backlog");
}

/** Open questions raised by the given parents travel with them into the sprint (they carry no weight). */
function attachQuestions(
  state: WorkflowState,
  parentIds: string[],
  iterationId: string,
  by: string,
  now: string,
): WorkflowState {
  let s = state;
  for (const q of Object.values(state.items)) {
    if (
      q.type !== "question" ||
      q.parent === undefined ||
      !parentIds.includes(q.parent) ||
      q.status === "done" ||
      q.status === "dropped"
    )
      continue;
    if (q.stage !== "sprint" || q.status !== "todo")
      s = moveItem(s, q.id, { stage: "sprint", status: "todo" }, by, now);
    s = patchItem(s, q.id, (it) => ({ ...it, iteration: iterationId }));
  }
  return s;
}

/** Set the Definition of Done in the config and on the review stage. */
export function setDod(state: WorkflowState, policies: Policy[]): WorkflowState {
  return {
    ...state,
    config: { ...configOf(state), definitionOfDone: policies },
    stages: state.stages.map((st) => (st.id === "review" ? { ...st, exitPolicy: policies } : st)),
  };
}

interface Skipped {
  id: string;
  reason: "policy" | "budget";
  detail: string;
}

function selectAuto(state: WorkflowState, budget: Budget): { ids: string[]; skipped: Skipped[] } {
  const cfg = configOf(state);
  const ids: string[] = [];
  const skipped: Skipped[] = [];
  const exit = stageOf(state, "backlog").exitPolicy;
  let tokens = 0;
  for (const item of backlogOrdered(state)) {
    const unmet = evaluatePolicies(state, item, exit);
    if (unmet.length > 0) {
      skipped.push({
        id: item.id,
        reason: "policy",
        detail: unmet.map((u) => u.message).join("; "),
      });
      continue;
    }
    if (budget.turns !== undefined && ids.length >= budget.turns) {
      skipped.push({ id: item.id, reason: "budget", detail: "turns budget full" });
      continue;
    }
    if (budget.tokens !== undefined) {
      const est = estimateTokens(state, item.weight, cfg.fallbackTokensPerWeight, cfg.estimateMode);
      if (tokens + est > budget.tokens) {
        skipped.push({
          id: item.id,
          reason: "budget",
          detail: `needs about ${est} tokens, ${budget.tokens - tokens} left`,
        });
        continue;
      }
      tokens += est;
    }
    ids.push(item.id);
  }
  return { ids, skipped };
}

export function scrumCeremonies(methodology: () => Methodology): Record<string, Ceremony> {
  const act = (
    state: WorkflowState,
    type: string,
    input: CeremonyInput,
    reduce: (s: WorkflowState, now: string) => WorkflowState,
  ) =>
    applyAction(state, methodology(), { type, by: input.by, payload: input }, (s) =>
      reduce(s, nowOf(input.now)),
    );

  const refine: Ceremony = (state, input) => {
    requireCap(state, input.by, "define-acceptance", "deliver");
    const items = (input["items"] ?? []) as Array<{ id: string; patch: ItemPatch }>;
    const split = (input["split"] ?? []) as Array<{ from: string; into: NewItem[] }>;
    const reestimateRaw: unknown = input["reestimate"] ?? [];
    if (!Array.isArray(reestimateRaw) || !reestimateRaw.every((x) => typeof x === "string"))
      fail(
        "invalid-input",
        "refine.reestimate must be a list of item ids",
        'pass reestimate: ["A"]',
      );
    const reestimate = reestimateRaw as string[];
    if (items.length === 0 && split.length === 0 && reestimate.length === 0)
      fail(
        "invalid-input",
        "refine needs items[], split[] or reestimate[]",
        "pass at least one patch, split or reestimate",
      );
    for (const id of reestimate) {
      const it = getItem(state, id);
      if (it.stage !== "backlog" || it.status !== "todo" || it.weight === undefined)
        fail(
          "invalid-input",
          `item "${id}" has no weight to confirm in the Product Backlog`,
          "refine it with a patch { weight } instead",
          { items: [id] },
        );
    }
    return act(state, "ceremony.refine", input, (s, now) => {
      for (const { id, patch } of items) s = editItem(s, id, patch, input.by, now);
      for (const id of reestimate)
        s = appendEvent(
          s,
          "item.reestimated",
          input.by,
          { id, weight: getItem(s, id).weight },
          now,
        );
      for (const sp of split) {
        getItem(s, sp.from);
        for (const n of sp.into) s = addItem(s, { ...n, parent: sp.from }, input.by, now);
        s = moveItem(s, sp.from, { status: "dropped" }, input.by, now);
      }
      return appendEvent(
        s,
        "ceremony.refine",
        input.by,
        {
          edited: items.map((i) => i.id),
          split: split.map((x) => ({ from: x.from, into: x.into.map((n) => n.id) })),
          reestimated: reestimate,
        },
        now,
      );
    });
  };

  const plan: Ceremony = (state, input) => {
    requireCap(state, input.by, "facilitate");
    const goal = input["goal"];
    if (typeof goal !== "string" || goal.trim() === "")
      fail(
        "invalid-input",
        "sprint planning needs a non-empty goal",
        "state the Sprint Goal in one sentence",
      );
    const cfg = configOf(state);
    const budget = (input["budget"] as Budget | undefined) ?? cfg.sprintBudget;
    const auto = input["items"] === "auto" ? selectAuto(state, budget) : undefined;
    const skipped = auto?.skipped ?? [];
    const wanted = auto ? auto.ids : (input["items"] as string[] | undefined);
    if (!Array.isArray(wanted))
      fail(
        "invalid-input",
        'sprint planning needs items: string[] or "auto"',
        'pass ["A","B"] or "auto"',
      );
    if (wanted.length === 0)
      fail(
        "invalid-input",
        `no backlog items fit the sprint${
          skipped.length
            ? `; skipped: ${skipped.map((x) => `${x.id} (${x.reason}: ${x.detail})`).join(", ")}`
            : ""
        }`,
        "refine the backlog (acceptance + estimates) or raise the budget with exwf config set",
      );
    for (const id of wanted) assertCommittable(state, id);
    return act(state, "ceremony.plan", input, (s, now) => {
      const id = `S${s.iterations.length + 1}`;
      const last = lastClosedIteration(s);
      const carryover = wanted.filter((w) => last?.carryover.includes(w));
      const resumed: string[] = [];
      for (const w of wanted) {
        const rs = resumeStageOf(getItem(s, w), s);
        if (rs) resumed.push(w);
        s = moveItem(
          s,
          w,
          rs ? { stage: rs, status: "review" } : { stage: "sprint", status: "todo" },
          input.by,
          now,
        );
        s = patchItem(s, w, (it) => ({ ...it, iteration: id }));
      }
      s = attachQuestions(s, wanted, id, input.by, now);
      const committedWeight = wanted.reduce((sum, w) => sum + (s.items[w]?.weight ?? 0), 0);
      s = {
        ...s,
        iterations: [
          ...s.iterations,
          {
            id,
            goal,
            budget,
            spent: { tokens: 0, turns: 0, wallclockMs: 0 },
            startedAt: now,
            committed: [...wanted],
            carryover,
          },
        ],
      };
      return appendEvent(
        s,
        "sprint.opened",
        input.by,
        { id, goal, committed: wanted, committedWeight, budget, skipped, resumed },
        now,
      );
    });
  };

  const commit: Ceremony = (state, input) => {
    const it = openIteration(state);
    if (!it) fail("invalid-input", "no open sprint to commit into", "run the plan ceremony first");
    const items = input["items"] as string[] | undefined;
    if (!Array.isArray(items) || items.length === 0)
      fail("invalid-input", "commit needs items[]", 'pass ["A"]');
    const seen = new Set<string>();
    for (const id of items) {
      if (seen.has(id))
        fail("invalid-input", `item "${id}" appears twice in items[]`, "list each item once", {
          items: [id],
        });
      seen.add(id);
      getItem(state, id);
      if (it.committed.includes(id))
        fail("invalid-input", `item "${id}" is already committed to ${it.id}`, "nothing to do", {
          items: [id],
        });
      assertCommittable(state, id);
    }
    return act(state, "ceremony.commit", input, (s, now) => {
      const resumed: string[] = [];
      for (const id of items) {
        const rs = resumeStageOf(getItem(s, id), s);
        if (rs) resumed.push(id);
        s = moveItem(
          s,
          id,
          rs ? { stage: rs, status: "review" } : { stage: "sprint", status: "todo" },
          input.by,
          now,
        );
        s = patchItem(s, id, (x) => ({ ...x, iteration: it.id }));
      }
      s = attachQuestions(s, items, it.id, input.by, now);
      s = {
        ...s,
        iterations: s.iterations.map((x) =>
          x.id === it.id ? { ...x, committed: [...x.committed, ...items] } : x,
        ),
      };
      return appendEvent(
        s,
        "sprint.committed",
        input.by,
        { id: it.id, items, goalImpact: input["goalImpact"] ?? null, resumed },
        now,
      );
    });
  };

  const uncommit: Ceremony = (state, input) => {
    requireCap(state, input.by, "order-backlog");
    const it = openIteration(state);
    if (!it) fail("invalid-input", "no open sprint", "nothing to uncommit from");
    const items = input["items"] as string[] | undefined;
    if (!Array.isArray(items) || items.length === 0)
      fail("invalid-input", "uncommit needs items[]", 'pass ["A"]');
    for (const id of items) {
      if (getItem(state, id).status === "done")
        fail("invalid-input", `item "${id}" is done`, "finished work cannot be uncommitted", {
          items: [id],
        });
    }
    for (const id of items)
      if (!it.committed.includes(id))
        fail(
          "invalid-input",
          `item "${id}" is not committed to ${it.id}`,
          `committed: ${it.committed.join(", ")}`,
          { items: [id] },
        );
    return act(state, "ceremony.uncommit", input, (s, now) => {
      for (const id of items) {
        s = moveItem(s, id, { stage: "backlog", status: "todo" }, input.by, now);
        s = stripItemFields(s, id, ["iteration", "role"]);
      }
      s = {
        ...s,
        iterations: s.iterations.map((x) =>
          x.id === it.id ? { ...x, committed: x.committed.filter((c) => !items.includes(c)) } : x,
        ),
      };
      return appendEvent(
        s,
        "sprint.uncommitted",
        input.by,
        { id: it.id, items, reason: input["reason"] ?? "" },
        now,
      );
    });
  };

  const daily: Ceremony = (state, input) =>
    act(state, "ceremony.daily", input, (s, now) =>
      appendEvent(s, "daily", input.by, dailyReport(s), now),
    );

  const review: Ceremony = (state, input) => {
    const it = openIteration(state);
    if (!it) fail("invalid-input", "no open sprint to review", "run the plan ceremony first");
    const approvers = approverIds(state, "sprint-review");
    if (input.by !== "human" && !approvers.includes(input.by)) {
      fail(
        "gate-unmet",
        `"${input.by}" may not accept the Sprint Review`,
        `run review as "human" or as ${approvers.join(", ") || "a role with canApprove sprint-review"}`,
        { rule: "sprint-review" },
      );
    }
    const feedback = (input["feedback"] ?? []) as NewItem[];
    return act(state, "ceremony.review", input, (s, now) => {
      for (const n of feedback) s = addItem(s, { ...n, stage: "backlog" }, input.by, now);
      const done = it.committed.filter((id) => s.items[id]?.status === "done");
      s = appendEvent(
        s,
        "increment",
        input.by,
        {
          sprint: it.id,
          done,
          goalMet: input["goalMet"] === true,
          accepted: input["accepted"] === true,
          feedback: feedback.map((f) => f.id),
        },
        now,
      );
      return closeSprint(s, "review", now);
    });
  };

  const retro: Ceremony = (state, input) => {
    requireCap(state, input.by, "facilitate");
    const last = lastClosedIteration(state);
    if (!last)
      fail(
        "invalid-input",
        "no closed sprint to retrospect",
        "close the sprint (review or cancel) first",
      );
    if (openIteration(state))
      fail(
        "invalid-input",
        "a sprint is still open",
        "retro runs between sprints; review or cancel the open one",
      );
    const closedAt = closedSeq(state, last.id);
    if (state.events.some((e) => e.type === "retro" && e.seq > closedAt))
      fail(
        "invalid-input",
        `sprint ${last.id} already has a retrospective`,
        "plan the next sprint",
      );
    const parsed = parseLessonInput(state, input, "retro");
    const dod = input["dodChanges"] as Policy[] | undefined;
    return act(state, "ceremony.retro", input, (s, now) => {
      const backlogAdded: string[] = [];
      let dodChanged = false;
      const out = applyLessonInput(s, parsed, input.by, now, (cur, c) => {
        if (c.kind === "dod") {
          const defs = configOf(cur).definitionOfDone;
          if (defs.some((p) => JSON.stringify(p) === JSON.stringify(c.policy))) return cur;
          dodChanged = true;
          return setDod(cur, [...defs, c.policy]);
        }
        if (c.kind === "backlog") {
          backlogAdded.push(c.item.id);
          return addItem(
            cur,
            { ...c.item, stage: "backlog", tags: [...(c.item.tags ?? []), "retro"] },
            input.by,
            now,
          );
        }
        return cur;
      });
      s = out.state;
      if (dod) {
        dodChanged = true;
        s = setDod(s, dod);
      }
      return appendEvent(
        s,
        "retro",
        input.by,
        {
          sprint: last.id,
          adopted: out.adopted,
          dismissed: out.dismissed,
          agreements: out.agreements,
          retired: out.retired,
          dodChanged,
          backlogAdded,
        },
        now,
      );
    });
  };

  const cancel: Ceremony = (state, input) => {
    requireCap(state, input.by, "order-backlog");
    const it = openIteration(state);
    if (!it) fail("invalid-input", "no open sprint to cancel", "nothing to do");
    return act(state, "ceremony.cancel", input, (s, now) => {
      s = appendEvent(
        s,
        "sprint.cancelled",
        input.by,
        { id: it.id, reason: input["reason"] ?? "" },
        now,
      );
      return closeSprint(s, "cancel", now);
    });
  };

  return { refine, plan, commit, uncommit, daily, review, retro, cancel };
}
