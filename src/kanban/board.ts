import { timSort } from "exsorted";
import type { ItemStatus, WorkItem, WorkflowState } from "../types.ts";
import { ACTIVE, enteredStageAt } from "./columns.ts";
import { configOf, KANBAN_CADENCES, type KanbanCadence } from "./config.ts";

export interface BoardCard {
  id: string;
  title: string;
  type: string;
  status: ItemStatus;
  classOfService: string;
  role: string | null;
  ageMs: number;
  blocked: boolean;
  deadline: string | null;
}
export interface BoardColumn {
  id: string;
  name: string;
  wipLimit: number | null;
  active: number;
  queued: number;
  overLimit: boolean;
  commitmentPoint: boolean;
  deliveryPoint: boolean;
  cards: BoardCard[];
}

/** Time the item was added (its item.added event), else the first event's time. */
export function addedAt(state: WorkflowState, id: string): string {
  const ev = state.events.find(
    (e) => e.type === "item.added" && (e.payload as { id: string }).id === id,
  );
  return ev?.at ?? state.events[0]!.at;
}

export function cardAge(state: WorkflowState, item: WorkItem, now: string): number {
  return Date.parse(now) - Date.parse(enteredStageAt(item) ?? addedAt(state, item.id));
}

export function board(state: WorkflowState, now: string): BoardColumn[] {
  return state.stages.map((st) => {
    const here = Object.values(state.items).filter(
      (i) => i.stage === st.id && i.status !== "dropped",
    );
    const cards: BoardCard[] = timSort(
      here.map((i) => ({
        id: i.id,
        title: i.title,
        type: i.type,
        status: i.status,
        classOfService: i.classOfService ?? "standard",
        role: i.role ?? null,
        ageMs: cardAge(state, i, now),
        blocked: i.blockers.some((b) => !b.clearedAt),
        deadline: i.deadline ?? null,
      })),
      (a, b) => b.ageMs - a.ageMs || (a.id < b.id ? -1 : 1),
    );
    const active = cards.filter((c) => ACTIVE.has(c.status)).length;
    const queued = cards.filter((c) => c.status === "todo" || c.status === "review").length;
    return {
      id: st.id,
      name: st.name,
      wipLimit: st.wipLimit ?? null,
      active,
      queued,
      overLimit: st.wipLimit !== undefined && active > st.wipLimit,
      commitmentPoint: st.commitmentPoint === true,
      deliveryPoint: st.deliveryPoint === true,
      cards,
    };
  });
}

export const CADENCE_EVENT = (c: KanbanCadence): string => `cadence.${c}`;

export interface CadenceStatus {
  cadence: KanbanCadence;
  everyTurns: number | null;
  lastAt: string | null;
  turnsSince: number;
  due: boolean;
}

export function cadencesDue(state: WorkflowState): CadenceStatus[] {
  const cfg = configOf(state);
  return KANBAN_CADENCES.map((c) => {
    let lastSeq = 0;
    let lastAt: string | null = null;
    for (const e of state.events) {
      if (e.type === CADENCE_EVENT(c)) {
        lastSeq = e.seq;
        lastAt = e.at;
      }
    }
    const turnsSince = state.events.filter(
      (e) => e.type === "item.completed" && e.seq > lastSeq,
    ).length;
    const everyTurns = cfg.cadences[c]?.everyTurns ?? null;
    return {
      cadence: c,
      everyTurns,
      lastAt,
      turnsSince,
      due: everyTurns !== null && turnsSince >= everyTurns,
    };
  });
}
