// Context snapshots (design spec section 27, #36): what a scout verified about the repository
// before an item is worked, as evidence `context-snapshot`, and whether a later `repo.changed`
// event made it stale. Event order decides, never timestamps (principle 5); no file is read.
import { fail } from "../../core/errors.ts";
import { addEvidence } from "../../core/items/evidence.ts";
import { getItem } from "../../core/items/record.ts";
import { applyAction } from "../../core/methodology.ts";
import type {
  ApplyResult,
  BriefContext,
  ContextAssumption,
  ContextSnapshotData,
  Methodology,
  WorkItem,
  WorkflowState,
} from "../../core/types.ts";
import { eventIndex, firstAfter, sinceRework } from "../../core/event-index.ts";
import { workersOf } from "../workers.ts";

export interface ContextSnapshotInput {
  item: string;
  /** The repository revision the snapshot was taken at. */
  revision: string;
  assumptions: ContextAssumption[];
  /** The host's snapshot artifact. */
  ref: string;
  /** Who recorded it: `human` or a registered role that did not work on the item. */
  by: string;
  now?: string;
}

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const nonEmpty = (x: unknown): x is string => typeof x === "string" && x.trim() !== "";
const extra = (o: Record<string, unknown>, keys: string[]) =>
  Object.keys(o).find((k) => !keys.includes(k));

/** True for a C0 or C1 control character or a bidirectional formatting character. */
function hidden(c: number): boolean {
  return (
    c < 0x20 ||
    (c >= 0x7f && c <= 0x9f) ||
    c === 0x61c ||
    c === 0x200e ||
    c === 0x200f ||
    (c >= 0x202a && c <= 0x202e) ||
    (c >= 0x2066 && c <= 0x2069)
  );
}

/**
 * Why `path` is not a repository-relative POSIX path as Git lists it, or `undefined` when it is:
 * no leading `/`, `./` or drive letter, `/` separators only, no empty, `.` or `..` segment, at most
 * 4096 characters, Unicode NFC, no control or bidirectional formatting character and no leading or
 * trailing whitespace (F1 G2-8, G4-4). Paths are compared exactly (case included), so the recorders
 * accept one spelling per file.
 */
export function repoPathIssue(path: unknown): string | undefined {
  const why =
    typeof path !== "string"
      ? "not a string"
      : path.length > 4096
        ? "longer than 4096 characters"
        : [...path].some((ch) => hidden(ch.codePointAt(0)!))
          ? "has a control or bidirectional formatting character"
          : path !== path.trim()
            ? "has leading or trailing whitespace"
            : path !== path.normalize("NFC")
              ? "is not Unicode NFC"
              : path.includes("\\") ||
                  /^[A-Za-z]:/.test(path) ||
                  !path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..")
                ? "is not relative with / separators and no empty, . or .. segment"
                : undefined;
  if (!why) return undefined;
  const shown = JSON.stringify(
    typeof path === "string" && path.length > 80 ? `${path.slice(0, 80)}…` : path,
  );
  return `${shown} is not a repository-relative POSIX path (${why})`;
}

/** Why `data` is not a well-formed `ContextSnapshotData` (closed objects), or `undefined`. */
function snapshotIssue(data: unknown): string | undefined {
  if (!isObj(data)) return "data must be an object";
  const k = extra(data, ["revision", "assumptions"]);
  if (k) return `unknown key "${k}"`;
  if (!nonEmpty(data["revision"])) return "revision must be a non-empty string";
  const list = data["assumptions"];
  if (!Array.isArray(list)) return "assumptions must be an array";
  for (const [i, a] of list.entries()) {
    const at = `assumptions[${i}]`;
    if (!isObj(a)) return `${at} must be an object`;
    const ka = extra(a, ["claim", "required", "source"]);
    if (ka) return `unknown key "${ka}" in ${at}`;
    if (!nonEmpty(a["claim"])) return `${at}.claim must be a non-empty string`;
    if (a["required"] !== undefined && typeof a["required"] !== "boolean")
      return `${at}.required must be a boolean`;
    const src = a["source"];
    if (src === undefined) continue;
    if (!isObj(src)) return `${at}.source must be an object`;
    const ks = extra(src, ["path", "lines", "hash"]);
    if (ks) return `unknown key "${ks}" in ${at}.source`;
    const pathIssue = repoPathIssue(src["path"]);
    if (pathIssue) return `${at}.source.path ${pathIssue}`;
    if (!nonEmpty(src["hash"])) return `${at}.source.hash must be a non-empty string`;
    const l = src["lines"];
    if (
      l !== undefined &&
      !(
        Array.isArray(l) &&
        l.length === 2 &&
        Number.isInteger(l[0]) &&
        Number.isInteger(l[1]) &&
        1 <= l[0] &&
        l[0] <= l[1]
      )
    )
      return `${at}.source.lines must be two integers [from, to] with 1 <= from <= to`;
  }
  return undefined;
}

