import { test, mock } from "node:test";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
  mkdir,
  unlink,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createState } from "../core/state.ts";
import { addItem } from "../core/items/record.ts";
import { WorkflowError } from "../core/errors.ts";
import { loadState, saveBrief, saveHandoff, saveState, statePath, withStateLock } from "./file.ts";
import type { Role, WorkflowState } from "../core/types.ts";

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
    (e: unknown) =>
      e instanceof WorkflowError &&
      e.code === "invalid-input" &&
      /\/id missing required property/.test(e.message),
  );
});

test("saveState refuses a state that fails the schema and writes nothing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "exwf-"));
  const bad = { ...fresh(), items: { X: { id: "X" } } } as unknown as WorkflowState;
  await assert.rejects(
    saveState(root, bad),
    (e: unknown) =>
      e instanceof WorkflowError &&
      e.code === "invalid-input" &&
      /state\.json does not match its schema: \/items\/X\/type/.test(e.message),
  );
  await assert.rejects(stat(statePath(root)));
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

test("loadState refuses a state that fails the schema, naming the file and the path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "exwf-"));
  const bad = { ...fresh(), items: { X: { id: "X" } } };
  await mkdir(path.join(root, ".workflow"), { recursive: true });
  await writeFile(statePath(root), JSON.stringify(bad));
  await assert.rejects(loadState(root), (e: unknown) => {
    assert.ok(e instanceof WorkflowError);
    assert.equal(e.code, "invalid-input");
    assert.match(
      e.message,
      /state\.json does not match its schema: \/items\/X\/type missing required property "type"/,
    );
    assert.match(e.fix, /\/items\/X\/type/);
    return true;
  });
});

test("loadState refuses a role manifest that fails the schema and does not merge the rest", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "exwf-"));
  await saveState(root, fresh());
  const dir = path.join(root, ".workflow", "roles");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "qa.json"),
    JSON.stringify({ ...dev, id: "qa", modelTier: "huge" }),
  );
  await assert.rejects(loadState(root), (e: unknown) => {
    assert.ok(e instanceof WorkflowError);
    assert.equal(e.code, "invalid-input");
    assert.match(
      e.message,
      /role manifest .*qa\.json does not match its schema: \/modelTier expected one of/,
    );
    return true;
  });
});

test("withStateLock does not unlink a stale lock that was replaced after the first stat (B01)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "exwf-"));
  await mkdir(path.join(root, ".workflow"));
  const lock = path.join(root, ".workflow", "state.lock");
  await writeFile(lock, "123 old\n");
  const old = new Date(Date.now() - 3_600_000);
  await utimes(lock, old, old);
  const realStat = fsp.stat;
  let replaced = false;
  mock.method(fsp, "stat", async (...args: Parameters<typeof realStat>) => {
    const st = await realStat(...args);
    if (!replaced && String(args[0]) === lock) {
      replaced = true;
      // another recoverer takes over right after our first stat
      await unlink(lock);
      await writeFile(lock, "999 fresh\n");
    }
    return st;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      withStateLock(root, async () => "stolen", { retries: 0, staleMs: 60_000 }),
      invalid,
    );
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(await readFile(lock, "utf8"), "999 fresh\n");
});

test("writeAtomic failure removes the temp file and throws invalid-input (B15)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "exwf-"));
  mock.method(fsp, "rename", async () => {
    throw new Error("EXDEV simulated");
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(saveState(root, fresh()), (e: unknown) => {
      assert.ok(e instanceof WorkflowError);
      assert.equal(e.code, "invalid-input");
      assert.match(e.message, /cannot write/);
      assert.ok(e.fix.length > 0);
      return true;
    });
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.deepEqual(await readdir(path.join(root, ".workflow")), []);
});

test("loadState refuses a malformed ext.investigation or ext.experimentation record (U9 P1)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "exwf-"));
  await saveState(root, fresh());
  for (const ext of [
    { investigation: { phase: "observe", rounds: null } },
    { experimentation: { candidates: null } },
  ]) {
    await writeFile(statePath(root), JSON.stringify({ ...fresh(), ext }));
    await assert.rejects(
      loadState(root),
      (e: unknown) =>
        e instanceof WorkflowError && e.code === "invalid-input" && /\/ext\//.test(e.message),
    );
  }
});

