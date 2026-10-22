import type { ClassOfService, Event, ItemStatus } from "../types.ts";

export interface Stay {
  stage: string;
  enteredAt: string;
  leftAt?: string;
}
export interface ReplayedItem {
  id: string;
  /** item type from item.added; "question" items are escalations, not deliveries */
  type: string;
  stage: string;
  status: ItemStatus;
  /** one entry per contiguous visit to a column; status changes inside a column do not end a stay */
  stays: Stay[];
  /** first entry into the commitment column */
  committedAt?: string;
  /** first entry into the delivery column */
  deliveredAt?: string;
  /** from the replenishment payload; "standard" when never replenished */
  classOfService: ClassOfService;
  deadline?: string;
  /** closed in_progress intervals */
  activeMs: number;
  /** closed blocked intervals */
  blockedMs: number;
  /** the open status interval */
  since: { status: ItemStatus; at: string };
}
export interface ReplayedBlocker {
  item: string;
  blocker: string;
  raisedAt: string;
  clearedAt?: string;
}
export interface Replay {
  items: Map<string, ReplayedItem>;
  blockers: ReplayedBlocker[];
  /** time of the last event: the clock every "still open" measurement uses */
  lastAt: string;
}

const ms = (from: string, to: string) => Date.parse(to) - Date.parse(from);

const carried = (p: Record<string, unknown>) =>
  (p["transition"] ?? null) as { to: { stage: string; status: ItemStatus } } | null;

export function replay(events: Event[], commitment: string, delivery: string): Replay {
  const items = new Map<string, ReplayedItem>();
  const blockers: ReplayedBlocker[] = [];
  let lastAt = events[0]?.at ?? "1970-01-01T00:00:00.000Z";
  const stamp = (it: ReplayedItem, stage: string, at: string) => {
    if (stage === commitment && it.committedAt === undefined) it.committedAt = at;
    if (stage === delivery && it.deliveredAt === undefined) it.deliveredAt = at;
  };
  /** the one place a transition (from item.transition or carried by a blocker event) is applied */
  const applyTransition = (
    it: ReplayedItem,
    to: { stage: string; status: ItemStatus },
    at: string,
  ) => {
    if (it.since.status === "in_progress") it.activeMs += ms(it.since.at, at);
    if (it.since.status === "blocked") it.blockedMs += ms(it.since.at, at);
    it.since = { status: to.status, at };
    if (to.stage !== it.stage) {
      it.stays[it.stays.length - 1]!.leftAt = at;
      it.stays.push({ stage: to.stage, enteredAt: at });
      stamp(it, to.stage, at);
    }
    it.stage = to.stage;
    it.status = to.status;
  };
  for (const ev of events) {
    lastAt = ev.at;
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    switch (ev.type) {
      case "item.added": {
        const id = p["id"] as string;
        const stage = p["stage"] as string;
        const it: ReplayedItem = {
          id,
          type: typeof p["type"] === "string" ? p["type"] : "task",
          stage,
          status: "todo",
          stays: [{ stage, enteredAt: ev.at }],
          classOfService: "standard",
          activeMs: 0,
          blockedMs: 0,
          since: { status: "todo", at: ev.at },
        };
        stamp(it, stage, ev.at);
        items.set(id, it);
        break;
      }
      case "item.transition": {
        const it = items.get(p["id"] as string);
        if (!it) break;
        applyTransition(it, p["to"] as { stage: string; status: ItemStatus }, ev.at);
        break;
      }
      case "cadence.replenishment": {
        const list = (p["items"] ?? []) as Array<{
          id: string;
          classOfService: ClassOfService;
          deadline: string | null;
        }>;
        for (const c of list) {
          const it = items.get(c.id);
          if (!it) continue;
          it.classOfService = c.classOfService;
          if (c.deadline) it.deadline = c.deadline;
          else delete it.deadline;
        }
        break;
      }
      case "blocker.raised": {
        blockers.push({
          item: p["id"] as string,
          blocker: p["blocker"] as string,
          raisedAt: ev.at,
        });
        const it = items.get(p["id"] as string);
        const t = carried(p);
        if (it && t) applyTransition(it, t.to, ev.at);
        break;
      }
      case "blocker.cleared": {
        const b = blockers.find(
          (x) => x.item === p["id"] && x.blocker === p["blocker"] && x.clearedAt === undefined,
        );
        if (b) b.clearedAt = ev.at;
        const it = items.get(p["id"] as string);
        const t = carried(p);
        if (it && t) applyTransition(it, t.to, ev.at);
        break;
      }
      default:
        break;
    }
  }
  return { items, blockers, lastAt };
}
