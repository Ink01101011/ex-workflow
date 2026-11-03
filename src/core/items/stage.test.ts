import { test } from "node:test";
import assert from "node:assert/strict";
import { isTerminalStage, nextStageOf, stageOf } from "./stage.ts";
import { base, code } from "./fixtures.ts";

test("stage helpers", () => {
  const s = base();
  assert.equal(stageOf(s, "doing").name, "Doing");
  assert.equal(nextStageOf(s, "doing")!.id, "done");
  assert.equal(nextStageOf(s, "done"), undefined);
  assert.equal(isTerminalStage(s, "done"), true);
  assert.throws(
    () => stageOf(s, "nope"),
    (e) => code(e) === "unknown-stage",
  );
});
