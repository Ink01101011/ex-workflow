// The methodology registry with the five built-ins pre-registered (design spec section 26,
// "Registry placement"). Outer ring: src/interface/ may not import src/methodologies/, so the
// built-in table lives here. The registry is created on first use, so a bundle that never
// calls these functions does not keep the built-in factories.
import { experimentation } from "./methodologies/experimentation/index.ts";
import { investigation } from "./methodologies/investigation/index.ts";
import { kanban } from "./methodologies/kanban/index.ts";
import { scrum } from "./methodologies/scrum/index.ts";
import { waterfall } from "./methodologies/waterfall/index.ts";
import {
  createMethodologyRegistry,
  type MethodologyFactory,
  type MethodologyRegistry,
} from "./interface/registry.ts";
import type { Methodology } from "./core/types.ts";

let registry: MethodologyRegistry | undefined;
const builtins = (): MethodologyRegistry =>
  (registry ??= createMethodologyRegistry({
    scrum,
    kanban,
    waterfall,
    investigation,
    experimentation,
  }));

/** Registers a custom methodology (SDK only in 1.2); a taken name, a built-in included, fails `invalid-input`. */
export function registerMethodology<C, N extends string>(
  name: N,
  factory: () => Methodology<C, N>,
): void {
  builtins().registerMethodology(name, factory);
}

/** The factory registered under `name`; an unknown name fails `invalid-input` listing the known ones. */
export function methodologyFactory<N extends string = string>(name: N): MethodologyFactory<N> {
  return builtins().methodologyFactory(name);
}

/** The registered names: the five built-ins, then custom ones in registration order. */
export function registeredMethodologies(): string[] {
  return builtins().registeredMethodologies();
}
