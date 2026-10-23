/** The JSON Schema (draft-07) subset ts-json-schema-generator emits for our types and the validator understands. */
export interface JsonSchema {
  $schema?: string;
  $ref?: string;
  definitions?: Record<string, JsonSchema>;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  pattern?: string;
  description?: string;
}

/** A self-contained document: the root points into its own definitions. */
export interface JsonSchemaDocument extends JsonSchema {
  $schema: string;
  $ref: string;
  definitions: Record<string, JsonSchema>;
}

export interface SchemaError {
  /** JSON pointer to the offending value ("/" for the root) */
  path: string;
  /** which keyword failed: type, const, enum, required, additionalProperties, minimum, maximum, minLength, pattern */
  keyword: string;
  message: string;
  expected: string;
  found: string;
}
