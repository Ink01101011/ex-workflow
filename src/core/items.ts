import { assertId, fail } from "./errors.ts";
import type { ItemPatch } from "./types.ts";

export { assertId };
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

function putItem(state: WorkflowState, item: WorkItem): WorkflowState {
  return { ...state, items: { ...state.items, [item.id]: item } };
}

/** Replace one item with `fn(item)`; no event. */
export function patchItem(
  state: WorkflowState,
  id: string,
  fn: (item: WorkItem) => WorkItem,
): WorkflowState {
  return putItem(state, fn(getItem(state, id)));
}

/** Drop optional fields (iteration, role, ...) from one item; no event. */
export function stripItemFields(
  state: WorkflowState,
  id: string,
  keys: Array<"iteration" | "role">,
): WorkflowState {
  return patchItem(state, id, (item) => {
    const copy = { ...item };
    for (const k of keys) delete copy[k];
    return copy;
  });
}

export function getItem(state: WorkflowState, id: string): WorkItem {
  const it = Object.hasOwn(state.items, id) ? state.items[id] : undefined;
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
  const missing = ids.filter((d) => !Object.hasOwn(state.items, d));
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
  assertId(input.id, "item id");
  if (Object.hasOwn(state.items, input.id))
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
  if (input.role !== undefined && !Object.hasOwn(state.roles, input.role))
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
  const next = putItem(state, item);
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
      phase: item.phase ?? null,
      parent: item.parent ?? null,
    },
    now,
  );
}

export type { ItemPatch } from "./types.ts";

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
  if (patch.role !== undefined && !Object.hasOwn(state.roles, patch.role))
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
  const next = putItem(state, updated);
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
  const next = putItem(state, updated);
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

/** Evidence recorded at or after the item's last `item.rework` event; evidence stays stored, but earlier entries no longer count toward policies or gates. Never-reworked items keep all evidence. */
export function freshEvidence(state: WorkflowState, item: WorkItem): Evidence[] {
  // Event order, not timestamps: evidence recorded by an item.evidence event AFTER the item's last
  // item.rework event is fresh. Evidence entries are appended in the same order as those events, so
  // the fresh entries are the last `after` ones. Evidence attached by the rework completion itself
  // precedes its item.rework event and therefore does not count.
  let after = 0;
  let found = false;
  for (let i = state.events.length - 1; i >= 0; i--) {
    const ev = state.events[i]!;
    if ((ev.payload as { id?: string } | null)?.id !== item.id) continue;
    if (ev.type === "item.rework") {
      found = true;
      break;
    }
    if (ev.type === "item.evidence") after++;
  }
  return found ? item.evidence.slice(Math.max(0, item.evidence.length - after)) : item.evidence;
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
  const next = putItem(state, updated);
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
  const t: Transition | null =
    item.status === "blocked"
      ? null
      : {
          from: { stage: item.stage, status: item.status },
          to: { stage: item.stage, status: "blocked" },
          at,
          by,
        };
  const updated: WorkItem = {
    ...item,
    status: "blocked",
    blockers: [...item.blockers, { id: blockerId, reason, owner, raisedAt: at }],
    transitions: t ? [...item.transitions, t] : item.transitions,
  };
  const next = putItem(state, updated);
  return appendEvent(
    next,
    "blocker.raised",
    by,
    { id, blocker: blockerId, reason, owner, transition: t && { from: t.from, to: t.to } },
    at,
  );
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
  note?: string,
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
  let dropRole = false;
  if (prev === "in_progress") {
    toStatus = "todo";
    toStage = lastTransitionTo(item, "in_progress")?.from.stage ?? item.stage;
  } else if (prev === "awaiting_human") {
    // a rejected human gate: the work is re-dispatched in the current stage
    toStatus = stageOf(state, item.stage).review ? "review" : "todo";
    dropRole = true;
  }
  const { role: _r, ...noRole } = item;
  const t: Transition | null = stillBlocked
    ? null
    : {
        from: { stage: item.stage, status: "blocked" },
        to: { stage: toStage, status: toStatus },
        at,
        by,
      };
  const updated: WorkItem = {
    ...(dropRole && !stillBlocked ? (noRole as WorkItem) : item),
    blockers,
    stage: stillBlocked ? item.stage : toStage,
    status: stillBlocked ? "blocked" : toStatus,
    transitions: t ? [...item.transitions, t] : item.transitions,
  };
  const next = putItem(state, updated);
  return appendEvent(
    next,
    "blocker.cleared",
    by,
    { id, blocker: blockerId, transition: t && { from: t.from, to: t.to }, note: note ?? null },
    at,
  );
}

/** Entering a new stage is a new assignment: the role that finished the previous stage is cleared so the planner picks the right one (a reviewer, not the author). */
export function clearRole(state: WorkflowState, itemId: string): WorkflowState {
  return stripItemFields(state, itemId, ["role"]);
}

/** Move an item to the next stage (done at the end, review/todo otherwise) and clear its role. */
export function advanceItem(
  state: WorkflowState,
  itemId: string,
  by: string,
  wantsReview: boolean,
  now: string,
): WorkflowState {
  const item = getItem(state, itemId);
  const to = nextStageOf(state, item.stage);
  if (!to) return moveItem(state, itemId, { status: "done" }, by, now);
  if (isTerminalStage(state, to.id))
    return moveItem(state, itemId, { stage: to.id, status: "done" }, by, now);
  const status = wantsReview || to.review === true ? "review" : "todo";
  return clearRole(moveItem(state, itemId, { stage: to.id, status }, by, now), itemId);
}
