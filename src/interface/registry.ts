import { WorkflowError, assertId, fail } from "../core/errors.ts";
import type { Methodology } from "../core/types.ts";

/** A methodology factory, as the built-in entries export them (`scrum`, `kanban`, ...). */
export type MethodologyFactory<N extends string = string> = () => Methodology<unknown, N>;

/** Name -> factory lookup: what `exwf init <name>` and a state's `methodology` resolve through. */
export interface MethodologyRegistry {
  /**
   * Adds `name`; a name already registered (a built-in included) fails `invalid-input`. The
   * factory is called once to check that it returns a Methodology named `name`.
   */
  registerMethodology<C, N extends string>(name: N, factory: () => Methodology<C, N>): void;
  /** The factory registered under `name`; an unknown name fails `invalid-input` listing the known ones. */
  methodologyFactory<N extends string = string>(name: N): MethodologyFactory<N>;
  /** Registered names, pre-registered ones first, then in registration order. */
  registeredMethodologies(): string[];
}

// the required members of a Methodology (src/core/types.ts) and their runtime kinds
const MEMBERS = [
  ["vocabulary", "object"],
  ["validateConfig", "function"],
  ["defaultStages", "function"],
  ["defaultRoles", "function"],
  ["requiredCapabilities", "array"],
  ["exclusiveCapabilities", "array"],
  ["plannerOptions", "function"],
  ["candidates", "function"],
  ["invariants", "function"],
  ["ceremonies", "object"],
  ["rules", "array"],
  ["metrics", "function"],
  ["humanDefaults", "object"],
] as const;

/**
 * A registry pre-registered with `initial`. The interface layer cannot import the methodologies,
 * so the outer ring passes the five built-ins in (design spec section 26, "Registry placement").
 */
// String() throws on a null-prototype value; for an Error it reads `Name: message`
const thrown = (e: unknown): string => {
  try {
    return String(e);
  } catch {
    return "a non-Error value";
  }
};

export function createMethodologyRegistry(
  // factories of different names share no sound common type (a ceremony is contravariant in
  // its state's name), so the table stores them untyped and lookup restores the name
  initial: Record<string, () => unknown>,
): MethodologyRegistry {
  const table = new Map<string, () => unknown>();
  const register = (name: string, factory: unknown, builtIn = false) => {
    assertId(name, "methodology name");
    if (typeof factory !== "function")
      fail(
        "invalid-input",
        `methodology "${name}" factory must be a function`,
        'pass the factory itself, e.g. registerMethodology("triage", triage)',
      );
    if (table.has(name))
      fail(
        "invalid-input",
        `methodology "${name}" is already registered`,
        `pick a name that is not one of: ${[...table.keys()].join(", ")}`,
      );
    // a custom factory runs once here, so a wrong result fails at registration, not at init
    if (!builtIn) {
      let m: Record<string, unknown> | null;
      try {
        m = (factory as () => unknown)() as Record<string, unknown> | null;
      } catch (e) {
        if (e instanceof WorkflowError) throw e;
        fail(
          "invalid-input",
          `methodology "${name}" factory threw: ${thrown(e)}`,
          "fix the factory: registration calls it once",
        );
      }
      const missing =
        typeof m !== "object" || m === null
          ? "an object"
          : m["name"] !== name
            ? `name "${name}"`
            : MEMBERS.find(([key, kind]) =>
                kind === "array" ? !Array.isArray(m[key]) : typeof m[key] !== kind || !m[key],
              )?.[0];
      if (missing)
        fail(
          "invalid-input",
          `methodology "${name}" factory must return a Methodology; it lacks ${missing}`,
          "return the full Methodology object (name, vocabulary, validateConfig, defaultStages, defaultRoles, capabilities, plannerOptions, candidates, invariants, ceremonies, rules, metrics, humanDefaults)",
        );
    }
    table.set(name, factory as () => unknown);
  };
  for (const [name, factory] of Object.entries(initial)) register(name, factory, true);
  return {
    registerMethodology: (name, factory) => register(name, factory),
    methodologyFactory<N extends string>(name: N): MethodologyFactory<N> {
      assertId(name, "methodology name");
      const factory = table.get(name);
      if (!factory)
        fail(
          "invalid-input",
          `unknown methodology "${name}"`,
          `known methodologies: ${[...table.keys()].join(", ") || "(none)"}; register a custom one with registerMethodology`,
        );
      return factory as MethodologyFactory<N>;
    },
    registeredMethodologies: () => [...table.keys()],
  };
}
