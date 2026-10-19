import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createState } from "../state.ts";
import { WorkflowError } from "../errors.ts";
import { loadState, saveBrief, saveHandoff, saveState, statePath, withStateLock } from "./file.ts";
import type { Role } from "../types.ts";

const T0 = "2026-10-19T00:00:00.000Z";
const dev: Role = {
  id: "dev",
  name: "Dev",
  modelTier: "small",
  capabilities: ["deliver"],
  canApprove: [],
  inputs: [],
  outputs: [],
  do_not: [],
};
const fresh = () =>
  createState({
    methodology: "scrum",
    config: {},
    stages: [{ id: "todo", name: "t", entryPolicy: [], exitPolicy: [] }],
    roles: [dev],
    now: T0,
  });

test("save then load round-trips and leaves no temp files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "exwf-"));
  await saveState(root, fresh());
  const files = await readdir(path.join(root, ".workflow"));
  assert.deepEqual(files, ["state.json"]);
  assert.equal(statePath(root), path.join(root, ".workflow", "state.json"));
  const loaded = await loadState(root);
  assert.deepEqual(loaded, fresh());
  assert.equal((await readFile(statePath(root), "utf8")).split("\n").length > 5, true); // pretty printed
});

test("loadState merges role manifests and reports missing or wrong-version files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "exwf-"));
  await assert.rejects(
    loadState(root),
    (e: unknown) =>
      e instanceof WorkflowError && e.code === "invalid-input" && /exwf init/.test(e.fix),
  );
  await saveState(root, fresh());
  await mkdir(path.join(root, ".workflow", "roles"), { recursive: true });
  await writeFile(
    path.join(root, ".workflow", "roles", "qa.json"),
    JSON.stringify({ ...dev, id: "qa", capabilities: ["review"] }),
  );
  await writeFile(
    path.join(root, ".workflow", "roles", "dev.json"),
    JSON.stringify({ ...dev, name: "SHOULD NOT OVERWRITE" }),
  );
  const loaded = await loadState(root);
  assert.equal(loaded.roles["qa"]?.capabilities[0], "review");
  assert.equal(loaded.roles["dev"]?.name, "Dev");
  await writeFile(statePath(root), JSON.stringify({ ...fresh(), version: 2 }));
  await assert.rejects(
    loadState(root),
    (e: unknown) => e instanceof WorkflowError && e.code === "state-version",
  );
  await writeFile(statePath(root), "{not json");
  await assert.rejects(
    loadState(root),
    (e: unknown) => e instanceof WorkflowError && e.code === "invalid-input",
  );
});

test("loadState rejects non-object state and malformed role manifests with invalid-input", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "exwf-"));
  await saveState(root, fresh());
  await writeFile(statePath(root), "null");
  await assert.rejects(
    loadState(root),
    (e: unknown) => e instanceof WorkflowError && e.code === "invalid-input",
  );
  await saveState(root, fresh());
  await mkdir(path.join(root, ".workflow", "roles"), { recursive: true });
  await writeFile(path.join(root, ".workflow", "roles", "bad.json"), "{not json");
  await assert.rejects(
    loadState(root),
    (e: unknown) =>
      e instanceof WorkflowError && e.code === "invalid-input" && /bad\.json/.test(e.message),
  );
  await writeFile(path.join(root, ".workflow", "roles", "bad.json"), "{}");
  await assert.rejects(
    loadState(root),
    (e: unknown) => e instanceof WorkflowError && e.code === "invalid-input",
  );
});

test("saveBrief and saveHandoff write under .workflow", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "exwf-"));
  const b = await saveBrief(root, { item: { id: "A" } } as never);
  assert.equal(b, path.join(root, ".workflow", "briefs", "A.json"));
  const h = await saveHandoff(
    root,
    { item: "A", role: "dev", produced: [], notes: "", do_not: [], open_questions: [] },
    7,
  );
  assert.equal(h, path.join(root, ".workflow", "handoffs", "A-7.json"));
  assert.equal(JSON.parse(await readFile(h, "utf8")).item, "A");
});

const invalid = (e: unknown) => e instanceof WorkflowError && e.code === "invalid-input";

test("withStateLock serialises concurrent holders and removes the lock", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "exwf-"));
  const log: string[] = [];
  const hold = (name: string) => async () => {
    log.push(`${name}:start`);
    await new Promise((r) => setTimeout(r, 40));
    log.push(`${name}:end`);
    return name;
  };
  const opts = { retries: 100, intervalMs: 5 };
  const out = await Promise.all([
    withStateLock(root, hold("a"), opts),
    withStateLock(root, hold("b"), opts),
  ]);
  assert.deepEqual(out, ["a", "b"]);
  const first = log[0]!.split(":")[0];
  const second = first === "a" ? "b" : "a";
  assert.deepEqual(log, [`${first}:start`, `${first}:end`, `${second}:start`, `${second}:end`]);
  assert.deepEqual(await readdir(path.join(root, ".workflow")), []);
});

test("withStateLock gives up with invalid-input and releases the lock after an error", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "exwf-"));
  await withStateLock(
    root,
    () =>
      assert.rejects(
        withStateLock(root, async () => "never", { retries: 2, intervalMs: 5 }),
        invalid,
      ),
    { retries: 0 },
  );
  await assert.rejects(
    withStateLock(root, async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(await withStateLock(root, async () => "free", { retries: 0 }), "free");
});

test("withStateLock takes over a stale lock", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "exwf-"));
  await mkdir(path.join(root, ".workflow"));
  await writeFile(path.join(root, ".workflow", "state.lock"), "123 old\n");
  assert.equal(await withStateLock(root, async () => "ok", { retries: 0, staleMs: -1 }), "ok");
});

test("saveBrief and saveHandoff refuse ids that escape .workflow", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "exwf-"));
  await assert.rejects(
    saveBrief(root, { item: { id: "../../evil" } } as unknown as Parameters<typeof saveBrief>[1]),
    invalid,
  );
  await assert.rejects(
    saveHandoff(root, { item: "../../evil" } as unknown as Parameters<typeof saveHandoff>[1], 1),
    invalid,
  );
});
