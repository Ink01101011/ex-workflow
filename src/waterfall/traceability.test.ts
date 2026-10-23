import { test } from "node:test";
import assert from "node:assert/strict";
import { init } from "../methodology.ts";
import { addItem, moveItem } from "../items.ts";
import { waterfall } from "./index.ts";
import { missingTraces, traceabilityMatrix } from "./traceability.ts";

const T0 = "2026-10-22T00:00:00.000Z";

test("traceability links in either direction, skips questions and dropped items, reports coverage", () => {
  let s = init({ methodology: waterfall(), config: {}, now: T0 }).state;
  s = addItem(s, { id: "R1", title: "r1", phase: "requirements" }, "human", T0);
  s = addItem(s, { id: "R2", title: "r2", phase: "requirements", traces: ["D2"] }, "human", T0);
  s = addItem(s, { id: "R3", title: "r3", phase: "requirements" }, "human", T0);
  s = addItem(s, { id: "R1-q1", title: "q", type: "question", parent: "R1" }, "human", T0);
  s = addItem(s, { id: "D1", title: "d1", phase: "design", traces: ["R1"] }, "human", T0);
  s = addItem(s, { id: "D2", title: "d2", phase: "design" }, "human", T0);
  s = addItem(
    s,
    { id: "V1", title: "v1", phase: "verification", traces: ["R1", "R2"] },
    "human",
    T0,
  );
  s = addItem(
    s,
    { id: "V0", title: "dropped", phase: "verification", traces: ["R3"] },
    "human",
    T0,
  );
  s = moveItem(s, "V0", { status: "dropped" }, "human", T0);
  const m = traceabilityMatrix(s);
  assert.equal(m.from, "requirements");
  assert.deepEqual(m.to, ["design", "verification"]);
  assert.deepEqual(m.rows, [
    { item: "R1", links: { design: ["D1"], verification: ["V1"] } },
    { item: "R2", links: { design: ["D2"], verification: ["V1"] } },
    { item: "R3", links: { design: [], verification: [] } },
  ]);
  assert.deepEqual(m.missing, [{ item: "R3", phases: ["design", "verification"] }]);
  assert.deepEqual(m.coverage, { traced: 2, total: 3 });
  assert.deepEqual(missingTraces(s, "design"), ["R3"]);
  assert.deepEqual(missingTraces(s, "verification"), ["R3"]);
});

test("no traceability configured: empty matrix", () => {
  const s = init({
    methodology: waterfall(),
    config: { phases: [{ id: "a" }, { id: "b" }] },
    now: T0,
  }).state;
  assert.deepEqual(traceabilityMatrix(s), {
    from: "a",
    to: [],
    rows: [],
    missing: [],
    coverage: { traced: 0, total: 0 },
  });
});
