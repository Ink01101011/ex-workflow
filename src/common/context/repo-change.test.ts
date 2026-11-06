import { test } from "node:test";
import assert from "node:assert/strict";
import { createState } from "../../core/state.ts";
import { addItem } from "../../core/items/record.ts";
import { moveItem } from "../../core/items/move.ts";
import { WorkflowError } from "../../core/errors.ts";
import type { ItemStatus, Methodology, Rule, WorkflowState } from "../../core/types.ts";
import { kanban } from "../../methodologies/kanban/index.ts";
import { contextOf, recordContextSnapshot } from "./snapshot.ts";
import { recordRepoChange } from "./repo-change.ts";

const T0 = "2026-11-06T00:00:00.000Z";
const m = kanban();
const srm = "service-request-manager";
const STATUSES: ItemStatus[] = ["todo", "in_progress", "review", "awaiting_human", "done"];
/** One item per status, each with a snapshot citing src/<id>.ts and src/shared.ts. */
const board = (): WorkflowState => {
  const config = m.validateConfig({});
  let s = createState({
    methodology: "kanban",
    config,
    stages: m.defaultStages(config),
    roles: m.defaultRoles(config),
    now: T0,
  });
  for (const status of STATUSES) {
    const id = status.toUpperCase().replace("_", "-");
    s = addItem(s, { id, title: status }, srm, T0);
    s = recordContextSnapshot(s, m, {
      item: id,
      revision: "r1",
      assumptions: [
        { claim: `${id} own`, source: { path: `src/${id}.ts`, hash: "h" } },
        { claim: "shared", required: true, source: { path: "src/shared.ts", hash: "h" } },
      ],
      ref: `ctx/${id}`,
      by: "human",
      now: T0,
    }).state;
    if (status !== "todo") s = moveItem(s, id, { stage: "dev", status }, "worker", T0);
  }
  return s;
};
const invalid = (input: unknown, re: RegExp) =>
  assert.throws(
    () => recordRepoChange(board(), m, input as never),
    (e) => e instanceof WorkflowError && e.code === "invalid-input" && re.test(e.message),
    JSON.stringify(input),
  );

test("recordRepoChange appends repo.changed { revision, paths } through applyAction and changes no status", () => {
  const seen: string[] = [];
  const rule: Rule = { id: "spy", severity: "warning", check: (_s, a) => (seen.push(a.type), []) };
  const spy: Methodology = { ...m, rules: [...m.rules, rule] };
  const before = board();
  const r = recordRepoChange(before, spy, {
    revision: "r2",
    paths: ["docs/a.md", "src/x.ts", "docs/a.md"],
    by: "ci",
    now: T0,
  });
  assert.deepEqual(seen, ["repo.change"]);
  const ev = r.state.events.at(-1)!;
  assert.equal(ev.type, "repo.changed");
  assert.equal(ev.by, "ci");
  // deduplicated in input order
  assert.deepEqual(ev.payload, { revision: "r2", paths: ["docs/a.md", "src/x.ts"] });
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.state.items, before.items);
});

test("recordRepoChange warns context-stale once per in-flight item whose snapshot it made stale", () => {
  const r = recordRepoChange(board(), m, {
    revision: "r2",
    paths: ["src/IN-PROGRESS.ts", "src/shared.ts", "src/TODO.ts"],
    by: "ci",
    now: T0,
  });
  // todo and done items get no warning: a todo item is re-checked by its entry policy at dispatch
  assert.deepEqual(
    r.warnings.map((w) => [w.rule, w.severity, w.item]),
    [
      ["context-stale", "warning", "IN-PROGRESS"],
      ["context-stale", "warning", "REVIEW"],
      ["context-stale", "warning", "AWAITING-HUMAN"],
    ],
  );
  const w = r.warnings[0]!;
  assert.match(w.message, /"IN-PROGRESS"/);
  assert.match(w.message, /src\/IN-PROGRESS\.ts, src\/shared\.ts/);
  assert.match(w.message, /r2/);
  assert.match(w.fix, /recordContextSnapshot/);
  assert.doesNotMatch(r.warnings[1]!.message, /IN-PROGRESS\.ts/);
  for (const status of STATUSES) {
    const id = status.toUpperCase().replace("_", "-");
    assert.equal(r.state.items[id]!.status, status);
  }
  assert.deepEqual(contextOf(r.state, r.state.items["TODO"]!)!.stale, [
    "src/shared.ts",
    "src/TODO.ts",
  ]);
});

