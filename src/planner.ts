import { ExFlow, ExFlowRuntimeError, type ExFlowOptions, type ExNode } from "ex-flow";
import { estimateTokens, remaining } from "./budget.ts";
import { fail } from "./errors.ts";
import { authorOf } from "./gates.ts";
import { moveItem, stageOf } from "./items.ts";
import { evaluatePolicies } from "./policies.ts";
import { rolesWith } from "./roles.ts";
import { appendEvent, nowOf } from "./state.ts";
import type { Iteration, Methodology, Role, WorkItem, WorkflowState } from "./types.ts";

type NodeData = { id: string };

export function openIteration(state: WorkflowState): Iteration | undefined {
  return state.iterations.find((it) => it.endedAt === undefined);
}

export function assignRole(state: WorkflowState, item: WorkItem): Role {
  if (item.role) {
    const r = state.roles[item.role];
    if (!r)
      fail(
        "unknown-role",
        `item "${item.id}" is assigned to unknown role "${item.role}"`,
        "editItem with an existing role id",
      );
    return r;
  }
  if (item.status === "review") {
    const author = authorOf(item);
    const reviewers = rolesWith(state, "review").filter((r) => r.id !== author);
    const r = reviewers[0];
    if (!r)
      fail(
        "missing-capability",
        `no role other than "${author ?? "?"}" has capability "review" for item "${item.id}"`,
        "register a second role with capability review",
        { items: [item.id] },
      );
    return r;
  }
  const r = rolesWith(state, "deliver")[0];
  if (!r)
    fail(
      "missing-capability",
      `no role has capability "deliver" for item "${item.id}"`,
      "register a role with capability deliver",
      { items: [item.id] },
    );
  return r;
}

export function resourceCapsFor(state: WorkflowState): Record<string, number> {
  const caps: Record<string, number> = {};
  for (const r of Object.values(state.roles)) {
    if (r.maxConcurrent !== undefined) caps[r.resourceClass ?? r.id] = r.maxConcurrent;
  }
  return caps;
}

export function toExNodes(items: WorkItem[], state: WorkflowState): ExNode<NodeData>[] {
  const present = new Set(items.map((i) => i.id));
  return items.map((i) => {
    const role = assignRole(state, i);
    const node: ExNode<NodeData> = {
      id: i.id,
      data: { id: i.id },
      dependsOn: i.dependsOn.filter((d) => present.has(d)),
      resourceClass: role.resourceClass ?? role.id,
    };
    if (i.priority !== undefined) node.priority = i.priority;
    if (i.weight !== undefined) node.weight = i.weight;
    if (i.deadline !== undefined) node.deadline = Date.parse(i.deadline);
    return node;
  });
}

export interface PlanOptions {
  max?: number;
  now?: string;
  fallbackTokensPerWeight?: number;
}
export type PlanReason = "no-candidates" | "budget-exhausted" | "wip-full";
export interface PlanResult {
  state: WorkflowState;
  dispatched: WorkItem[];
  reason?: PlanReason;
}

