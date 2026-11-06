// `compareRuns` (design spec section 27, #34): a pure comparison of finished runs, one metric
// vector per variant, a deterministic ranking and a winner or no winner. Scoring, the scenario
// suite and running the variants stay with the host.
import { assertId, fail } from "../core/errors.ts";
import type { WorkflowState } from "../core/types.ts";

/** One finished run of one variant on one scenario. */
export interface RunRecord {
  variant: string;
  scenario: string;
  state: WorkflowState<string>;
  /** The host scorer's verdict for this scenario run. */
  passed: boolean;
}

export interface CompareRunsOptions {
  /** The variant every other one is compared with. */
  baseline: string;
  /** Scenarios any failing run of which makes a variant ineligible. */
  mustPass?: string[];
  /** Pass-rate noise, a fraction in `[0, 1]` (default `0`). */
  passTolerance?: number;
  /** Token-cost noise, a fraction in `[0, 1]` (default `0`). */
  costTolerance?: number;
}

export interface RunMetrics {
  tokens: number;
  durationMs: number;
  turns: number;
  humanInterventions: number;
  reworks: number;
  escalations: number;
  itemsDone: number;
}

export interface VariantResult {
  variant: string;
  runs: number;
  passed: number;
  passRate: number;
  mean: RunMetrics;
  /** Must-pass scenarios with at least one failing run. */
  regressions: string[];
  /** Baseline or must-pass scenarios the variant never ran. */
  missing: string[];
  eligible: boolean;
}

export interface RunComparison {
  baseline: string;
  /** Ranked: eligible first, then pass rate, tokens, duration, interventions, id. */
  variants: VariantResult[];
  winner: string | null;
  reason: string;
}

const OPTION_KEYS = ["baseline", "mustPass", "passTolerance", "costTolerance"];
const METRICS = [
  "tokens",
  "durationMs",
  "turns",
  "humanInterventions",
  "reworks",
  "escalations",
  "itemsDone",
] as const;

const bad = (what: string, fix: string): never =>
  fail("invalid-input", `compareRuns: ${what}`, fix);
const show = (v: unknown): string =>
  typeof v === "string"
    ? JSON.stringify(v)
    : typeof v === "object" && v !== null
      ? Array.isArray(v)
        ? "an array"
        : "an object"
      : typeof v === "function" || typeof v === "symbol"
        ? typeof v
        : String(v);
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
/** `o[k]` when `o` has it as an own property: inherited values (a `{ __proto__: … }` literal) are not read. */
const own = (o: Record<string, unknown>, k: string): unknown =>
  Object.hasOwn(o, k) ? o[k] : undefined;
const finite = (v: number, what: string): number =>
  Number.isFinite(v)
    ? v
    : bad(`${what} is not finite (${v})`, "pass the host's measured usage figures");
const idOf = (v: unknown, what: string): string => {
  if (typeof v !== "string")
    bad(`${what} is ${show(v)}, not an id`, `pass a string id such as "V0"`);
  assertId(v, what);
  return v as string;
};
const tolerance = (v: unknown, key: string): number => {
  if (v === undefined) return 0;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1)
    bad(`${key} is ${show(v)}, not a fraction in [0, 1]`, `pass e.g. "${key}": 0.05`);
  return v as number;
};