test("withStateLock gives up on a stale lock it cannot remove, naming the lock (U9 P2)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "exwf-"));
  await mkdir(path.join(root, ".workflow"));
  const lock = path.join(root, ".workflow", "state.lock");
  await writeFile(lock, "123 old\n");
  const realUnlink = fsp.unlink;
  let calls = 0;
  mock.method(fsp, "unlink", async (...args: Parameters<typeof realUnlink>) => {
    if (String(args[0]) !== lock) return realUnlink(...args);
    calls++;
    throw Object.assign(new Error("EPERM simulated"), { code: "EPERM" });
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      withStateLock(root, async () => "never", { retries: 3, intervalMs: 1, staleMs: -1 }),
      (e: unknown) => {
        assert.ok(e instanceof WorkflowError);
        assert.equal(e.code, "invalid-input");
        assert.ok(e.message.includes(lock), e.message);
        assert.match(e.fix, /delete/);
        return true;
      },
    );
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.ok(calls >= 1 && calls <= 4, `bounded unlink attempts, got ${calls}`);
});

test("withStateLock reports fs failures as WorkflowError, not a raw fs error (U9 P5)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "exwf-"));
  // .workflow is a file, so the lock directory cannot be created
  await writeFile(path.join(root, ".workflow"), "not a directory");
  await assert.rejects(
    withStateLock(root, async () => "never"),
    (e: unknown) => {
      assert.ok(e instanceof WorkflowError, String(e));
      assert.equal(e.code, "invalid-input");
      assert.match(e.message, /state\.lock/);
      return true;
    },
  );
  const root2 = await mkdtemp(path.join(tmpdir(), "exwf-"));
  mock.method(fsp, "open", async () => {
    throw Object.assign(new Error("EACCES simulated"), { code: "EACCES" });
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      withStateLock(root2, async () => "never"),
      (e: unknown) => {
        assert.ok(e instanceof WorkflowError, String(e));
        assert.equal(e.code, "invalid-input");
        assert.match(e.message, /EACCES simulated/);
        return true;
      },
    );
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("saveState and loadState refuse a deeply nested value with invalid-input, not RangeError (U9 P4)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "exwf-"));
  let deep: unknown = [];
  for (let i = 0; i < 100_000; i++) deep = [deep];
  const tooDeep = (e: unknown) => {
    assert.ok(e instanceof WorkflowError, String(e));
    assert.equal(e.code, "invalid-input");
    assert.match(e.message, /nested too deeply/);
    return true;
  };
  await assert.rejects(saveState(root, { ...fresh(), ext: { x: deep } }), tooDeep);
  await mkdir(path.join(root, ".workflow"), { recursive: true });
  const good = JSON.stringify(fresh());
  const n = 100_000;
  await writeFile(
    statePath(root),
    good.replace("{", `{"ext":{"x":${"[".repeat(n)}${"]".repeat(n)}},`),
  );
  // the validator does not descend into an open ext value, so the file loads; saving it back is refused
  const loaded = await loadState(root);
  await assert.rejects(saveState(root, loaded), tooDeep);
});

test("saveBrief and saveHandoff check the id and the seq; loadState checks each item's key (U9 P8)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "exwf-"));
  const h = { item: "A", role: "dev", produced: [], notes: "", do_not: [], open_questions: [] };
  // ids inside .workflow but not valid ids: the path check alone let these through
  await assert.rejects(saveBrief(root, { item: { id: "CON" } } as never), invalid);
  await assert.rejects(saveBrief(root, { item: { id: "a/b" } } as never), invalid);
  await assert.rejects(saveHandoff(root, { ...h, item: "toString" }, 1), invalid);
  for (const seq of [-1, 1.5, Number.NaN, 2 ** 53])
    await assert.rejects(saveHandoff(root, h, seq), invalid);
  assert.deepEqual(await readdir(root), []);

  await saveState(root, fresh());
  const s = addItem(fresh(), { id: "B", title: "b" }, "dev", T0);
  const item = s.items["B"];
  await writeFile(statePath(root), JSON.stringify({ ...s, items: { A: item } }));
  await assert.rejects(
    loadState(root),
    (e: unknown) => invalid(e) && /items\/A/.test((e as Error).message),
  );
});

test("saveBrief refuses an id that differs from an existing brief's only in case (U9 P6)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "exwf-"));
  await saveBrief(root, { item: { id: "Cart-1" } } as never);
  await saveBrief(root, { item: { id: "Cart-1" } } as never); // the same item again is fine
  await assert.rejects(
    saveBrief(root, { item: { id: "cart-1" } } as never),
    (e: unknown) => invalid(e) && /Cart-1/.test((e as Error).message),
  );
  assert.deepEqual(await readdir(path.join(root, ".workflow", "briefs")), ["Cart-1.json"]);
});

test("loadState checks role manifest ids and merges by own property (U11 O8)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "exwf-"));
  await saveState(root, fresh());
  const dir = path.join(root, ".workflow", "roles");
  await mkdir(dir, { recursive: true });
  for (const id of ["toString", "constructor", "CON"]) {
    await writeFile(path.join(dir, "x.json"), JSON.stringify({ ...dev, id }));
    await assert.rejects(
      loadState(root),
      (e: unknown) => invalid(e) && /x\.json/.test((e as Error).message),
      id,
    );
  }
});
