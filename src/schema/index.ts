import {
  CORE_DEFINITIONS,
  KANBAN_DEFINITIONS,
  SCRUM_DEFINITIONS,
  WATERFALL_DEFINITIONS,
} from "./generated.ts";
import type { JsonSchema, JsonSchemaDocument } from "./types.ts";

export const DRAFT_07 = "http://json-schema.org/draft-07/schema#";

function document(name: string, definitions: Record<string, JsonSchema>): JsonSchemaDocument {
  return { $schema: DRAFT_07, $ref: `#/definitions/${name}`, definitions };
}

/** `.workflow/state.json` */
export const workflowStateSchema = document("WorkflowState", CORE_DEFINITIONS);
/** a role manifest (`.workflow/roles/*.json`, `exwf role add`) */
export const roleSchema = document("Role", CORE_DEFINITIONS);
/** `exwf add <item.json>` */
export const newItemSchema = document("NewItem", CORE_DEFINITIONS);
/** `exwf complete <id> <handoff.json>` */
export const handoffSchema = document("Handoff", CORE_DEFINITIONS);
/** `exwf init scrum --config` / the scrum-master policy.json */
export const scrumConfigSchema = document("ScrumConfig", SCRUM_DEFINITIONS);
export const kanbanConfigSchema = document("KanbanConfig", KANBAN_DEFINITIONS);
export const waterfallConfigSchema = document("WaterfallConfig", WATERFALL_DEFINITIONS);

export { validate, assertValid } from "./validate.ts";
export type { JsonSchema, JsonSchemaDocument, SchemaError } from "./types.ts";
