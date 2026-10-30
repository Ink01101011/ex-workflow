import { assertId, fail } from "../errors.ts";
import { estimateTokens } from "../budget.ts";
import { resourceCapsFor } from "../planner.ts";
import { roleOf } from "../roles.ts";
import { addEvidence, getItem, moveItem, patchItem } from "../items.ts";
import { appendEvent, nowOf } from "../state.ts";
import { applyAction } from "../methodology.ts";
import { assertPolicies } from "../policies.ts";
import { experimentation } from "./index.ts";
import type { Capability, Ceremony, CeremonyInput, Spent, WorkflowState } from "../types.ts";
import { dimensions, invalid, object, sha, text, validateExperimentationConfig } from "./config.ts";
import type { ExperimentCandidate, ExperimentationState } from "./state.ts";
export function experimentOf(s: WorkflowState): ExperimentationState {
  if (s.methodology !== "experimentation" || !s.experimentation)
    invalid("freeze an experimentation workflow first");
  return s.experimentation;
}
export function authorize(s: WorkflowState, by: string, capability: Capability): void {
  if (!roleOf(s, by)?.capabilities.includes(capability))
    fail(
      "missing-capability",
      `${by} needs ${capability}`,
      "use a role with the required capability",
    );
}
/** Completion events bind cost to the actual dispatched item/actor; accounting labels are caller supplied. */
function completedUsage(s: WorkflowState, item?: string, author?: string): Spent {
  return s.events.reduce(
    (sum, event) => {
      if (event.type !== "item.completed" || !object(event.payload)) return sum;
      const p = event.payload;
      if (
        typeof p.id !== "string" ||
        p.role !== event.by ||
        (item !== undefined && p.id !== item) ||
        (author !== undefined && p.role !== author)
      )
        return sum;
      if (
        typeof p.tokens !== "number" ||
        !Number.isFinite(p.tokens) ||
        p.tokens < 0 ||
        typeof p.durationMs !== "number" ||
        !Number.isFinite(p.durationMs) ||
        p.durationMs < 0
      )
        return sum;
      if (
        item === undefined &&
        Object.values(s.experimentation?.candidates ?? {}).some((c) => c.item === p.id)
      )
        return sum;
      return {
        tokens: sum.tokens + p.tokens,
        turns: sum.turns + 1,
        wallclockMs: sum.wallclockMs + p.durationMs,
      };
    },
    { tokens: 0, turns: 0, wallclockMs: 0 },
  );
}
function maximum(a: Spent, b: Spent): Spent {
  return {
    tokens: Math.max(a.tokens, b.tokens),
    turns: Math.max(a.turns, b.turns),
    wallclockMs: Math.max(a.wallclockMs, b.wallclockMs),
  };
}
export function effectiveSpent(s: WorkflowState, c: ExperimentCandidate): Spent {
  return maximum(c.spent, completedUsage(s, c.item, c.author));
}
export function synchronizeBudget(s: WorkflowState, now?: string): WorkflowState {
  if (!s.experimentation) return s;
  const usage = totalSpent(s);
  const closed = ["stopped", "integrated"].includes(s.experimentation.status);
  return {
    ...s,
    iterations: s.iterations.map((it) =>
      it.id === "experiment"
        ? {
            ...it,
            budget: { ...validateExperimentationConfig(s.config).totalBudget },
            spent: usage,
            ...(closed
              ? {
                  endedAt: it.endedAt ?? nowOf(now),
                  outcome:
                    it.outcome ??
                    (s.experimentation!.status === "integrated"
                      ? ("completed" as const)
                      : ("cancelled" as const)),
                }
              : {}),
          }
        : it,
    ),
  };
}
export function totalSpent(s: WorkflowState, e = experimentOf(s)): Spent {
  const overhead = maximum(e.overhead, completedUsage(s));
  return Object.values(e.candidates).reduce((sum, c) => {
    const v = effectiveSpent(s, c);
    return {
      tokens: sum.tokens + v.tokens,
      turns: sum.turns + v.turns,
      wallclockMs: sum.wallclockMs + v.wallclockMs,
    };
  }, overhead);
}
export function runningCount(s: WorkflowState): number {
  return Object.values(s.experimentation?.candidates ?? {}).filter(
    (c) => c.status === "running" || s.items[c.item]?.status === "in_progress",
  ).length;
}
/** Remaining token capacity after reserving estimates for currently dispatched work. */
export function reservedTokens(s: WorkflowState): number {
  return Object.values(s.experimentation?.candidates ?? {}).reduce((sum, c) => {
    const item = s.items[c.item];
    return sum + (item?.status === "in_progress" ? estimateTokens(s, item.weight, 1) : 0);
  }, 0);
}
export function unreservedTokens(s: WorkflowState): number | undefined {
  const limit = validateExperimentationConfig(s.config).totalBudget.tokens;
  if (limit === undefined) return undefined;
  return Math.max(0, limit - totalSpent(s).tokens - reservedTokens(s));
}
export function assignedAuthor(s: WorkflowState, c: ExperimentCandidate): boolean {
  const work = s.items[c.item];
  return (
    !!work &&
    (!work.role || work.role === c.author) &&
    !!roleOf(s, c.author)?.capabilities.includes("deliver")
  );
}
export function candidateExhausted(s: WorkflowState, c: ExperimentCandidate): boolean {
  const cfg = validateExperimentationConfig(s.config);
  const used = effectiveSpent(s, c);
  return dimensions.some(
    (k) => cfg.candidateBudget[k] !== undefined && used[k] >= cfg.candidateBudget[k]!,
  );
}
export function exhausted(s: WorkflowState): boolean {
  if (!s.experimentation) return false;
  const cfg = validateExperimentationConfig(s.config);
  const usage = totalSpent(s);
  return dimensions.some(
    (k) => cfg.totalBudget[k] !== undefined && usage[k] >= cfg.totalBudget[k]!,
  );
}
function candidate(e: ExperimentationState, i: CeremonyInput): ExperimentCandidate {
  const id = text(i.candidate, "candidate");
  if (!Object.hasOwn(e.candidates, id)) invalid(`unknown candidate ${id}`);
  return e.candidates[id]!;
}
function bool(i: CeremonyInput, k: string): boolean {
  if (typeof i[k] !== "boolean") invalid(`${k} must be boolean`);
  return i[k] as boolean;
}
function spent(i: CeremonyInput): Spent {
  if (!object(i.spent)) invalid("spent must contain nonnegative tokens, turns and wallclockMs");
  const out = {} as Spent;
  for (const k of dimensions) {
    const n = i.spent[k];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0)
      invalid(`spent.${k} must be a nonnegative safe integer`);
    out[k] = n;
  }
  return out;
}
function put(e: ExperimentationState, c: ExperimentCandidate): ExperimentationState {
  return { ...e, candidates: { ...e.candidates, [c.id]: c } };
}
function charge(e: ExperimentationState, i: CeremonyInput): ExperimentationState {
  const cost = spent(i);
  return {
    ...e,
    overhead: {
      tokens: e.overhead.tokens + cost.tokens,
      turns: e.overhead.turns + cost.turns,
      wallclockMs: e.overhead.wallclockMs + cost.wallclockMs,
    },
  };
}
function closeItem(s: WorkflowState, c: ExperimentCandidate, i: CeremonyInput): WorkflowState {
  return moveItem(s, c.item, { stage: "done", status: "dropped" }, i.by, i.now);
}
function active(e: ExperimentationState): void {
  if (e.status !== "running") invalid("experiment is not running");
}
function done(c: ExperimentCandidate): boolean {
  return ["validated", "failed", "timed-out", "cancelled"].includes(c.status);
}
function jsonSafe(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return false;
  seen.add(value);
  // JSON.stringify drops an undefined property, so it is safe in an object but not in an array.
  const valid = Array.isArray(value)
    ? value.every((v) => jsonSafe(v, seen))
    : Object.values(value).every((v) => v === undefined || jsonSafe(v, seen));
  seen.delete(value);
  return valid;
}
function reduce(
  name: string,
  capability: Capability,
  fn: (s: WorkflowState, i: CeremonyInput) => WorkflowState,
): Ceremony {
  return (s, i) => {
    if (!object(i) || !jsonSafe(i)) invalid("ceremony input must be JSON-safe");
    text(i.by, "by");
    if (i.now !== undefined && (typeof i.now !== "string" || !Number.isFinite(Date.parse(i.now))))
      invalid("now must be a valid timestamp");
    authorize(s, i.by, capability);
    return applyAction(
      s,
      experimentation(),
      { type: `ceremony.${name}`, by: i.by, payload: i },
      (current) =>
        appendEvent(
          synchronizeBudget(fn(current, i), i.now),
          `experimentation.${name}`,
          i.by,
          structuredClone(i),
          nowOf(i.now),
        ),
    );
  };
}
export function experimentationCeremonies(): Record<string, Ceremony> {
  return {
    freeze: reduce("frozen", "facilitate", (s, i) => {
      if (s.methodology !== "experimentation" || s.experimentation)
        invalid("freeze may run only once in experimentation");
      const cfg = validateExperimentationConfig(s.config);
      const baseSha = sha(i.baseSha, "baseSha");
      const harness = text(i.harness, "harness");
      if (
        !Array.isArray(i.candidates) ||
        i.candidates.length < 1 ||
        i.candidates.length > cfg.maxCandidates
      )
        invalid("candidates must be a nonempty array within maxCandidates");
      const candidates: Record<string, ExperimentCandidate> = {};
      const items = new Set<string>();
      for (const raw of i.candidates) {
        if (!object(raw)) invalid("candidate must be an object");
        const id = text(raw.id, "candidate.id");
        assertId(id, "candidate id");
        if (Object.hasOwn(candidates, id)) invalid("candidate IDs must be unique safe identifiers");
        const item = text(raw.item, "candidate.item");
        const author = text(raw.author, "candidate.author");
        authorize(s, author, "deliver");
        const work = getItem(s, item);
        if (work.role && work.role !== author)
          invalid("candidate item role must match frozen author");
        if (
          items.has(item) ||
          work.stage !== "candidate" ||
          work.status !== "todo" ||
          work.acceptance.length === 0
        )
          invalid("candidate needs a distinct todo candidate item with acceptance criteria");
        items.add(item);
        candidates[id] = {
          id,
          item,
          author,
          status: "pending",
          spent: { tokens: 0, turns: 0, wallclockMs: 0 },
        };
      }
      return {
        ...s,
        iterations: [
          ...s.iterations,
          {
            id: "experiment",
            goal: cfg.objective,
            budget: { ...cfg.totalBudget },
            spent: { tokens: 0, turns: 0, wallclockMs: 0 },
            startedAt: nowOf(i.now),
            committed: [...items],
            carryover: [],
          },
        ],
        experimentation: {
          status: "running",
          baseSha,
          harness,
          candidates,
          released: [],
          overhead: { tokens: 0, turns: 0, wallclockMs: 0 },
        },
      };
    }),
    provision: reduce("provisioned", "manage-flow", (s, i) => {
      let e = experimentOf(s);
      active(e);
      if (exhausted(s)) invalid("total experiment budget exhausted");
      const c = candidate(e, i);
      if (c.status !== "pending") invalid("candidate already provisioned");
      const workspace = text(i.workspace, "workspace");
      if (sha(i.baseSha, "baseSha") !== e.baseSha || i.isolated !== true)
        invalid("provision must attest isolated workspace at the exact frozen base SHA");
      if (Object.values(e.candidates).some((x) => x.workspace === workspace))
        invalid("candidate workspaces must be distinct");
      e = put(e, { ...c, workspace, status: "ready" });
      return { ...s, experimentation: e };
    }),
    start: reduce("started", "deliver", (s, i) => {
      const e = experimentOf(s);
      active(e);
      const c = candidate(e, i);
      if (c.status !== "ready" || c.author !== i.by)
        invalid("only the candidate author may start a ready candidate");
      if (exhausted(s)) invalid("total experiment budget exhausted");
      const cfg = validateExperimentationConfig(s.config);
      const running = Object.values(e.candidates).filter(
        (x) => x.status === "running" || s.items[x.item]?.status === "in_progress",
      ).length;
      if (running >= cfg.concurrencyCap) invalid("candidate concurrency cap reached");
      if (!assignedAuthor(s, c))
        invalid("candidate author assignment or delivery capability changed");
      const usage = totalSpent(s);
      if (cfg.totalBudget.turns !== undefined && usage.turns + running >= cfg.totalBudget.turns)
        invalid("total experiment budget reserved by running candidates");
      const role = roleOf(s, c.author)!;
      const cls = role.resourceClass ?? role.id;
      const cap = resourceCapsFor(s)[cls];
      const occupied = Object.values(s.items).filter(
        (w) =>
          w.status === "in_progress" &&
          w.role &&
          (roleOf(s, w.role)?.resourceClass ?? w.role) === cls,
      ).length;
      if (cap !== undefined && occupied >= cap) invalid("role resource capacity reached");
      const work = getItem(s, c.item);
      const tokenCapacity = unreservedTokens(s);
      if (tokenCapacity !== undefined && estimateTokens(s, work.weight, 1) > tokenCapacity)
        invalid("total experiment token budget reserved or insufficient");
      if (work.status !== "todo") invalid("candidate item is already dispatched");
      assertPolicies(
        s,
        work,
        [
          { kind: "dependencies-done" },
          { kind: "no-open-blockers" },
          { kind: "acceptance-written" },
          ...s.stages.find((st) => st.id === "building")!.entryPolicy,
        ],
        "start candidate execution",
      );
      if (candidateExhausted(s, c)) invalid("candidate budget exhausted");
      let next = moveItem(s, c.item, { stage: "building", status: "in_progress" }, i.by, i.now);
      next = patchItem(next, c.item, (w) => ({ ...w, role: i.by }));
      return { ...next, experimentation: put(e, { ...c, status: "running" }) };
    }),
    submit: reduce("submitted", "deliver", (s, i) => {
      const e = experimentOf(s);
      active(e);
      const c = candidate(e, i);
      const work = getItem(s, c.item);
      if (
        (c.status !== "running" && !(c.status === "ready" && work.status === "in_progress")) ||
        c.author !== i.by ||
        work.role !== i.by
      )
        invalid("only the running candidate author may submit once");
      const commit = sha(i.sha);
      if (
        i.workspace !== c.workspace ||
        i.harness !== e.harness ||
        sha(i.baseSha, "baseSha") !== e.baseSha
      )
        invalid("submission provenance must match frozen base SHA, harness and owned workspace");
      if (typeof i.score !== "number" || !Number.isFinite(i.score)) invalid("score must be finite");
      const usage = spent(i);
      const command = text(i.command, "command");
      const log = text(i.log, "log");
      const cfg = validateExperimentationConfig(s.config);
      const measured = effectiveSpent(s, { ...c, spent: usage });
      const over = dimensions.some(
        (k) => cfg.candidateBudget[k] !== undefined && measured[k] > cfg.candidateBudget[k]!,
      );
      const updated: ExperimentCandidate = {
        ...c,
        status: over ? "timed-out" : "submitted",
        sha: commit,
        score: i.score,
        spent: measured,
        command,
        log,
      };
      if (over) updated.reason = "candidate budget exceeded";
      let next: WorkflowState = { ...s, experimentation: put(e, updated) };
      next = addEvidence(next, c.item, { kind: "candidate-sha", ref: commit, by: i.by }, i.now);
      next = addEvidence(
        next,
        c.item,
        {
          kind: "benchmark-result",
          ref: JSON.stringify({ score: i.score, harness: e.harness, sha: commit }),
          by: i.by,
        },
        i.now,
      );
      return over ? closeItem(next, updated, i) : next;
    }),
    terminate: reduce("terminated", "manage-flow", (s, i) => {
      const e = experimentOf(s);
      active(e);
      const c = candidate(e, i);
      if (done(c)) invalid("candidate is already terminal");
      if (!["failed", "timed-out", "cancelled"].includes(i.status as string))
        invalid("status must be failed, timed-out or cancelled");
      const reason = text(i.reason, "reason");
      const usage = spent(i);
      const log = text(i.log, "log");
      return closeItem(
        {
          ...s,
          experimentation: put(e, {
            ...c,
            status: i.status as ExperimentCandidate["status"],
            reason,
            spent: maximum(effectiveSpent(s, c), effectiveSpent(s, { ...c, spent: usage })),
            terminalLog: log,
          }),
        },
        c,
        i,
      );
    }),
    validate: reduce("validated", "verify", (s, i) => {
      const e = experimentOf(s);
      active(e);
      const c = candidate(e, i);
      if (c.status !== "submitted") invalid("validate an unvalidated submitted candidate");
      if (i.by === c.author) invalid("candidate author cannot independently validate");
      // A candidate the planner dispatched is completed by its builder (handoff and accounting)
      // before validation; one the host started by ceremony has no completion to wait for.
      const started = s.events.some(
        (event) =>
          event.type === "experimentation.started" &&
          object(event.payload) &&
          event.payload.candidate === c.id,
      );
      if (!started && getItem(s, c.item).status === "in_progress")
        fail(
          "invalid-input",
          `candidate "${c.id}" item "${c.item}" is still in progress under the planner`,
          `complete item "${c.item}" with the builder's handoff (candidate-sha ${c.sha}) and accounting before validating`,
          { items: [c.item] },
        );
      const commit = sha(i.sha);
      const harness = text(i.harness, "harness");
      if (commit !== c.sha || harness !== e.harness)
        invalid("validation must match exact submitted SHA and frozen harness");
      const passed = bool(i, "passed");
      const reproducible = bool(i, "reproducible");
      const evidence = text(i.evidence, "evidence");
      const validation = { sha: commit, harness, by: i.by, passed, reproducible, evidence };
      let next: WorkflowState = {
        ...s,
        experimentation: put(charge(e, i), {
          ...c,
          status: passed && reproducible ? "validated" : "failed",
          validation,
        }),
      };
      next = addEvidence(next, c.item, { kind: "validation", ref: evidence, by: i.by }, i.now);
      next = moveItem(
        next,
        c.item,
        { stage: "done", status: passed && reproducible ? "done" : "dropped" },
        i.by,
        i.now,
      );
      return next;
    }),
    compare: reduce("compared", "facilitate", (s, _i) => {
      const e = experimentOf(s);
      active(e);
      const all = Object.values(e.candidates);
      if (!all.every(done))
        invalid(
          "comparison requires all candidates terminal and submissions independently validated",
        );
      const cfg = validateExperimentationConfig(s.config);
      const usage = totalSpent(s, e);
      if (
        dimensions.some((k) => cfg.totalBudget[k] !== undefined && usage[k] > cfg.totalBudget[k]!)
      )
        return {
          ...s,
          experimentation: { ...e, status: "stopped", reason: "total budget exceeded" },
        };
      const eligible = all.filter((c) => {
        const used = effectiveSpent(s, c);
        return (
          c.status === "validated" &&
          c.validation?.passed &&
          c.validation.reproducible &&
          c.validation.sha === c.sha &&
          c.validation.harness === e.harness &&
          !dimensions.some(
            (k) => cfg.candidateBudget[k] !== undefined && used[k] > cfg.candidateBudget[k]!,
          )
        );
      });
      eligible.sort((a, b) => {
        const delta = (a.score! - b.score!) * (cfg.direction === "minimize" ? 1 : -1);
        return delta || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      });
      const selected = eligible[0];
      return {
        ...s,
        experimentation: selected
          ? { ...e, status: "selected", selected: selected.id }
          : { ...e, status: "stopped", reason: "no eligible candidate" },
      };
    }),
    integrate: reduce("integration-recorded", "control-change", (s, i) => {
      const e = experimentOf(s);
      if (!["selected", "integrating"].includes(e.status) || !e.selected)
        invalid("compare and select before integration");
      if (exhausted(s)) invalid("total budget exhausted before integration");
      const c = e.candidates[e.selected]!;
      const selectedSha = sha(i.selectedSha, "selectedSha");
      if (selectedSha !== c.sha || c.validation?.sha !== selectedSha)
        invalid("integration must promote the exact selected and validated SHA");
      const targetSha = sha(i.targetSha, "targetSha");
      const integrationSha = sha(i.integrationSha, "integrationSha");
      if (e.integration?.sha === integrationSha && e.integration.targetSha === targetSha)
        invalid("integration already recorded");
      return {
        ...s,
        experimentation: {
          ...charge(e, i),
          status: "integrating",
          integration: { selectedSha, targetSha, sha: integrationSha, by: i.by },
        },
      };
    }),
    "validate-integration": reduce("integration-validated", "verify", (s, i) => {
      const e = experimentOf(s);
      if (e.status !== "integrating" || !e.integration || !e.selected)
        invalid("record integration before fresh validation");
      const integration = e.integration;
      const c = e.candidates[e.selected]!;
      if (i.by === integration.by || i.by === c.author)
        invalid("integration validation must be independent of candidate author and integrator");
      const commit = sha(i.sha);
      const targetSha = sha(i.targetSha, "targetSha");
      const harness = text(i.harness, "harness");
      if (
        commit !== integration.sha ||
        targetSha !== integration.targetSha ||
        harness !== e.harness
      )
        invalid("fresh validation must match integration SHA, current target SHA and harness");
      const passed = bool(i, "passed");
      const evidence = text(i.evidence, "evidence");
      const charged = charge(e, i);
      const cfg = validateExperimentationConfig(s.config);
      const usage = totalSpent(s, charged);
      const over = dimensions.some(
        (k) => cfg.totalBudget[k] !== undefined && usage[k] > cfg.totalBudget[k]!,
      );
      return {
        ...s,
        experimentation: {
          ...charged,
          status: passed && !over ? "integrated" : "stopped",
          ...(passed && !over
            ? {}
            : { reason: over ? "total budget exceeded" : "integration validation failed" }),
          integration: {
            ...integration,
            validation: { by: i.by, sha: commit, harness, evidence, passed },
          },
        },
      };
    }),
    stop: reduce("stopped", "manage-flow", (s, i) => {
      const e = experimentOf(s);
      if (e.status === "stopped" || e.status === "integrated") invalid("experiment already closed");
      const reason = text(i.reason, "reason");
      if (
        Object.values(e.candidates).some(
          (c) =>
            c.status === "running" ||
            c.status === "submitted" ||
            s.items[c.item]?.status === "in_progress",
        )
      )
        invalid("terminate active attempts with final usage and log before stopping");
      const candidates = Object.fromEntries(
        Object.values(e.candidates).map((c) => [
          c.id,
          done(c) ? c : { ...c, status: "cancelled" as const, reason },
        ]),
      );
      let next = s;
      for (const c of Object.values(e.candidates)) if (!done(c)) next = closeItem(next, c, i);
      return {
        ...next,
        experimentation: { ...charge(e, i), status: "stopped", reason, candidates },
      };
    }),
    cleanup: reduce("cleanup-recorded", "manage-flow", (s, i) => {
      const e = experimentOf(s);
      if (e.status !== "stopped" && e.status !== "integrated")
        invalid("cleanup requires a closed experiment");
      if (
        !Array.isArray(i.workspaces) ||
        i.workspaces.length === 0 ||
        i.workspaces.some(
          (w) =>
            typeof w !== "string" ||
            !Object.values(e.candidates).some((c) => c.workspace === w) ||
            e.released.includes(w),
        ) ||
        new Set(i.workspaces).size !== i.workspaces.length
      )
        invalid("workspaces must list distinct owned unreleased identities");
      return {
        ...s,
        experimentation: { ...e, released: [...e.released, ...(i.workspaces as string[])] },
      };
    }),
  };
}
