import { fail } from "./errors.ts";
import { appendEvent, nowOf } from "./state.ts";
import type {
  Evidence,
  ItemStatus,
  NewItem,
  Stage,
  Transition,
  WorkItem,
  WorkflowState,
} from "./types.ts";

export function stageOf(state: WorkflowState, stageId: string): Stage {
  const st = state.stages.find((s) => s.id === stageId);
  if (!st)
    fail(
      "unknown-stage",
      `stage "${stageId}" does not exist`,
      `stages are: ${state.stages.map((s) => s.id).join(" → ")}`,
    );
  return st;
}

export function nextStageOf(state: WorkflowState, stageId: string): Stage | undefined {
  const idx = state.stages.findIndex((s) => s.id === stageId);
  if (idx < 0) stageOf(state, stageId);
  return state.stages[idx + 1];
}

export function isTerminalStage(state: WorkflowState, stageId: string): boolean {
  return state.stages[state.stages.length - 1]?.id === stageId;
}

export function getItem(state: WorkflowState, id: string): WorkItem {
  const it = state.items[id];
  if (!it)
    fail(
      "unknown-item",
      `item "${id}" does not exist`,
      `add it with addItem first; known items: ${Object.keys(state.items).join(", ") || "(none)"}`,
      { items: [id] },
    );
  return it;
}

function assertKnownItems(state: WorkflowState, ids: string[], what: string): void {
  const missing = ids.filter((d) => !state.items[d]);
  if (missing.length)
    fail(
      "unknown-item",
      `${what} refers to unknown item(s) ${missing.join(", ")}`,
      "add those items first or remove the reference",
      { items: missing },
    );
}

export function addItem(
  state: WorkflowState,
  input: NewItem,
  by: string,
  now?: string,
): WorkflowState {
  if (state.items[input.id])
    fail(
      "duplicate-item",
      `item "${input.id}" already exists`,
      "use editItem to change it, or pick a new id",
      { items: [input.id] },
    );
  const firstStage = state.stages[0];
  if (!firstStage)
    fail("config-invalid", "state has no stages", "create the state with at least one stage");
  const stageId = input.stage ?? firstStage.id;
  stageOf(state, stageId);
  assertKnownItems(state, input.dependsOn ?? [], `item "${input.id}".dependsOn`);
  if (input.affects) assertKnownItems(state, input.affects, `item "${input.id}".affects`);
  if (input.parent !== undefined)
    assertKnownItems(state, [input.parent], `item "${input.id}".parent`);
  if (input.role !== undefined && !state.roles[input.role])
    fail(
      "unknown-role",
      `role "${input.role}" does not exist`,
      `registered roles: ${Object.keys(state.roles).join(", ")}`,
    );

  const { stage: _s, ...rest } = input;
  const item: WorkItem = {
    type: "task",
    acceptance: [],
    dependsOn: [],
    ...rest,
    id: input.id,
    title: input.title,
    stage: stageId,
    status: "todo",
    evidence: [],
    blockers: [],
    transitions: [],
  };
  const next = { ...state, items: { ...state.items, [item.id]: item } };
  return appendEvent(
    next,
    "item.added",
    by,
    {
      id: item.id,
      type: item.type,
      stage: item.stage,
      weight: item.weight ?? null,
      priority: item.priority ?? null,
    },
    now,
  );
}

export type ItemPatch = Partial<
  Omit<WorkItem, "id" | "stage" | "status" | "transitions" | "evidence" | "blockers">
>;

export function editItem(
  state: WorkflowState,
  id: string,
  patch: ItemPatch,
  by: string,
  now?: string,
): WorkflowState {
  const item = getItem(state, id);
  if (patch.dependsOn) assertKnownItems(state, patch.dependsOn, `item "${id}".dependsOn`);
  if (patch.affects) assertKnownItems(state, patch.affects, `item "${id}".affects`);
  if (patch.parent !== undefined) assertKnownItems(state, [patch.parent], `item "${id}".parent`);
  if (patch.role !== undefined && !state.roles[patch.role])
    fail(
      "unknown-role",
      `role "${patch.role}" does not exist`,
      `registered roles: ${Object.keys(state.roles).join(", ")}`,
    );
  const changed = (Object.keys(patch) as Array<keyof ItemPatch>).filter(
    (k) => JSON.stringify(patch[k]) !== JSON.stringify(item[k]),
  );
  if (changed.length === 0)
    fail(
      "no-op",
      `editItem("${id}") changes nothing`,
      "pass at least one field with a different value",
      { items: [id] },
    );
  const updated: WorkItem = { ...item };
  for (const k of changed) (updated as unknown as Record<string, unknown>)[k] = patch[k];
  const next = { ...state, items: { ...state.items, [id]: updated } };
  return appendEvent(next, "item.edited", by, { id, changed }, now);
}

