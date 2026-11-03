import { assertId, fail } from "../core/errors.ts";
import type { Methodology } from "../core/types.ts";

/** A methodology factory, as the built-in entries export them (`scrum`, `kanban`, ...). */
export type MethodologyFactory<N extends string = string> = () => Methodology<unknown, N>;

/** Name -> factory lookup: what `exwf init <name>` and a state's `methodology` resolve through. */
export interface MethodologyRegistry {
  /** Adds `name`; a name already registered (a built-in included) fails `invalid-input`. */
  registerMethodology<C, N extends string>(name: N, factory: () => Methodology<C, N>): void;
  /** The factory registered under `name`; an unknown name fails `invalid-input` listing the known ones. */
  methodologyFactory<N extends string = string>(name: N): MethodologyFactory<N>;
  /** Registered names, pre-registered ones first, then in registration order. */
  registeredMethodologies(): string[];
}

/**
 * A registry pre-registered with `initial`. The interface layer cannot import the methodologies,
 * so the outer ring passes the five built-ins in (design spec section 26, "Registry placement").
 */
export function createMethodologyRegistry(
  // factories of different names share no sound common type (a ceremony is contravariant in
  // its state's name), so the table stores them untyped and lookup restores the name
  initial: Record<string, () => unknown>,
): MethodologyRegistry {
  const table = new Map<string, () => unknown>();
  const register = (name: string, factory: unknown) => {
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
    table.set(name, factory as () => unknown);
  };
  for (const [name, factory] of Object.entries(initial)) register(name, factory);
  return {
    registerMethodology: register,
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