export function plan(
  state: WorkflowState,
  methodology: Methodology,
  opts: PlanOptions = {},
): PlanResult {
  const at = nowOf(opts.now);
  // an item may enter the graph only if every dependency is done or is itself a candidate (so ex-flow orders it)
  const all = methodology.candidates(state);
  const candidates = all.filter((i) =>
    i.dependsOn.every((d) => state.items[d]?.status === "done" || all.some((c) => c.id === d)),
  );
  const readyAll = all.filter((i) => i.dependsOn.every((d) => state.items[d]?.status === "done"));
  if (candidates.length === 0) return { state, dispatched: [], reason: "no-candidates" };

  const po = methodology.plannerOptions(state);
  const options: ExFlowOptions<NodeData> = {
    schedulerMode: po.schedulerMode,
    resourceCaps: resourceCapsFor(state),
  };
  if (po.concurrencyCap !== undefined) options.concurrencyCap = po.concurrencyCap;
  if (po.fairnessPolicy !== undefined) options.fairnessPolicy = po.fairnessPolicy;
  if (po.maxDeferralRounds !== undefined) options.maxDeferralRounds = po.maxDeferralRounds;
  if (po.deadlineStrategy !== undefined) options.deadlineStrategy = po.deadlineStrategy;
  if (po.weightStrategy !== undefined) options.weightStrategy = po.weightStrategy;

  let firstBatch: string[];
  let metrics: unknown;
  try {
    const flow = new ExFlow<NodeData>(options);
    for (const n of toExNodes(candidates, state)) flow.addEntity(n);
    const details = flow.resolveExecutionDetails();
    firstBatch = (details.plan.batches[0] ?? []).map((r) => r.id);
    metrics = details.metrics;
  } catch (e) {
    if (e instanceof ExFlowRuntimeError) {
      fail(
        "planner-error",
        `ex-flow refused the graph: [${e.code}] ${e.message}`,
        "fix the item graph (cycles, duplicate ids) with editItem; see diagnostics in the message",
        { items: candidates.map((c) => c.id) },
      );
    }
    throw e;
  }

  // ready = first batch, but only items whose deps are really done (deps inside the batch are impossible by construction)
  const ready = firstBatch
    .map((id) => state.items[id]!)
    .filter((i) => i.dependsOn.every((d) => state.items[d]?.status === "done"));
  const inProgress = Object.values(state.items).filter((i) => i.status === "in_progress");
  const perClass: Record<string, number> = {};
  for (const i of inProgress) {
    const r = i.role ? state.roles[i.role] : undefined;
    const cls = r ? (r.resourceClass ?? r.id) : "?";
    perClass[cls] = (perClass[cls] ?? 0) + 1;
  }
  const caps = resourceCapsFor(state);
  const iteration = openIteration(state);
  let tokensLeft = iteration ? remaining(iteration.budget, iteration.spent).tokens : undefined;
  const limit = Math.min(opts.max ?? Infinity, po.concurrencyCap ?? Infinity);

  const dispatched: WorkItem[] = [];
  let reason: PlanReason | undefined;
  let next = state;
  for (const item of ready) {
    if (dispatched.length >= limit) {
      reason = "wip-full";
      break;
    }
    const target =
      item.status === "todo" && po.dispatchStage !== undefined ? po.dispatchStage : item.stage;
    const stage = stageOf(state, target);
    if (evaluatePolicies(state, item, stage.entryPolicy).length > 0) continue;
    if (
      stage.wipLimit !== undefined &&
      inProgress.filter((i) => i.stage === stage.id).length +
        dispatched.filter((d) => d.stage === stage.id).length >=
        stage.wipLimit
    ) {
      reason = "wip-full";
      continue;
    }
    const role = assignRole(state, item);
    const cls = role.resourceClass ?? role.id;
    if (caps[cls] !== undefined && (perClass[cls] ?? 0) >= caps[cls]!) {
      reason = "wip-full";
      continue;
    }
    if (tokensLeft !== undefined) {
      const est = estimateTokens(state, item.weight, opts.fallbackTokensPerWeight);
      if (est > tokensLeft) {
        reason = "budget-exhausted";
        continue;
      }
      tokensLeft -= est;
    }
    perClass[cls] = (perClass[cls] ?? 0) + 1;
    next = moveItem(next, item.id, { stage: target, status: "in_progress" }, role.id, at);
    next = {
      ...next,
      items: { ...next.items, [item.id]: { ...next.items[item.id]!, role: role.id } },
    };
    dispatched.push(next.items[item.id]!);
  }
  if (reason === undefined && dispatched.length < readyAll.length) reason = "wip-full";
  if (dispatched.length === 0 && reason === undefined) reason = "no-candidates";
  next = appendEvent(
    next,
    "planner.resolved",
    "planner",
    { dispatched: dispatched.map((d) => d.id), reason: reason ?? null, metrics },
    at,
  );
  return reason ? { state: next, dispatched, reason } : { state: next, dispatched };
}
