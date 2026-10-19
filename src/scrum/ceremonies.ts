import { timSort } from "exsorted";
import { estimateTokens, remaining } from "../budget.ts";
import { fail } from "../errors.ts";
import { addItem, editItem, getItem, moveItem, stageOf, type ItemPatch } from "../items.ts";
import { applyAction } from "../methodology.ts";
import { assertPolicies } from "../policies.ts";
import { openIteration } from "../planner.ts";
import { hasCapability } from "../roles.ts";
import { appendEvent, nowOf } from "../state.ts";
import type {
  Budget,
  Capability,
  Ceremony,
  CeremonyInput,
  ItemStatus,
  Iteration,
  Lesson,
  LessonChange,
  Methodology,
  NewItem,
  Policy,
  WorkItem,
  WorkflowState,
} from "../types.ts";
import { closeSprint, configOf } from "./index.ts";

export function canDo(state: WorkflowState, by: string, ...caps: Capability[]): boolean {
  if (by === "human") return true;
  const role = state.roles[by];
  return !!role && caps.some((c) => hasCapability(role, c));
}

function requireCap(state: WorkflowState, by: string, ...caps: Capability[]): void {
  if (!canDo(state, by, ...caps)) {
    const holders = Object.values(state.roles)
      .filter((r) => caps.some((c) => hasCapability(r, c)))
      .map((r) => r.id);
    fail(
      "missing-capability",
      `"${by}" lacks capability ${caps.map((c) => `"${c}"`).join(" or ")}`,
      `run this as one of: ${holders.join(", ") || "human"}`,
    );
  }
}

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

function backlogOrdered(state: WorkflowState): WorkItem[] {
  const carry = new Set(lastClosedIteration(state)?.carryover ?? []);
  const items = Object.values(state.items).filter(
    (i) => i.stage === "backlog" && i.status === "todo",
  );
  return timSort([...items], (x, y) => {
    const cx = carry.has(x.id) ? 1 : 0;
    const cy = carry.has(y.id) ? 1 : 0;
    if (cx !== cy) return cy - cx;
    return (y.priority ?? 0) - (x.priority ?? 0);
  });
}

