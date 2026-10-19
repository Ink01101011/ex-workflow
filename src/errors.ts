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

const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);

/** Ids become object keys and file names: letters, digits, `.`, `_`, `-`; no `..`, no prototype names. */
export function assertId(id: unknown, what: string): void {
  if (
    typeof id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) ||
    id.includes("..") ||
    RESERVED_IDS.has(id)
  )
    fail(
      "invalid-input",
      `${what} ${JSON.stringify(id)} is not a valid id`,
      "use letters, digits, - _ . (e.g. CART-12)",
    );
}
