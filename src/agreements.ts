import { fail } from "./errors.ts";
import { appendEvent } from "./state.ts";
import type { WorkflowState } from "./types.ts";

const listed = (s: WorkflowState) =>
  s.agreements.length === 0 ? "(none)" : s.agreements.map((a) => `"${a}"`).join(", ");

function absent(s: WorkflowState, text: unknown, what: string): never {
  return fail(
    "invalid-input",
    `no working agreement ${JSON.stringify(text)} to ${what}`,
    `current agreements: ${listed(s)}; name one of them exactly`,
  );
}

/** Adds an agreement (idempotent); with `replaces`, retires that one in the same step. */
export function applyAgreement(
  state: WorkflowState,
  change: { text: string; replaces?: string },
  by: string,
  now: string,
): WorkflowState {
  if (change.replaces === change.text) return state;
  let s = state;
  if (change.replaces !== undefined) {
    if (typeof change.replaces !== "string" || !s.agreements.includes(change.replaces))
      absent(s, change.replaces, "replace");
    s = { ...s, agreements: s.agreements.filter((a) => a !== change.replaces) };
    s = appendEvent(
      s,
      "agreement.retired",
      by,
      { text: change.replaces, replacedBy: change.text },
      now,
    );
  }
  if (!s.agreements.includes(change.text)) s = { ...s, agreements: [...s.agreements, change.text] };
  return s;
}

/** Removes an agreement and records why it left (replacedBy null). */
export function retireAgreement(
  state: WorkflowState,
  text: string,
  by: string,
  now: string,
): WorkflowState {
  if (typeof text !== "string" || !state.agreements.includes(text)) absent(state, text, "retire");
  const s = { ...state, agreements: state.agreements.filter((a) => a !== text) };
  return appendEvent(s, "agreement.retired", by, { text, replacedBy: null }, now);
}
