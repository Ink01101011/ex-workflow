import { assertId, fail } from "../errors.ts";
import { appendEvent } from "../state.ts";
import type { ItemPatch, NewItem, WorkItem, WorkflowState } from "../types.ts";
import { stageOf } from "./stage.ts";

export type { ItemPatch };

export function putItem<N extends string>(
  state: WorkflowState<N>,
  item: WorkItem,
): WorkflowState<N> {
  return { ...state, items: { ...state.items, [item.id]: item } };
}

/** Replace one item with `fn(item)`; no event. */
export function patchItem<N extends string>(
  state: WorkflowState<N>,
  id: string,
  fn: (item: WorkItem) => WorkItem,
): WorkflowState<N> {
  return putItem(state, fn(getItem(state, id)));
}

export function getItem(state: WorkflowState<string>, id: string): WorkItem {
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

function assertKnownItems(state: WorkflowState<string>, ids: string[], what: string): void {
  const missing = ids.filter((d) => !Object.hasOwn(state.items, d));
  if (missing.length)
    fail(
      "unknown-item",
      `${what} refers to unknown item(s) ${missing.join(", ")}`,
      "add those items first or remove the reference",
      { items: missing },
    );
}

export function addItem<N extends string>(
  state: WorkflowState<N>,
  input: NewItem,
  by: string,
  now?: string,
): WorkflowState<N> {
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

export function editItem<N extends string>(
  state: WorkflowState<N>,
  id: string,
  patch: ItemPatch,
  by: string,
  now?: string,
): WorkflowState<N> {
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