function selectAuto(state: WorkflowState, budget: Budget): string[] {
  const out: string[] = [];
  let tokens = 0;
  for (const item of backlogOrdered(state)) {
    if (budget.tokens !== undefined) {
      const est = estimateTokens(state, item.weight);
      if (tokens + est > budget.tokens) break;
      tokens += est;
    } else if (budget.turns !== undefined && out.length >= budget.turns) break;
    out.push(item.id);
  }
  return out;
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
    if (items.length === 0 && split.length === 0)
      fail("invalid-input", "refine needs items[] or split[]", "pass at least one patch or split");
    return act(state, "ceremony.refine", input, (s, now) => {
      for (const { id, patch } of items) s = editItem(s, id, patch, input.by, now);
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
    const wanted =
      input["items"] === "auto"
        ? selectAuto(state, budget)
        : (input["items"] as string[] | undefined);
    if (!Array.isArray(wanted))
      fail(
        "invalid-input",
        'sprint planning needs items: string[] or "auto"',
        'pass ["A","B"] or "auto"',
      );
    if (wanted.length === 0)
      fail(
        "invalid-input",
        "no backlog items fit the sprint",
        "refine the backlog (acceptance + estimates) or raise the budget in config",
      );
    const backlogStage = stageOf(state, "backlog");
    for (const id of wanted) {
      const item = getItem(state, id);
      if (item.stage !== "backlog" || item.status !== "todo")
        fail(
          "invalid-input",
          `item "${id}" is not in the Product Backlog (${item.stage}/${item.status})`,
          "only backlog items can be committed",
          { items: [id] },
        );
      assertPolicies(state, item, backlogStage.exitPolicy, "enter the Sprint Backlog");
    }
    return act(state, "ceremony.plan", input, (s, now) => {
      const id = `S${s.iterations.length + 1}`;
      const last = lastClosedIteration(s);
      const carryover = wanted.filter((w) => last?.carryover.includes(w));
      for (const w of wanted) {
        s = moveItem(s, w, { stage: "sprint", status: "todo" }, input.by, now);
        s = { ...s, items: { ...s.items, [w]: { ...s.items[w]!, iteration: id } } };
      }
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
        { id, goal, committed: wanted, committedWeight, budget },
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
    const backlogStage = stageOf(state, "backlog");
    const seen = new Set<string>();
    for (const id of items) {
      if (seen.has(id))
        fail("invalid-input", `item "${id}" appears twice in items[]`, "list each item once", {
          items: [id],
        });
      seen.add(id);
      const item = getItem(state, id);
      if (it.committed.includes(id))
        fail("invalid-input", `item "${id}" is already committed to ${it.id}`, "nothing to do", {
          items: [id],
        });
      if (item.stage !== "backlog" || item.status !== "todo")
        fail(
          "invalid-input",
          `item "${id}" is not in the Product Backlog (${item.stage}/${item.status})`,
          "only backlog items can be committed",
          { items: [id] },
        );
      assertPolicies(state, item, backlogStage.exitPolicy, "enter the Sprint Backlog");
    }
    return act(state, "ceremony.commit", input, (s, now) => {
      for (const id of items) {
        s = moveItem(s, id, { stage: "sprint", status: "todo" }, input.by, now);
        s = { ...s, items: { ...s.items, [id]: { ...s.items[id]!, iteration: it.id } } };
      }
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
        { id: it.id, items, goalImpact: input["goalImpact"] ?? null },
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
        const { iteration: _i, role: _r, ...rest } = s.items[id]!;
        s = { ...s, items: { ...s.items, [id]: rest as WorkItem } };
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
    const role = state.roles[input.by];
    const mayApprove =
      input.by === "human" || (!!role && role.canApprove.includes("sprint-review"));
    if (!mayApprove) {
      const approvers = Object.values(state.roles)
        .filter((r) => r.canApprove.includes("sprint-review"))
        .map((r) => r.id);
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
    const closedSeq =
      state.events.find(
        (e) => e.type === "sprint.closed" && (e.payload as { id: string }).id === last.id,
      )?.seq ?? 0;
    if (state.events.some((e) => e.type === "retro" && e.seq > closedSeq))
      fail(
        "invalid-input",
        `sprint ${last.id} already has a retrospective`,
        "plan the next sprint",
      );
    const newLessons = (input["lessons"] ?? []) as Array<{
      text: string;
      scope: Lesson["scope"];
      suggestedChange?: LessonChange;
    }>;
    const adopt = (input["adopt"] ?? []) as Array<{ id: string; suggestedChange?: LessonChange }>;
    const dismiss = (input["dismiss"] ?? []) as string[];
    const dod = input["dodChanges"] as Policy[] | undefined;
    const refs = [...adopt.map((a) => a.id), ...dismiss];
    const dupe = refs.find((r, i) => refs.indexOf(r) !== i);
    if (dupe)
      fail(
        "invalid-input",
        `lesson "${dupe}" is referenced more than once`,
        "adopt or dismiss each lesson once",
      );
    for (const ref of refs) {
      const l = state.lessons.find((x) => x.id === ref);
      if (!l)
        fail(
          "invalid-input",
          `no lesson "${ref}"`,
          `raised lessons: ${
            state.lessons
              .filter((x) => x.status === "raised")
              .map((x) => x.id)
              .join(", ") || "(none)"
          }`,
        );
      if (l.status !== "raised")
        fail(
          "invalid-input",
          `lesson "${ref}" is already ${l.status}`,
          "only raised lessons can be adopted or dismissed",
        );
    }
    return act(state, "ceremony.retro", input, (s, now) => {
      const adopted: string[] = [];
      const agreements: string[] = [];
      const backlogAdded: string[] = [];
      let dodChanged = false;
      const applyChange = (c: LessonChange | undefined) => {
        if (!c) return;
        if (c.kind === "agreement") {
          if (!s.agreements.includes(c.text)) s = { ...s, agreements: [...s.agreements, c.text] };
          agreements.push(c.text);
        } else if (c.kind === "dod") {
          const cur = configOf(s).definitionOfDone;
          if (!cur.some((p) => JSON.stringify(p) === JSON.stringify(c.policy))) {
            const nextDod = [...cur, c.policy];
            dodChanged = true;
            s = {
              ...s,
              config: { ...configOf(s), definitionOfDone: nextDod },
              stages: s.stages.map((st) =>
                st.id === "review" ? { ...st, exitPolicy: nextDod } : st,
              ),
            };
          }
        } else if (c.kind === "backlog") {
          s = addItem(
            s,
            { ...c.item, stage: "backlog", tags: [...(c.item.tags ?? []), "retro"] },
            input.by,
            now,
          );
          backlogAdded.push(c.item.id);
        }
      };
      for (const l of newLessons) {
        const id = `L${s.lessons.length + 1}`;
        const lesson: Lesson = {
          id,
          at: now,
          text: l.text,
          scope: l.scope,
          status: "adopted",
          from: input.by,
        };
        if (l.suggestedChange) lesson.suggestedChange = l.suggestedChange;
        s = { ...s, lessons: [...s.lessons, lesson] };
        adopted.push(id);
        applyChange(l.suggestedChange);
      }
      for (const a of adopt) {
        s = {
          ...s,
          lessons: s.lessons.map((x) =>
            x.id === a.id
              ? {
                  ...x,
                  status: "adopted" as const,
                  ...(a.suggestedChange ? { suggestedChange: a.suggestedChange } : {}),
                }
              : x,
          ),
        };
        adopted.push(a.id);
        applyChange(a.suggestedChange ?? s.lessons.find((x) => x.id === a.id)?.suggestedChange);
      }
      for (const d of dismiss)
        s = {
          ...s,
          lessons: s.lessons.map((x) => (x.id === d ? { ...x, status: "dismissed" as const } : x)),
        };
      if (dod) {
        dodChanged = true;
        s = {
          ...s,
          config: { ...configOf(s), definitionOfDone: dod },
          stages: s.stages.map((st) => (st.id === "review" ? { ...st, exitPolicy: dod } : st)),
        };
      }
      return appendEvent(
        s,
        "retro",
        input.by,
        {
          sprint: last.id,
          adopted,
          dismissed: dismiss,
          agreements,
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
