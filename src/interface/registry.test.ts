import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkflowError } from "../core/errors.ts";
import type { Methodology } from "../core/types.ts";
import { createMethodologyRegistry } from "./registry.ts";

const fake = <N extends string>(name: N) =>
  (() => ({ name }) as unknown as Methodology<unknown, N>) satisfies () => Methodology<unknown, N>;
const code = (e: unknown) => (e instanceof WorkflowError ? e.code : String(e));

test("the initial table is pre-registered and listed in insertion order", () => {
  const r = createMethodologyRegistry({ scrum: fake("scrum"), kanban: fake("kanban") });
  assert.deepEqual(r.registeredMethodologies(), ["scrum", "kanban"]);
  assert.equal(r.methodologyFactory("kanban")().name, "kanban");
});

test("registering a custom name makes it resolvable", () => {
  const r = createMethodologyRegistry({ scrum: fake("scrum") });
  r.registerMethodology("triage", fake("triage"));
  assert.deepEqual(r.registeredMethodologies(), ["scrum", "triage"]);
  const m: Methodology<unknown, "triage"> = r.methodologyFactory("triage")();
  assert.equal(m.name, "triage");
});

test("registering a taken name fails invalid-input with a fix", () => {
  const r = createMethodologyRegistry({ scrum: fake("scrum") });
  r.registerMethodology("triage", fake("triage"));
  for (const name of ["scrum", "triage"])
    assert.throws(
      () => r.registerMethodology(name, fake(name)),
      (e: unknown) =>
        code(e) === "invalid-input" &&
        (e as WorkflowError).message.includes(`"${name}" is already registered`) &&
        (e as WorkflowError).fix.length > 0,
    );
});

test("an unknown name fails invalid-input listing the known names", () => {
  const r = createMethodologyRegistry({ scrum: fake("scrum"), kanban: fake("kanban") });
  assert.throws(
    () => r.methodologyFactory("triage"),
    (e: unknown) =>
      code(e) === "invalid-input" &&
      (e as WorkflowError).message.includes('"triage"') &&
      (e as WorkflowError).fix.includes("scrum, kanban"),
  );
});

test("names are ids and factories are functions", () => {
  const r = createMethodologyRegistry({});
  for (const name of ["", "__proto__", "a b"])
    assert.throws(() => r.registerMethodology(name, fake(name)), WorkflowError);
  assert.throws(
    () => r.registerMethodology("x", "nope" as unknown as () => Methodology<unknown, "x">),
    (e: unknown) => code(e) === "invalid-input",
  );
  assert.throws(() => r.methodologyFactory("constructor"), WorkflowError);
});

test("registries are independent", () => {
  const a = createMethodologyRegistry({});
  const b = createMethodologyRegistry({});
  a.registerMethodology("triage", fake("triage"));
  assert.deepEqual(b.registeredMethodologies(), []);
});
