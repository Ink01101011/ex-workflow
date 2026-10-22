import type { Stage } from "../types.ts";
import type { KanbanConfig } from "./config.ts";

export function kanbanStages(config: KanbanConfig): Stage[] {
  const stages = config.columns.map((c) => {
    const st: Stage = { id: c.id, name: c.name, entryPolicy: [], exitPolicy: c.policies };
    if (c.wipLimit !== undefined) st.wipLimit = c.wipLimit;
    if (c.commitmentPoint) st.commitmentPoint = true;
    if (c.deliveryPoint) st.deliveryPoint = true;
    if (c.review) st.review = true;
    return st;
  });
  // the commitment column's policies also gate the pull out of it: the next column's entry policy
  const at = stages.findIndex((s) => s.commitmentPoint);
  const after = at >= 0 ? stages[at + 1] : undefined;
  if (after) after.entryPolicy = stages[at]!.exitPolicy;
  return stages;
}
