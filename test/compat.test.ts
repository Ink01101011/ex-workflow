import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadState, saveState, statePath, WORKFLOW_DIR } from "../src/adapters/file.ts";
import { next } from "../src/index.ts";
import { experimentation } from "../src/methodologies/experimentation/index.ts";
import { investigation } from "../src/methodologies/investigation/index.ts";
import { kanban } from "../src/methodologies/kanban/index.ts";
import { scrum } from "../src/methodologies/scrum/index.ts";
import { waterfall } from "../src/methodologies/waterfall/index.ts";
import type { Methodology } from "../src/index.ts";
import { readExt } from "../src/interface/ext.ts";

const T_NOW = "2026-11-03T00:00:00.000Z";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "compat");
const METHODOLOGIES: Record<string, () => Methodology> = {
  scrum: scrum as () => Methodology,
  kanban: kanban as () => Methodology,
  waterfall: waterfall as () => Methodology,
  investigation: investigation as () => Methodology,
  experimentation: experimentation as () => Methodology,
};

// no Array#toSorted: it needs Node 20 and the tests run on Node 18
// oxlint-disable-next-line unicorn/no-array-sort
const sorted = (xs: string[]): string[] => xs.sort();
const dirs = (p: string) =>
  readdir(p, { withFileTypes: true }).then((es) =>
    sorted(es.filter((e) => e.isDirectory()).map((e) => e.name)),
  );

const versions = await dirs(FIXTURES);
assert.ok(versions.length > 0, "no compat fixtures found; run scripts/gen-compat-fixtures.mjs");

for (const version of versions) {
  for (const name of await dirs(path.join(FIXTURES, version))) {
    test(`${version}/${name}`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), "exwf-compat-"));
      try {
        // fixtures are stored as <dir>/state.json (+ roles/); lay them out as a project's .workflow/
        const wf = path.join(root, WORKFLOW_DIR);
        await mkdir(wf, { recursive: true });
        await cp(path.join(FIXTURES, version, name), wf, { recursive: true });

        const state = await loadState(root); // runs the schema validation
        assert.equal(state.version, 1);
        assert.equal(state.methodology, name);

        const m = METHODOLOGIES[name]!();
        const metrics = m.metrics(state);
        assert.equal(typeof metrics, "object");
        assert.notEqual(metrics, null);
        if (m.report) {
          const report = m.report(state);
          assert.equal(typeof report, "object");
          assert.notEqual(report, null);
        }
        // planning is pure: no I/O, the loaded state is untouched
        const before = JSON.stringify(state);
        const res = next(state, m, { max: 1, now: new Date().toISOString() });
        assert.ok(Array.isArray(res.briefs));
        assert.equal(JSON.stringify(state), before);

        // round trip
        const out = await mkdtemp(path.join(tmpdir(), "exwf-compat-out-"));
        try {
          await saveState(out, state);
          assert.ok(statePath(out).length > 0);
          assert.deepEqual(await loadState(out), state);
        } finally {
          await rm(out, { recursive: true, force: true });
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

// Dual-write (design spec section 26, "Extension state"): a 1.1.1 state has only the legacy
// top-level record; the first ceremony after loading writes ext.<name> and mirrors the legacy field.
const DUAL_WRITE_PROBES = {
  investigation: { ceremony: "stop", input: { by: "investigator", reason: "compat probe" } },
  experimentation: {
    ceremony: "provision",
    input: { by: "coordinator", candidate: "A2", workspace: "w-A2", isolated: true },
  },
} as const;
for (const name of ["investigation", "experimentation"] as const) {
  test(`1.1.1/${name}: a ceremony after load writes ext.${name} and the equal legacy mirror`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "exwf-dual-"));
    try {
      const wf = path.join(root, WORKFLOW_DIR);
      await mkdir(wf, { recursive: true });
      await cp(path.join(FIXTURES, "1.1.1", name), wf, { recursive: true });
      const loaded = await loadState(root);
      assert.equal(Object.hasOwn(loaded, "ext"), false, "a 1.1.1 state has no ext");
      const legacy = loaded[name];
      assert.ok(legacy, `the fixture carries the legacy ${name} record`);
      // the accessor falls back to the legacy record
      assert.deepEqual(readExt(loaded, name), legacy);

      const m = METHODOLOGIES[name]!();
      const probe = DUAL_WRITE_PROBES[name];
      const baseSha = readExt(loaded, "experimentation")?.baseSha;
      const res = m.ceremonies[probe.ceremony]!(loaded, {
        ...probe.input,
        ...(baseSha ? { baseSha } : {}),
        now: T_NOW,
      });
      await saveState(root, res.state);
      const saved = await loadState(root);
      assert.ok(saved.ext && Object.hasOwn(saved.ext, name), `saved state has ext.${name}`);
      assert.deepEqual(saved.ext[name], saved[name]);
      assert.notDeepEqual(saved[name], legacy, "the ceremony changed the record");

      // on disk only ext.<name> (U10 F1): the legacy mirror is rebuilt on load, by reference
      const onDisk = JSON.parse(await readFile(statePath(root), "utf8")) as Record<string, unknown>;
      assert.equal(Object.hasOwn(onDisk, name), false, `state.json carries no top-level ${name}`);
      assert.equal(saved[name], saved.ext[name], "the mirror is the ext record itself");

      // a hand-edited file carrying both: ext wins
      await writeFile(statePath(root), JSON.stringify({ ...onDisk, [name]: legacy }));
      const both = await loadState(root);
      assert.equal(both[name], both.ext?.[name]);
      assert.notDeepEqual(both[name], legacy);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