/**
 * Why `by` may not ground an item whose workers are `workers` (design spec section 27, F1 G1-2,
 * G2-2): it is neither `human` nor a registered role, or it worked on the item; else `undefined`.
 */
function recorderIssue(
  state: WorkflowState<string>,
  by: unknown,
  workers: readonly string[],
): string | undefined {
  if (typeof by !== "string" || (by !== "human" && !Object.hasOwn(state.roles, by)))
    return `${JSON.stringify(by)} is neither human nor a registered role`;
  return workers.includes(by) ? `"${by}" worked on the item` : undefined;
}
const sourced = (d: ContextSnapshotData): boolean => d.assumptions.some((a) => a.source);
/** A copy of a validated assumption (closed object: claim, required, source { path, lines, hash }). */
const copyOf = ({ source, ...rest }: ContextAssumption): ContextAssumption =>
  source
    ? {
        ...rest,
        source: {
          ...source,
          ...(source.lines ? { lines: [...source.lines] as [number, number] } : {}),
        },
      }
    : rest;

/**
 * The item's current context (design spec section 27, #36): its latest fresh (post-rework)
 * qualifying `context-snapshot` evidence (valid data with at least one sourced assumption,
 * recorded by `human` or a registered role that did not work on the item, `workersOf`), with
 * `stale` the cited source paths a later `repo.changed` event listed (exact match, in event order)
 * and `unverified` the claims with no source; `undefined` when there is none. The `required`
 * claims of every earlier valid fresh snapshot (whoever recorded it) carry forward (spec 28, #49): reported
 * `required: true` when the latest has the claim, appended as `{ claim, required: true }` (no
 * source, so unverified) when it lacks it; claims compare by exact text. The answer is a
 * copy. Each evidence entry is located at its own `item.evidence` event, matched from the end as
 * `freshEvidence` does; an entry with no event counts as older than every event.
 */
export function contextOf(state: WorkflowState<string>, item: WorkItem): BriefContext | undefined {
  // one indexed pass over the log per state, not per item (F1 G3-2, G3-3, G3-4)
  const index = eventIndex(state);
  const at = index.evidence.get(item.id) ?? [];
  const all = item.evidence;
  const after = sinceRework(index, item.id, at);
  const fresh = after === undefined ? all.length : Math.min(after, all.length);
  let workers: string[] | undefined;
  // the data of entry k when it is a qualifying snapshot; one that does not qualify is ignored, so
  // it cannot supersede one that does (G2-1)
  const qualifying = (k: number): ContextSnapshotData | undefined => {
    const e = all[k]!;
    if (e.kind !== "context-snapshot" || snapshotIssue(e.data) !== undefined) return undefined;
    const data = e.data as unknown as ContextSnapshotData;
    return !sourced(data) || recorderIssue(state, e.by, (workers ??= workersOf(state, item)))
      ? undefined
      : data;
  };
  for (let k = all.length - 1; k >= all.length - fresh; k--) {
    const e = all[k]!;
    const data = qualifying(k);
    if (!data) continue;
    // the required claims of every earlier valid fresh snapshot carry forward, whoever recorded
    // it: independence decides who may verify a claim, not which claims are required (spec 28,
    // #49, gate G1-3)
    const carried = new Set<string>();
    for (let j = k - 1; j >= all.length - fresh; j--) {
      const d = all[j]!;
      if (d.kind === "context-snapshot" && snapshotIssue(d.data) === undefined)
        for (const a of (d.data as unknown as ContextSnapshotData).assumptions)
          if (a.required) carried.add(a.claim);
    }
    const assumptions = data.assumptions.map((a) =>
      carried.has(a.claim) ? { ...copyOf(a), required: true } : copyOf(a),
    );
    for (const claim of carried)
      if (!data.assumptions.some((a) => a.claim === claim))
        assumptions.push({ claim, required: true });
    // each cited path's first repo.changed after the snapshot's own event, in event order
    const pos = at[k + at.length - all.length] ?? -1;
    const hits: [number, number, string][] = [];
    for (const path of new Set(data.assumptions.map((a) => a.source?.path))) {
      const list = path === undefined ? undefined : index.changed.get(path);
      const f = list ? firstAfter(list, pos, (x) => x[0]) : 0;
      if (list && f < list.length) hits.push([list[f]![0], list[f]![1], path!]);
    }
    // oxlint-disable-next-line unicorn/no-array-sort -- a fresh local array; toSorted needs Node 20
    hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return {
      revision: data.revision,
      // copies: a caller (a brief, a host) changing the answer must not change the state (G2-9)
      assumptions,
      snapshot: e.ref,
      by: e.by,
      stale: hits.map((h) => h[2]),
      unverified: assumptions.filter((a) => !a.source).map((a) => a.claim),
    };
  }
  return undefined;
}

