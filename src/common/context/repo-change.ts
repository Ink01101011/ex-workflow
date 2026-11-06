// `repo.changed` (design spec section 27, #36): the host reports which repository paths a new
// revision changed; context snapshots citing one of them go stale (see contextOf).
import { fail } from "../../core/errors.ts";
import { applyAction } from "../../core/methodology.ts";
import { appendEvent, nowOf } from "../../core/state.ts";
import type { ApplyResult, Methodology, Violation, WorkflowState } from "../../core/types.ts";
import { contextOf, repoPathIssue } from "./snapshot.ts";

export interface RepoChangeInput {
  /** The new repository revision. */
  revision: string;
  /** Repository-relative POSIX paths the revision changed, as Git lists them. */
  paths: string[];
  by: string;
  now?: string;
}

const KEYS = ["revision", "paths", "by", "now"];
const IN_FLIGHT = ["in_progress", "review", "awaiting_human"];
const bad = (what: string, fix: string): never =>
  fail("invalid-input", `repo change: ${what}`, fix);

/**
 * Records that `revision` changed `paths` (design spec section 27, #36): action `repo.change`
 * through `applyAction`, event `repo.changed { revision, paths }` with the paths deduplicated in
 * input order. No item status changes; `warnings` carries one `context-stale` warning per item in
 * `in_progress`, `review` or `awaiting_human` whose context snapshot this change made stale (a
 * cited path it changed that was not stale already). Refuses `invalid-input` for an unknown key,
 * an empty revision, and paths that are not a non-empty array of repository-relative POSIX paths.
 */
export function recordRepoChange<N extends string>(
  state: WorkflowState<N>,
  methodology: Methodology<unknown, N>,
  input: RepoChangeInput,
): ApplyResult<N> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    bad("input must be an object", `pass { ${KEYS.join(", ")} }`);
  for (const k of Object.keys(input))
    if (!KEYS.includes(k)) bad(`unknown key "${k}"`, `use only: ${KEYS.join(", ")}`);
  const { revision, paths, by, now } = input;
  if (typeof revision !== "string" || revision.trim() === "")
    bad("revision must be a non-empty string", 'e.g. "revision": "4f2c1e0"');
  if (!Array.isArray(paths) || paths.length === 0)
    bad("paths must be a non-empty array of paths", 'e.g. "paths": ["src/cart.ts"]');
  paths.forEach((p, i) => {
    const issue = repoPathIssue(p);
    if (issue)
      bad(
        `paths[${i}] ${issue}`,
        'send paths as `git diff --name-only` lists them, e.g. "src/cart.ts"',
      );
  });
  if (typeof by !== "string" || by === "") bad("by must name the reporter", 'e.g. "by": "ci"');
  if (now !== undefined && typeof now !== "string")
    bad("now must be an ISO timestamp string", "omit now to use the clock");
  const changed = [...new Set(paths)];
  const res = applyAction(
    state,
    methodology,
    { type: "repo.change", by, payload: { revision, paths: changed } },
    (s) => appendEvent(s, "repo.changed", by, { revision, paths: changed }, nowOf(now)),
  );
  const warnings: Violation[] = [];
  for (const item of Object.values(res.state.items)) {
    if (!IN_FLIGHT.includes(item.status)) continue;
    // only paths this change made stale: a path already stale before it does not warn again
    const ctx = contextOf(res.state, item);
    const was = contextOf(state, item)?.stale ?? [];
    const hit = ctx ? ctx.stale.filter((p) => changed.includes(p) && !was.includes(p)) : [];
    if (hit.length)
      warnings.push({
        rule: "context-stale",
        severity: "warning",
        item: item.id,
        message: `context snapshot "${ctx!.snapshot}" of "${item.id}" is stale: ${hit.join(", ")} changed at ${revision}`,
        fix: `re-verify and record a fresh snapshot of "${item.id}" with recordContextSnapshot`,
      });
  }
  return { state: res.state, warnings: [...res.warnings, ...warnings] };
}
