import { fail } from "../errors.ts";
import type { JsonSchema, SchemaError } from "./types.ts";

const DEFS = "#/definitions/";

function kindOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
function isType(t: string, v: unknown): boolean {
  if (t === "integer") return typeof v === "number" && Number.isInteger(v);
  return kindOf(v) === t;
}
function show(v: unknown): string {
  const s = JSON.stringify(v);
  if (s === undefined) return String(v);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}
/** JSON-pointer escaping for one key. */
function esc(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function err(
  path: string,
  keyword: string,
  message: string,
  expected: string,
  found: string,
): SchemaError {
  return { path: path === "" ? "/" : path, keyword, message, expected, found };
}

function resolve(ref: string, root: JsonSchema): JsonSchema {
  if (!ref.startsWith(DEFS))
    fail(
      "invalid-input",
      `schema $ref ${JSON.stringify(ref)} is not #/definitions/<name>`,
      "regenerate the schema with pnpm schema:gen",
    );
  const name = ref.slice(DEFS.length);
  const def =
    root.definitions && Object.hasOwn(root.definitions, name) ? root.definitions[name] : undefined;
  if (!def)
    fail(
      "invalid-input",
      `schema $ref ${JSON.stringify(ref)} names no definition`,
      "regenerate the schema with pnpm schema:gen",
    );
  return def;
}

/** Errors in the branch with the best fit: a const mismatch (a discriminator) weighs 100 plain errors. */
function rank(errors: SchemaError[]): number {
  return errors.reduce((n, e) => n + (e.keyword === "const" ? 100 : 1), 0);
}

/** Validate `value` against `schema`; `$ref`s resolve against `root` (the document). Returns every error found. */
export function validate(
  schema: JsonSchema,
  value: unknown,
  root: JsonSchema = schema,
  path = "",
): SchemaError[] {
  if (schema.$ref !== undefined) return validate(resolve(schema.$ref, root), value, root, path);
  const out: SchemaError[] = [];
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => isType(t, value))) {
      const expected = types.join(" | ");
      return [
        err(path, "type", `expected ${expected}, got ${kindOf(value)}`, expected, show(value)),
      ];
    }
  }
  if (schema.const !== undefined && !same(value, schema.const))
    out.push(err(path, "const", `expected ${show(schema.const)}`, show(schema.const), show(value)));
  if (schema.enum !== undefined && !schema.enum.some((e) => same(e, value))) {
    const expected = schema.enum.map(show).join(" | ");
    out.push(err(path, "enum", `expected one of ${expected}`, expected, show(value)));
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum)
      out.push(
        err(path, "minimum", `expected >= ${schema.minimum}`, `>= ${schema.minimum}`, show(value)),
      );
    if (schema.maximum !== undefined && value > schema.maximum)
      out.push(
        err(path, "maximum", `expected <= ${schema.maximum}`, `<= ${schema.maximum}`, show(value)),
      );
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      out.push(
        err(
          path,
          "minLength",
          `expected at least ${schema.minLength} characters`,
          `length >= ${schema.minLength}`,
          show(value),
        ),
      );
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value))
      out.push(
        err(
          path,
          "pattern",
          `expected to match /${schema.pattern}/`,
          `/${schema.pattern}/`,
          show(value),
        ),
      );
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    const items = schema.items;
    value.forEach((v, i) => out.push(...validate(items, v, root, `${path}/${i}`)));
  }
  if (kindOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    for (const [key, v] of Object.entries(obj)) {
      const prop =
        schema.properties && Object.hasOwn(schema.properties, key)
          ? schema.properties[key]
          : undefined;
      const at = `${path}/${esc(key)}`;
      if (prop) out.push(...validate(prop, v, root, at));
      else if (schema.additionalProperties === false) {
        const known = Object.keys(schema.properties ?? {}).join(", ");
        out.push(
          err(
            at,
            "additionalProperties",
            `unknown property ${JSON.stringify(key)}`,
            known ? `one of ${known}` : "no properties",
            key,
          ),
        );
      } else if (typeof schema.additionalProperties === "object")
        out.push(...validate(schema.additionalProperties, v, root, at));
    }
    for (const key of schema.required ?? [])
      if (!Object.hasOwn(obj, key))
        out.push(
          err(
            `${path}/${esc(key)}`,
            "required",
            `missing required property ${JSON.stringify(key)}`,
            "present",
            "absent",
          ),
        );
  }
  if (schema.anyOf !== undefined) {
    let best: SchemaError[] | undefined;
    for (const branch of schema.anyOf) {
      const errors = validate(branch, value, root, path);
      if (errors.length === 0) {
        best = [];
        break;
      }
      if (best === undefined || rank(errors) < rank(best)) best = errors;
    }
    if (best) out.push(...best);
  }
  return out;
}

/** Throw WorkflowError("invalid-input") describing the first problem when `value` does not match `schema`. */
export function assertValid(schema: JsonSchema, value: unknown, what: string): void {
  const errors = validate(schema, value);
  const first = errors[0];
  if (!first) return;
  const more = errors.length > 1 ? ` (+${errors.length - 1} more)` : "";
  fail(
    "invalid-input",
    `${what} does not match its schema: ${first.path} ${first.message}${more}`,
    `fix ${what} at ${first.path}: expected ${first.expected}, found ${first.found}`,
  );
}
