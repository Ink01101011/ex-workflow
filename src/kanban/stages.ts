import type { Stage } from "../types.ts";
import type { KanbanConfig } from "./config.ts";

export function kanbanStages(config: KanbanConfig): Stage[] {
  return config.columns.map((c) => {
    const st: Stage = { id: c.id, name: c.name, entryPolicy: [], exitPolicy: c.policies };
    if (c.wipLimit !== undefined) st.wipLimit = c.wipLimit;
    if (c.commitmentPoint) st.commitmentPoint = true;
    if (c.deliveryPoint) st.deliveryPoint = true;
    if (c.review) st.review = true;
    return st;
  });
}
