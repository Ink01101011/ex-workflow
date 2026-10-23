import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadState, saveState, statePath, WORKFLOW_DIR } from "../src/adapters/file.ts";
import { next } from "../src/index.ts";
import { kanban } from "../src/kanban/index.ts";
import { scrum } from "../src/scrum/index.ts";
import { waterfall } from "../src/waterfall/index.ts";
import type { Methodology } from "../src/index.ts";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "compat");
const METHODOLOGIES: Record<string, () => Methodology> = {
  scrum: scrum as () => Methodology,
  kanban: kanban as () => Methodology,
  waterfall: waterfall as () => Methodology,
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
