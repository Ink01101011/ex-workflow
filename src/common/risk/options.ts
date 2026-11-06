// Validation of the risk-adaptive gate options (design spec section 27, #35; F1 G1-4, G1-6): one
// validator for `withRiskGate` (once, at wrap time) and `riskEscalation` (per call, unless given the
// frozen options the validator itself returned), so both refuse the same input with invalid-input.
import { assertId, fail } from "../../core/errors.ts";
import type { GateRequirement } from "../../core/types.ts";
import { deepFreeze } from "../deep-freeze.ts";
import type { RiskGateOptions, RiskLevel, RiskTable } from "./escalation.ts";

/** The levels, least strict first. */
export const RISK_LEVELS: readonly RiskLevel[] = /* @__PURE__ */ deepFreeze([
  "low",
  "medium",
  "high",
  "critical",
]);

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const validated = new WeakSet<object>();

/**
 * `options` validated and copied (deeply frozen), so later changes by the caller do not leak in.
 * Refuses `invalid-input`, prefixed with `who`, for: a non-object or an unknown key; `gates` not an
 * array of valid ids; a `table` that is not an object keyed by exactly the four levels, a row with
 * an unknown key, a requirement that is neither `"human"` nor `{ capability: <non-empty string> }`,
 * an evidence kind that is not a non-empty string; and a row that does not include every
 * requirement and evidence kind of the level below it (a stricter level only adds, G1-4).
 */
export function riskOptions(options: unknown, who: string): Required<RiskGateOptions> {
  if (typeof options === "object" && options !== null && validated.has(options))
    return options as Required<RiskGateOptions>;
  const bad = (what: string, fix: string): never =>
    fail("invalid-input", `${who} options: ${what}`, fix);
  const closed = (o: Record<string, unknown>, keys: readonly string[], at: string): void => {
    for (const k of Object.keys(o))
      if (!keys.includes(k)) bad(`unknown key "${k}" in ${at}`, `use only: ${keys.join(", ")}`);
  };
  const requirement = (q: unknown, at: string): GateRequirement => {
    if (q === "human") return q;
    if (
      !isObj(q) ||
      typeof q["capability"] !== "string" ||
      q["capability"].trim() === "" ||
      Object.keys(q).length !== 1
    )
      bad(
        `${at} must be "human" or { capability: <name> }`,
        'e.g. ["human"] or [{ "capability": "review" }]',
      );
    return { capability: (q as { capability: string }).capability };
  };
  if (!isObj(options)) bad("must be an object", 'pass { "gates": ["code-review"] }');
  const o = options as Record<string, unknown>;
  closed(o, ["gates", "table"], "options");
  if (!Array.isArray(o["gates"]))
    bad("gates must be an array of gate ids", 'e.g. "gates": ["code-review"]');
  const gates = (o["gates"] as unknown[]).map((g) => {
    assertId(g, "risk gate id");
    return g as string;
  });
  const raw = o["table"];
  let table: RiskTable | undefined;
  if (raw !== undefined) {
    if (!isObj(raw))
      bad("table must be an object keyed by risk level", `levels: ${RISK_LEVELS.join(", ")}`);
    const t = raw as Record<string, unknown>;
    closed(t, RISK_LEVELS, "table");
    table = {} as RiskTable;
    let below: string[] = [];
    for (const level of RISK_LEVELS) {
      const row = t[level];
      if (!isObj(row))
        bad(
          `table is missing level "${level}"`,
          `give every level a row, e.g. "${level}": { "requires": [] }`,
        );
      const rw = row as Record<string, unknown>;
      closed(rw, ["requires", "evidence"], `table.${level}`);
      if (!Array.isArray(rw["requires"]))
        bad(`table.${level}.requires must be an array`, 'e.g. "requires": ["human"]');
      const ev = rw["evidence"];
      if (
        ev !== undefined &&
        (!Array.isArray(ev) || !ev.every((k) => typeof k === "string" && k.trim() !== ""))
      )
        bad(
          `table.${level}.evidence must be an array of evidence kinds`,
          'e.g. "evidence": ["sbom"]',
        );
      const requires = (rw["requires"] as unknown[]).map((q, i) =>
        requirement(q, `table.${level}.requires[${i}]`),
      );
      const evidence = ev === undefined ? undefined : [...(ev as string[])];
      // each level includes everything the level below it adds; requirements and evidence kinds
      // are separate sets (G5-4: evidence "human" is not the requirement "human")
      const here = [
        ...requires.map((x) => JSON.stringify(x)),
        ...(evidence ?? []).map((k) => `evidence ${JSON.stringify(k)}`),
      ];
      const missing = below.filter((x) => !here.includes(x));
      if (missing.length)
        bad(
          `table.${level} must include everything the level below it adds (missing ${missing.join(", ")})`,
          "a stricter level only adds: copy the lower level's requires and evidence into it",
        );
      below = here;
      table[level] = { requires, ...(evidence === undefined ? {} : { evidence }) };
    }
  }
  const out = deepFreeze(table ? { gates, table } : ({ gates } as Required<RiskGateOptions>));
  validated.add(out);
  return out;
}
