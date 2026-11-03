import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkflowError } from "./core/errors.ts";
import { init } from "./core/methodology.ts";
import type { Methodology } from "./core/types.ts";
import { methodologyFactory, registerMethodology, registeredMethodologies } from "./registry.ts";

const BUILTINS = ["scrum", "kanban", "waterfall", "investigation", "experimentation"];

test("the five built-ins are pre-registered", () => {
  assert.deepEqual(registeredMethodologies().slice(0, 5), BUILTINS);
  for (const name of BUILTINS) assert.equal(methodologyFactory(name)().name, name);
});

test("a built-in name cannot be registered again", () => {
  for (const name of BUILTINS)
    assert.throws(
      () => registerMethodology(name, methodologyFactory(name)),
      (e: unknown) => e instanceof WorkflowError && e.code === "invalid-input",
    );
});

test("a custom methodology registers once and resolves to a factory init accepts", () => {
  // kanban's pieces under another name: a runtime stand-in, so the type is asserted
  const triage = () =>
    ({ ...methodologyFactory("kanban")(), name: "triage" }) as unknown as Methodology<
      unknown,
      "triage"
    >;
  registerMethodology("triage", triage);
  assert.deepEqual(registeredMethodologies(), [...BUILTINS, "triage"]);
  const state = init({ methodology: methodologyFactory("triage")(), config: {} }).state;
  assert.equal(state.methodology, "triage");
  assert.throws(() => registerMethodology("triage", triage), WorkflowError);
  assert.throws(
    () => methodologyFactory("nope"),
    (e: unknown) =>
      e instanceof WorkflowError &&
      e.code === "invalid-input" &&
      e.fix.includes([...BUILTINS, "triage"].join(", ")),
  );
});
