import type { ErrorCode } from "./types.ts";

export interface WorkflowErrorExtra {
  items?: string[];
  rule?: string;
}

export class WorkflowError extends Error {
  readonly code: ErrorCode;
  readonly fix: string;
  readonly items?: string[];
  readonly rule?: string;

  constructor(code: ErrorCode, message: string, fix: string, extra: WorkflowErrorExtra = {}) {
    if (!fix || fix.trim() === "") throw new TypeError("WorkflowError: fix must not be empty");
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    this.fix = fix;
    if (extra.items) this.items = extra.items;
    if (extra.rule) this.rule = extra.rule;
  }

  toJSON(): { code: ErrorCode; message: string; fix: string; items?: string[]; rule?: string } {
    return {
      code: this.code,
      message: this.message,
      fix: this.fix,
      ...(this.items ? { items: this.items } : {}),
      ...(this.rule ? { rule: this.rule } : {}),
    };
  }
}

export function fail(
  code: ErrorCode,
  message: string,
  fix: string,
  extra?: WorkflowErrorExtra,
): never {
  throw new WorkflowError(code, message, fix, extra);
}

// prototype member names: an id becomes an object key, and `{}` already "has" these
const RESERVED_IDS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "toLocaleString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
]);
// Windows device names, with or without an extension: an id becomes a file name under .workflow/
const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
/** The longest id `assertId` accepts. */
const MAX_ID = 128;

/**
 * Ids become object keys and file names: at most 128 of letters, digits, `.`, `_`, `-`; no `..`,
 * no `Object.prototype` member name, no Windows device name (`CON`, `NUL.txt`, `COM1`, ...).
 */
export function assertId(id: unknown, what: string): void {
  if (
    typeof id !== "string" ||
    id.length > MAX_ID ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) ||
    id.includes("..") ||
    RESERVED_IDS.has(id) ||
    DEVICE.test(id)
  )
    fail(
      "invalid-input",
      `${what} ${JSON.stringify(typeof id === "string" && id.length > MAX_ID ? `${id.slice(0, 57)}...` : id)} is not a valid id`,
      "use at most 128 letters, digits, - _ . (e.g. CART-12), not a reserved name such as toString or CON",
    );
}