function metricsOf(state: unknown, where: string): RunMetrics {
  if (!isObject(state))
    return bad(
      `${where}.state is ${show(state)}, not a workflow state`,
      "pass the finished state.json",
    );
  const [events, accounting, items] = ["events", "accounting", "items"].map((k) => own(state, k));
  if (!Array.isArray(events) || !Array.isArray(accounting))
    return bad(
      `${where}.state has no events and accounting arrays`,
      "pass a WorkflowState as loaded by loadState",
    );
  if (!isObject(items))
    return bad(
      `${where}.state.items is ${show(items)}, not an object`,
      "pass a WorkflowState as loaded by loadState",
    );
  const m: RunMetrics = {
    tokens: 0,
    durationMs: 0,
    turns: accounting.length,
    humanInterventions: 0,
    reworks: 0,
    escalations: 0,
    itemsDone: 0,
  };
  accounting.forEach((line: unknown, i) => {
    if (!isObject(line))
      return bad(
        `${where}.state.accounting[${i}] is ${show(line)}`,
        "pass accounting lines as recorded by complete",
      );
    for (const k of ["tokensIn", "tokensOut", "durationMs"]) {
      const v = own(line, k);
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
        bad(
          `${where}.state.accounting[${i}].${k} is ${show(v)}, not a finite non-negative number`,
          "pass the host's measured usage figures",
        );
    }
    m.tokens += (line["tokensIn"] as number) + (line["tokensOut"] as number);
    m.durationMs += line["durationMs"] as number;
  });
  // finite figures can still sum to Infinity (G2-7)
  finite(m.tokens, `${where}.state token total`);
  finite(m.durationMs, `${where}.state duration total`);
  events.forEach((ev: unknown, i) => {
    if (!isObject(ev) || typeof own(ev, "type") !== "string")
      return bad(
        `${where}.state.events[${i}] is ${show(ev)}, not an event`,
        "pass events as recorded by the engine",
      );
    const t = ev["type"];
    if (t === "pending.raised" || t === "blocker.cleared") m.humanInterventions++;
    else if (t === "item.rework") m.reworks++;
    else if (t === "item.escalated") m.escalations++;
  });
  for (const it of Object.values(items))
    if (isObject(it) && own(it, "status") === "done") m.itemsDone++;
  return m;
}

// summed in ascending order so the order of `runs` never changes a float result
const meanOf = (xs: number[]): number =>
  xs.sort((a, b) => a - b).reduce((s, x) => s + x, 0) / xs.length;
