import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("generated.ts matches a fresh generation (pnpm schema:check)", () => {
  const r = spawnSync(process.execPath, ["scripts/gen-schema.mjs", "--check"], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
});
