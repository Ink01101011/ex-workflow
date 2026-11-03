// Schema roots for scripts/gen-schema.mjs. ts-json-schema-generator does not take a generic
// interface as a root type, so the state document is generated through this alias of the default
// instantiation, WorkflowState<MethodologyName>; gen-schema drops the alias's own $ref entry.
import type { WorkflowState } from "../src/core/types.ts";
export type WorkflowStateRoot = WorkflowState;