test("recordRepoChange does not warn again for a path that was already stale", () => {
  let r = recordRepoChange(board(), m, { revision: "r2", paths: ["src/shared.ts"], by: "ci" });
  assert.equal(r.warnings.length, 3);
  r = recordRepoChange(r.state, m, { revision: "r3", paths: ["docs/x.md"], by: "ci" });
  assert.deepEqual(r.warnings, []);
  r = recordRepoChange(r.state, m, { revision: "r4", paths: ["src/shared.ts"], by: "ci" });
  assert.deepEqual(r.warnings, []);
  // a newly cited path of the same snapshot still warns
  r = recordRepoChange(r.state, m, { revision: "r5", paths: ["src/REVIEW.ts"], by: "ci" });
  assert.deepEqual(
    r.warnings.map((w) => [w.item, w.message.includes("src/REVIEW.ts")]),
    [["REVIEW", true]],
  );
});

test("recordRepoChange refuses malformed input with invalid-input", () => {
  const good = { revision: "r2", paths: ["a.ts"], by: "ci" };
  invalid(null, /must be an object/);
  invalid({ ...good, extra: 1 }, /unknown key "extra"/);
  invalid({ ...good, revision: "" }, /revision/);
  invalid({ ...good, paths: [] }, /paths/);
  invalid({ ...good, paths: "a.ts" }, /paths/);
  invalid({ ...good, paths: ["a.ts", ""] }, /paths\[1\]/);
  invalid({ ...good, paths: ["./a.ts"] }, /repository-relative POSIX/);
  invalid({ ...good, paths: ["a\\b.ts"] }, /repository-relative POSIX/);
  // G2-8, G4-4, G4-5: control characters and a non-NFC spelling; the fix names git's -z output
  invalid({ ...good, paths: ["a.ts\n"] }, /control/);
  assert.throws(
    () => recordRepoChange(board(), m, { ...good, paths: ['"caf\\303\\251.ts"'] }),
    (e) => e instanceof WorkflowError && /git diff --name-only -z/.test(e.fix),
  );
  invalid({ ...good, paths: ["cafe\u0301.ts"] }, /NFC/);
  invalid({ ...good, by: "" }, /by/);
  invalid({ ...good, now: 1 }, /now/);
});

test("G3-3, G2-6: recordRepoChange reads the log a fixed number of times, not once per in-flight item", () => {
  const config = m.validateConfig({});
  let s = createState({
    methodology: "kanban",
    config,
    stages: m.defaultStages(config),
    roles: m.defaultRoles(config),
    now: T0,
  });
  const N = 200;
  for (let i = 0; i < N; i++) {
    const id = `I${i}`;
    s = addItem(s, { id, title: id }, srm, T0);
    s = recordContextSnapshot(s, m, {
      item: id,
      revision: "r1",
      assumptions: [{ claim: "c", source: { path: `src/${i % 7}.ts`, hash: "h" } }],
      ref: `ctx/${id}`,
      by: "human",
      now: T0,
    }).state;
    s = moveItem(s, id, { stage: "dev", status: "in_progress" }, "worker", T0);
  }
  let reads = 0;
  const events = new Proxy(s.events, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^[0-9]+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  const res = recordRepoChange({ ...s, events }, m, {
    revision: "r2",
    paths: ["src/0.ts", "src/1.ts"],
    by: "ci",
  });
  assert.equal(res.warnings.length, Math.ceil(N / 7) + Math.ceil((N - 1) / 7));
  // before the index: two full scans per in-flight item (about 2 * N * E reads)
  assert.ok(reads < 10 * s.events.length, `${reads} reads of a ${s.events.length}-event log`);
});