export function moveItem(
  state: WorkflowState,
  id: string,
  to: { stage?: string; status: ItemStatus },
  by: string,
  now?: string,
): WorkflowState {
  const item = getItem(state, id);
  const toStage = to.stage ?? item.stage;
  stageOf(state, toStage);
  if (item.status === "done" || item.status === "dropped") {
    fail(
      "invalid-transition",
      `item "${id}" is ${item.status} and cannot move`,
      "create a new item (or a change-request) instead of reopening a finished one",
      { items: [id] },
    );
  }
  if (toStage === item.stage && to.status === item.status)
    fail(
      "no-op",
      `item "${id}" is already ${item.status} in "${toStage}"`,
      "choose a different stage or status",
      { items: [id] },
    );
  const at = nowOf(now);
  const updated: WorkItem = {
    ...item,
    stage: toStage,
    status: to.status,
    transitions: [
      ...item.transitions,
      {
        from: { stage: item.stage, status: item.status },
        to: { stage: toStage, status: to.status },
        at,
        by,
      },
    ],
  };
  const next = { ...state, items: { ...state.items, [id]: updated } };
  return appendEvent(
    next,
    "item.transition",
    by,
    {
      id,
      from: { stage: item.stage, status: item.status },
      to: { stage: toStage, status: to.status },
    },
    at,
  );
}

export function addEvidence(
  state: WorkflowState,
  id: string,
  evidence: Omit<Evidence, "at">,
  now?: string,
): WorkflowState {
  const item = getItem(state, id);
  const at = nowOf(now);
  const updated: WorkItem = { ...item, evidence: [...item.evidence, { ...evidence, at }] };
  const next = { ...state, items: { ...state.items, [id]: updated } };
  return appendEvent(
    next,
    "item.evidence",
    evidence.by,
    { id, kind: evidence.kind, ref: evidence.ref },
    at,
  );
}

export function raiseBlocker(
  state: WorkflowState,
  id: string,
  reason: string,
  owner: string,
  by: string,
  now?: string,
): WorkflowState {
  const item = getItem(state, id);
  const at = nowOf(now);
  const blockerId = `${id}-b${item.blockers.length + 1}`;
  const updated: WorkItem = {
    ...item,
    status: "blocked",
    blockers: [...item.blockers, { id: blockerId, reason, owner, raisedAt: at }],
    transitions:
      item.status === "blocked"
        ? item.transitions
        : [
            ...item.transitions,
            {
              from: { stage: item.stage, status: item.status },
              to: { stage: item.stage, status: "blocked" },
              at,
              by,
            },
          ],
  };
  const next = { ...state, items: { ...state.items, [id]: updated } };
  return appendEvent(next, "blocker.raised", by, { id, blocker: blockerId, reason, owner }, at);
}

function lastTransitionTo(item: WorkItem, status: ItemStatus): Transition | undefined {
  for (let i = item.transitions.length - 1; i >= 0; i--) {
    const t = item.transitions[i]!;
    if (t.to.status === status) return t;
  }
  return undefined;
}

export function clearBlocker(
  state: WorkflowState,
  id: string,
  blockerId: string,
  by: string,
  now?: string,
): WorkflowState {
  const item = getItem(state, id);
  const idx = item.blockers.findIndex((b) => b.id === blockerId && !b.clearedAt);
  if (idx < 0)
    fail(
      "invalid-input",
      `item "${id}" has no open blocker "${blockerId}"`,
      `open blockers: ${
        item.blockers
          .filter((b) => !b.clearedAt)
          .map((b) => b.id)
          .join(", ") || "(none)"
      }`,
      { items: [id] },
    );
  const at = nowOf(now);
  const blockers = item.blockers.map((b, i) => (i === idx ? { ...b, clearedAt: at } : b));
  const stillBlocked = blockers.some((b) => !b.clearedAt);
  const prev = lastTransitionTo(item, "blocked")?.from.status ?? "todo";
  let toStage = item.stage;
  let toStatus: ItemStatus = prev;
  if (prev === "in_progress") {
    toStatus = "todo";
    toStage = lastTransitionTo(item, "in_progress")?.from.stage ?? item.stage;
  }
  const updated: WorkItem = {
    ...item,
    blockers,
    stage: stillBlocked ? item.stage : toStage,
    status: stillBlocked ? "blocked" : toStatus,
    transitions: stillBlocked
      ? item.transitions
      : [
          ...item.transitions,
          {
            from: { stage: item.stage, status: "blocked" },
            to: { stage: toStage, status: toStatus },
            at,
            by,
          },
        ],
  };
  const next = { ...state, items: { ...state.items, [id]: updated } };
  return appendEvent(next, "blocker.cleared", by, { id, blocker: blockerId }, at);
}