const KEYS = ["item", "revision", "assumptions", "ref", "by", "now"];
const bad = (what: string, fix: string): never =>
  fail("invalid-input", `context snapshot: ${what}`, fix);

/**
 * Records a context snapshot of an item as evidence `context-snapshot` with `data: { revision,
 * assumptions }` (design spec section 27, #36), through `applyAction` (action `context.snapshot`)
 * so the methodology's rules see it. Refuses `invalid-input` for an unknown key, an empty revision,
 * claim or ref, a source with a path that is not repository-relative POSIX or an empty hash,
 * `lines` that are not two integers `1 <= from <= to`, no assumption with a source, and a `by`
 * that is neither `human` nor a registered role or that worked on the item. The input is copied.
 */
export function recordContextSnapshot<N extends string>(
  state: WorkflowState<N>,
  methodology: Methodology<unknown, N>,
  input: ContextSnapshotInput,
): ApplyResult<N> {
  if (!isObj(input)) bad("input must be an object", `pass { ${KEYS.join(", ")} }`);
  const k = extra(input as unknown as Record<string, unknown>, KEYS);
  if (k) bad(`unknown key "${k}"`, `use only: ${KEYS.join(", ")}`);
  const { item: id, revision, assumptions, ref, by, now } = input;
  if (typeof id !== "string") bad("item must be an item id", 'e.g. "item": "CART-12"');
  const item = getItem(state, id);
  const data = { revision, assumptions } as unknown as Record<string, unknown>;
  const issue = snapshotIssue(data);
  if (issue)
    bad(
      issue,
      'e.g. { "revision": "4f2c1e0", "assumptions": [{ "claim": "totals are cents", "source": { "path": "src/cart.ts", "hash": "…" } }] }',
    );
  if (!nonEmpty(ref))
    bad("ref must be a non-empty string", 'name the snapshot artifact, e.g. "ctx/CART-12.json"');
  if (!nonEmpty(by)) bad("by must name who recorded it", 'e.g. "by": "scout"');
  const who = recorderIssue(state, by, workersOf(state, item));
  if (who)
    bad(
      `${who} and may not record its context`,
      "record as human or a registered role that did not work on the item",
    );
  if (!sourced(data as unknown as ContextSnapshotData))
    bad(
      "a snapshot needs at least one assumption with a source (nothing was verified)",
      'cite what was checked, e.g. "source": { "path": "src/cart.ts", "hash": "…" }',
    );
  if (now !== undefined && typeof now !== "string")
    bad("now must be an ISO timestamp string", "omit now to use the clock");
  // validated plain data, copied so no reference to the caller's arrays is kept
  const copy = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
  return applyAction(
    state,
    methodology,
    { type: "context.snapshot", by, payload: { item: id, ref, ...copy } },
    (s) => addEvidence(s, id, { kind: "context-snapshot", ref, by, data: copy }, now),
  );
}