const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Compares finished runs (design spec section 27, #34). Pure: reads only its arguments and
 * returns fresh objects. Each variant gets a metric vector (the mean over its runs of tokens,
 * duration, turns, human interventions, reworks, escalations and done items), a pass rate (the
 * mean over its scenarios of each scenario's passing share, so every scenario weighs the same) and an
 * eligibility (no must-pass regression, nothing missing). The winner is the first ranked eligible
 * non-baseline variant that is not worse than the baseline on pass rate and better on pass rate
 * or tokens, beyond the tolerances; otherwise `null` with the reason. Refuses `invalid-input`
 * naming the offending value for malformed input, never a `TypeError`.
 */
export function compareRuns(
  runs: readonly RunRecord[],
  options: CompareRunsOptions,
): RunComparison {
  if (!Array.isArray(runs))
    bad(
      `runs is ${show(runs)}, not an array`,
      "pass an array of { variant, scenario, state, passed }",
    );
  if (runs.length === 0) bad("no runs to compare", "pass at least the baseline's finished runs");
  if (!isObject(options))
    return bad(`options is ${show(options)}, not an object`, 'pass { baseline: "V0" }');
  for (const k of Object.keys(options))
    if (!OPTION_KEYS.includes(k))
      bad(`unknown option "${k}"`, `use only: ${OPTION_KEYS.join(", ")}`);
  const o = options as unknown as Record<string, unknown>;
  const baseline = idOf(own(o, "baseline"), "baseline");
  const must = own(o, "mustPass");
  if (must !== undefined && !Array.isArray(must))
    bad(`mustPass is ${show(must)}, not an array`, 'pass e.g. "mustPass": ["s1"]');
  const mustPass = [
    ...new Set(((must ?? []) as unknown[]).map((s) => idOf(s, "mustPass scenario"))),
  ];
  const passTol = tolerance(own(o, "passTolerance"), "passTolerance");
  const costTol = tolerance(own(o, "costTolerance"), "costTolerance");

  interface Acc {
    metrics: RunMetrics[];
    passed: number;
    /** scenario -> [passing runs, runs] */
    ran: Map<string, [number, number]>;
    failed: Set<string>;
  }
  const groups = new Map<string, Acc>();
  const named = new Set<string>();
  runs.forEach((r: unknown, i) => {
    const where = `runs[${i}]`;
    if (!isObject(r))
      return bad(
        `${where} is ${show(r)}, not a run record`,
        "pass { variant, scenario, state, passed }",
      );
    const variant = idOf(own(r, "variant"), `${where}.variant`);
    const scenario = idOf(own(r, "scenario"), `${where}.scenario`);
    const passed = own(r, "passed");
    if (typeof passed !== "boolean")
      bad(
        `${where}.passed is ${show(passed)}, not a boolean`,
        "pass the scorer's verdict as true or false",
      );
    const metrics = metricsOf(own(r, "state"), where);
    let g = groups.get(variant);
    if (!g)
      groups.set(variant, (g = { metrics: [], passed: 0, ran: new Map(), failed: new Set() }));
    g.metrics.push(metrics);
    const tally = g.ran.get(scenario) ?? [0, 0];
    g.ran.set(scenario, tally);
    tally[1]++;
    named.add(scenario);
    if (passed) {
      g.passed++;
      tally[0]++;
    } else g.failed.add(scenario);
  });
  const base = groups.get(baseline);
  if (!base) bad(`baseline "${baseline}" has no run`, "name a variant that appears in runs");
  for (const s of mustPass)
    if (!named.has(s))
      bad(`mustPass scenario "${s}" has no run`, "name a scenario that appears in runs");
  const required = [...new Set([...base!.ran.keys(), ...mustPass])].sort(byId);

  const results: VariantResult[] = [...groups].map(([variant, g]) => {
    const n = g.metrics.length;
    const mean = {} as RunMetrics;
    for (const k of METRICS)
      mean[k] = finite(meanOf(g.metrics.map((m) => m[k])), `variant ${variant} mean ${k}`);
    const regressions = mustPass.filter((s) => g.failed.has(s)).sort(byId);
    const missing = required.filter((s) => !g.ran.has(s));
    return {
      variant,
      runs: n,
      passed: g.passed,
      // scenario-weighted: each scenario counts once, whatever its number of runs (G1-3)
      passRate: meanOf([...g.ran.values()].map(([p, k]) => p / k)),
      mean,
      regressions,
      missing,
      eligible: regressions.length === 0 && missing.length === 0,
    };
  });
  results.sort(
    (a, b) =>
      Number(b.eligible) - Number(a.eligible) ||
      b.passRate - a.passRate ||
      a.mean.tokens - b.mean.tokens ||
      a.mean.durationMs - b.mean.durationMs ||
      a.mean.humanInterventions - b.mean.humanInterventions ||
      byId(a.variant, b.variant),
  );

  const ref = results.find((v) => v.variant === baseline)!;
  const win = results.find(
    (v) =>
      v.variant !== baseline &&
      v.eligible &&
      v.passRate >= ref.passRate - passTol &&
      (v.passRate > ref.passRate + passTol || v.mean.tokens < ref.mean.tokens * (1 - costTol)),
  );
  if (win)
    return {
      baseline,
      variants: results,
      winner: win.variant,
      reason: `${win.variant} beats baseline ${baseline}: pass rate ${win.passRate} vs ${ref.passRate}, mean tokens ${win.mean.tokens} vs ${ref.mean.tokens}`,
    };
  const others = results.filter((v) => v.variant !== baseline);
  let reason: string;
  if (others.length === 0) reason = `no variant to compare with baseline ${baseline}`;
  else if (others.some((v) => v.eligible))
    reason = `within noise: no eligible variant beats baseline ${baseline} beyond the tolerances`;
  else {
    const why = others
      .map((v) => `${v.variant} (${(v.regressions.length ? v.regressions : v.missing).join(", ")})`)
      .join("; ");
    reason = `${others.some((v) => v.regressions.length) ? "must-pass regression" : "no eligible variant, missing runs"}: ${why}`;
  }
  return { baseline, variants: results, winner: null, reason };
}
