import { test } from "node:test";
import assert from "node:assert/strict";
import { appendEvent, createState } from "../../core/state.ts";
import { addEvidence } from "../../core/items/evidence.ts";
import { addItem } from "../../core/items/record.ts";
import { moveItem } from "../../core/items/move.ts";
import { WorkflowError } from "../../core/errors.ts";
import type { ContextAssumption, Methodology, Rule, WorkflowState } from "../../core/types.ts";
import { kanban } from "../../methodologies/kanban/index.ts";
import { contextOf, recordContextSnapshot, repoPathIssue } from "./snapshot.ts";

const T0 = "2026-11-06T00:00:00.000Z";
const m = kanban();
const base = (): WorkflowState => {
  const config = m.validateConfig({});
  let s = createState({
    methodology: "kanban",
    config,
    stages: m.defaultStages(config),
    roles: m.defaultRoles(config),
    now: T0,
  });
  s = addItem(s, { id: "A", title: "a" }, "service-request-manager", T0);
  return addItem(s, { id: "B", title: "b" }, "service-request-manager", T0);
};
const cart: ContextAssumption = {
  claim: "totals are integer cents",
  required: true,
  source: { path: "src/cart.ts", lines: [10, 24], hash: "h-cart" },
};
const tax: ContextAssumption = {
  claim: "tax is applied once",
  source: { path: "src/tax.ts", hash: "h-tax" },
};
const loose: ContextAssumption = { claim: "no caching layer" };
const snap = (s: WorkflowState, item = "A", assumptions = [cart, tax, loose], ref = "ctx/1") =>
  recordContextSnapshot(s, m, {
    item,
    revision: "r1",
    assumptions,
    ref,
    by: "human",
    now: T0,
  }).state;
const change = (s: WorkflowState, paths: string[], revision = "r2") =>
  appendEvent(s, "repo.changed", "human", { revision, paths }, T0);
const invalid = (input: unknown, re: RegExp) =>
  assert.throws(
    () => recordContextSnapshot(base(), m, input as never),
    (e) => e instanceof WorkflowError && e.code === "invalid-input" && re.test(e.message),
    JSON.stringify(input),
  );
const good = {
  item: "A",
  revision: "r1",
  assumptions: [cart],
  ref: "ctx/1",
  by: "human",
  now: T0,
};

test("recordContextSnapshot stores evidence context-snapshot with data { revision, assumptions } through applyAction", () => {
  const seen: string[] = [];
  const rule: Rule = {
    id: "spy",
    severity: "warning",
    check: (_s, a) => (seen.push(a.type), []),
  };
  const spy: Methodology = { ...m, rules: [...m.rules, rule] };
  const r = recordContextSnapshot(base(), spy, { ...good, assumptions: [cart, loose] });
  assert.deepEqual(seen, ["context.snapshot"]);
  const e = r.state.items["A"]!.evidence[0]!;
  assert.deepEqual(e, {
    kind: "context-snapshot",
    ref: "ctx/1",
    by: "human",
    at: T0,
    data: { revision: "r1", assumptions: [cart, loose] },
  });
  assert.deepEqual(r.state.events.at(-1)!.payload, {
    id: "A",
    kind: "context-snapshot",
    ref: "ctx/1",
  });
});

test("recordContextSnapshot copies the input: later caller edits do not reach the state", () => {
  const assumptions: ContextAssumption[] = [structuredClone(cart)];
  const s = recordContextSnapshot(base(), m, { ...good, assumptions }).state;
  assumptions[0]!.claim = "edited";
  assumptions[0]!.source!.lines![0] = 99;
  assumptions.push(loose);
  assert.deepEqual(s.items["A"]!.evidence[0]!.data, { revision: "r1", assumptions: [cart] });
});

test("recordContextSnapshot refuses malformed input with invalid-input", () => {
  invalid(null, /must be an object/);
  invalid({ ...good, extra: 1 }, /unknown key "extra"/);
  invalid({ ...good, revision: "" }, /revision/);
  invalid({ ...good, assumptions: "x" }, /assumptions must be an array/);
  invalid({ ...good, assumptions: [{ claim: "" }] }, /assumptions\[0\]\.claim/);
  invalid({ ...good, assumptions: [{ claim: "c", required: "yes" }] }, /required/);
  invalid({ ...good, assumptions: [{ claim: "c", why: 1 }] }, /unknown key "why"/);
  invalid({ ...good, assumptions: [{ claim: "c", source: { path: "a", hash: "" } }] }, /hash/);
  invalid({ ...good, assumptions: [{ claim: "c", source: { path: "", hash: "h" } }] }, /path/);
  invalid(
    { ...good, assumptions: [{ claim: "c", source: { path: "a", hash: "h", x: 1 } }] },
    /unknown key "x"/,
  );
  for (const lines of [[0, 2], [3, 2], [1.5, 2], [1], "1-2", [1, 2, 3]])
    invalid(
      { ...good, assumptions: [{ claim: "c", source: { path: "a", hash: "h", lines } }] },
      /lines/,
    );
  invalid({ ...good, ref: " " }, /ref/);
  invalid({ ...good, by: "" }, /by/);
  invalid({ ...good, now: 5 }, /now/);
  invalid({ ...good, item: 7 }, /item/);
  assert.throws(
    () => recordContextSnapshot(base(), m, { ...good, item: "NOPE" }),
    (e) => e instanceof WorkflowError && e.code === "unknown-item",
  );
});

test("repository paths are canonical repository-relative POSIX paths, compared exactly", () => {
  for (const p of ["src/cart.ts", "README.md", "a/b/c", ".github/workflows/ci.yml", "Src/Cart.ts"])
    assert.equal(repoPathIssue(p), undefined, p);
  for (const p of [
    "",
    "./src/cart.ts",
    "/src/cart.ts",
    "src\\cart.ts",
    "src//cart.ts",
    "src/cart.ts/",
    "src/./cart.ts",
    "src/../cart.ts",
    "..",
    "C:/repo/src/cart.ts",
    "c:cart.ts",
    7,
  ])
    assert.notEqual(repoPathIssue(p), undefined, String(p));
  invalid(
    { ...good, assumptions: [{ claim: "c", source: { path: "./src/cart.ts", hash: "h" } }] },
    /\.\/src\/cart\.ts/,
  );
  invalid(
    { ...good, assumptions: [{ claim: "c", source: { path: "src\\cart.ts", hash: "h" } }] },
    /repository-relative POSIX/,
  );
});

test("contextOf: none without a snapshot; the latest valid fresh snapshot with its unverified claims", () => {
  let s = base();
  assert.equal(contextOf(s, s.items["A"]!), undefined);
  s = snap(s, "A", [cart], "ctx/old");
  s = snap(s, "A");
  // a malformed newer entry (hand-written) does not count; the latest valid one does
  s = addEvidence(
    s,
    "A",
    { kind: "context-snapshot", ref: "bad", by: "x", data: { revision: "" } },
    T0,
  );
  s = addEvidence(s, "A", { kind: "context-snapshot", ref: "nodata", by: "x" }, T0);
  assert.deepEqual(contextOf(s, s.items["A"]!), {
    revision: "r1",
    assumptions: [cart, tax, loose],
    snapshot: "ctx/1",
    by: "human",
    stale: [],
    unverified: ["no caching layer"],
  });
  assert.equal(contextOf(s, s.items["B"]!), undefined);
});

test("contextOf: a later repo.changed citing a source path makes it stale; uncited paths and other items do not", () => {
  let s = snap(base());
  s = snap(s, "B", [{ claim: "b", source: { path: "src/b.ts", hash: "h" } }], "ctx/b");
  s = change(s, ["docs/x.md", "src/b.ts"]);
  assert.deepEqual(contextOf(s, s.items["A"]!)!.stale, []);
  assert.deepEqual(contextOf(s, s.items["B"]!)!.stale, ["src/b.ts"]);
  // exact match: other spellings of the path do not match (the recorders refuse them anyway)
  s = change(s, ["./src/cart.ts", "SRC/cart.ts", "src/cart.tsx", "src"]);
  assert.deepEqual(contextOf(s, s.items["A"]!)!.stale, []);
  s = change(s, ["src/tax.ts", "src/cart.ts"]);
  s = change(s, ["src/cart.ts"], "r4");
  assert.deepEqual(contextOf(s, s.items["A"]!)!.stale, ["src/tax.ts", "src/cart.ts"]);
  // a revision mismatch alone does not stale it: only cited paths decide (r1 snapshot, r4 head)
  assert.equal(contextOf(s, s.items["A"]!)!.revision, "r1");
  const fresh = snap(s, "A", [cart], "ctx/2");
  assert.deepEqual(contextOf(fresh, fresh.items["A"]!)!.stale, []);
  assert.equal(contextOf(fresh, fresh.items["A"]!)!.snapshot, "ctx/2");
});

test("contextOf: a repo.changed before the snapshot does not stale it; rework drops the snapshot", () => {
  let s = change(base(), ["src/cart.ts"]);
  s = snap(s);
  assert.deepEqual(contextOf(s, s.items["A"]!)!.stale, []);
  s = appendEvent(s, "item.rework", "qa", { id: "A", by: "qa", notes: "again" }, T0);
  assert.equal(contextOf(s, s.items["A"]!), undefined);
  s = snap(s, "A", [cart], "ctx/after-rework");
  assert.equal(contextOf(s, s.items["A"]!)!.snapshot, "ctx/after-rework");
});

test("contextOf: a hand-built state with fewer item.evidence events than entries counts unmatched entries as oldest (strict)", () => {
  let s = snap(base());
  s = change(s, ["src/cart.ts"]);
  // an entry with no event of its own: it precedes every event, so every repo.changed stales it
  const item = s.items["A"]!;
  const extra = { ...item.evidence[0]!, ref: "ctx/no-event" };
  s = { ...s, items: { ...s.items, A: { ...item, evidence: [extra, ...item.evidence] } } };
  assert.equal(contextOf(s, s.items["A"]!)!.snapshot, "ctx/1");
  assert.deepEqual(contextOf(s, s.items["A"]!)!.stale, ["src/cart.ts"]);
});

const raw = (s: WorkflowState, by: string, assumptions: ContextAssumption[], ref: string) =>
  addEvidence(
    s,
    "A",
    { kind: "context-snapshot", ref, by, data: { revision: "r1", assumptions } as never },
    T0,
  );

test("recordContextSnapshot refuses a recorder that cannot ground the item (G1-2, G2-2)", () => {
  // not human and not a registered role, prototype names included
  for (const by of ["nobody", "__proto__", "toString"])
    invalid({ ...good, by }, /may not record|registered role/);
  // a role that worked on the item
  const s = moveItem(base(), "A", { stage: "dev", status: "in_progress" }, "worker", T0);
  assert.throws(
    () => recordContextSnapshot(s, m, { ...good, by: "worker" }),
    (e) => e instanceof WorkflowError && e.code === "invalid-input" && /worked on/.test(e.message),
  );
  // no sourced assumption: nothing was verified
  invalid({ ...good, assumptions: [] }, /at least one assumption with a source/);
  invalid({ ...good, assumptions: [loose] }, /at least one assumption with a source/);
  // a registered independent role and a human may
  const ok = recordContextSnapshot(s, m, { ...good, by: "service-delivery-manager" }).state;
  assert.equal(contextOf(ok, ok.items["A"]!)!.by, "service-delivery-manager");
});

test("contextOf counts only a qualifying snapshot: the latest one a worker cannot supersede (G2-1)", () => {
  let s = snap(base(), "A", [cart], "ctx/scout");
  s = change(s, ["src/cart.ts"]);
  s = moveItem(s, "A", { stage: "dev", status: "in_progress" }, "worker", T0);
  // later hand-written snapshots that do not qualify are ignored, so the stale one still counts
  s = raw(s, "worker", [{ ...cart, required: false }], "ctx/worker");
  s = raw(s, "nobody", [cart], "ctx/nobody");
  s = raw(s, "__proto__", [cart], "ctx/proto");
  s = raw(s, "human", [loose], "ctx/unsourced");
  const ctx = contextOf(s, s.items["A"]!)!;
  assert.equal(ctx.snapshot, "ctx/scout");
  assert.deepEqual(ctx.stale, ["src/cart.ts"]);
  // a snapshot recorded by a role that later works on the item stops counting
  let t = recordContextSnapshot(base(), m, { ...good, by: "worker" }).state;
  assert.equal(contextOf(t, t.items["A"]!)!.by, "worker");
  t = moveItem(t, "A", { stage: "dev", status: "in_progress" }, "worker", T0);
  assert.equal(contextOf(t, t.items["A"]!), undefined);
});

test("G2-8, G4-4: paths must be NFC, free of control and bidi characters and outer whitespace, at most 4096 long", () => {
  for (const p of ["src/caf\u00e9.ts", "a b/c d.ts", "a".repeat(4096), "\u65e5\u672c/\u8a9e.ts"])
    assert.equal(repoPathIssue(p), undefined, JSON.stringify(p));
  for (const p of [
    "src/cafe\u0301.ts", // NFD
    "a\u0000b",
    "a\nb",
    "a\tb",
    "a\rb",
    "a\u007fb",
    "a\u0085b",
    "a\u009fb",
    " ",
    " src/a.ts",
    "src/a.ts ",
    "src/\u202eevil.ts",
    "src/\u2066x.ts",
    "src/\u200fx.ts",
    "src/\u061cx.ts",
    "a".repeat(4097),
  ])
    assert.notEqual(repoPathIssue(p), undefined, JSON.stringify(p));
  // the long path is not echoed in full
  assert.ok(repoPathIssue("a".repeat(100_000))!.length < 200);
  invalid(
    { ...good, assumptions: [{ claim: "c", source: { path: "src/cafe\u0301.ts", hash: "h" } }] },
    /NFC/,
  );
});

test("G2-9: contextOf returns copies; changing the answer does not change the state", () => {
  const s = snap(base());
  const before = JSON.stringify(s);
  const ctx = contextOf(s, s.items["A"]!)!;
  ctx.assumptions[0]!.claim = "changed";
  ctx.assumptions[0]!.source!.lines![0] = 99;
  ctx.assumptions[0]!.source!.path = "x.ts";
  ctx.assumptions.push({ claim: "added" });
  ctx.stale.push("y.ts");
  ctx.unverified.push("z");
  assert.equal(JSON.stringify(s), before);
  assert.deepEqual(contextOf(s, s.items["A"]!)!.assumptions, [cart, tax, loose]);
});

// A seeded linear congruential generator: deterministic, no Math.random (principle rule 1).
const lcg = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
const PATHS = ["a.ts", "b.ts", "c/d.ts", "e.md"];

test("property: staleness follows event order and is deterministic (300 seeded runs)", () => {
  for (let run = 0; run < 300; run++) {
    const rnd = lcg(run + 1);
    const pick = () => PATHS[Math.floor(rnd() * PATHS.length)]!;
    let s = base();
    // reference model: the cited paths of the latest snapshot and the paths changed after it
    let cited: string[] | undefined;
    let changed: string[] = [];
    const steps = 2 + Math.floor(rnd() * 8);
    for (let i = 0; i < steps; i++) {
      // timestamps run backwards on purpose: only event order counts
      const at = new Date(Date.parse(T0) - i * 60_000).toISOString();
      if (rnd() < 0.4) {
        const assumptions = [pick(), pick()].map((path, k) => ({
          claim: `c${i}.${k}`,
          source: { path, hash: `h${i}` },
        }));
        s = recordContextSnapshot(s, m, {
          item: "A",
          revision: `r${i}`,
          assumptions,
          ref: `ctx/${i}`,
          by: "human",
          now: at,
        }).state;
        cited = assumptions.map((a) => a.source.path);
        changed = [];
      } else {
        const paths = [pick(), pick()];
        s = appendEvent(s, "repo.changed", "human", { revision: `r${i}`, paths }, at);
        for (const p of paths) if (cited?.includes(p) && !changed.includes(p)) changed.push(p);
      }
    }
    const got = contextOf(s, s.items["A"]!);
    assert.deepEqual(got?.stale, cited && changed, `run ${run}`);
    assert.deepEqual(contextOf(structuredClone(s), s.items["A"]!), got, `run ${run} deterministic`);
  }
});

test("#49: a superseding snapshot keeps the required claims of the ones it supersedes", () => {
  // an independent snapshot requires the cart claim and goes stale
  let s = change(snap(base(), "A", [cart], "ctx/scout"), ["src/cart.ts"]);
  const by = (t: WorkflowState, assumptions: ContextAssumption[], ref: string) =>
    recordContextSnapshot(t, m, { ...good, assumptions, ref, by: "worker" }).state;
  // the future worker drops it: the claim is carried as required and unverified
  const dropped = by(s, [tax], "ctx/weaker");
  const ctx = contextOf(dropped, dropped.items["A"]!)!;
  assert.equal(ctx.snapshot, "ctx/weaker");
  assert.deepEqual(ctx.assumptions, [tax, { claim: cart.claim, required: true }]);
  assert.deepEqual(ctx.unverified, [cart.claim]);
  // keeping the claim with a source, even without marking it required, reports it required
  const kept = by(
    s,
    [{ ...cart, required: false, source: { path: "src/cart.ts", hash: "h2" } }],
    "ctx/k",
  );
  assert.deepEqual(contextOf(kept, kept.items["A"]!)!.assumptions, [
    { ...cart, source: { path: "src/cart.ts", hash: "h2" } },
  ]);
  assert.deepEqual(contextOf(kept, kept.items["A"]!)!.unverified, []);
  // keeping it without a source leaves it unverified
  const unsourced = by(s, [tax, { claim: cart.claim }], "ctx/u");
  assert.deepEqual(contextOf(unsourced, unsourced.items["A"]!)!.unverified, [cart.claim]);
  // carried through a chain of snapshots; only a rework clears it
  const chain = by(by(s, [cart, tax], "ctx/2"), [tax], "ctx/3");
  assert.deepEqual(contextOf(chain, chain.items["A"]!)!.unverified, [cart.claim]);
  s = appendEvent(s, "item.rework", "human", { id: "A", by: "human", notes: "n" }, T0);
  const fresh = by(s, [tax], "ctx/after-rework");
  assert.deepEqual(contextOf(fresh, fresh.items["A"]!)!.unverified, []);
});

test("#49 (gate G1-3): a carried claim survives its recorder becoming a worker; only rework clears it", () => {
  // a scout ("worker", not yet working on A) records the cart claim, then a human snapshot omits it
  let s = recordContextSnapshot(base(), m, {
    ...good,
    assumptions: [cart],
    ref: "ctx/scout",
    by: "worker",
  }).state;
  s = recordContextSnapshot(s, m, {
    ...good,
    assumptions: [tax],
    ref: "ctx/h2",
    by: "human",
  }).state;
  assert.deepEqual(contextOf(s, s.items["A"]!)!.unverified, [cart.claim]);
  // the scout ("worker") is dispatched: its snapshot stops qualifying, its required claim stays
  s = moveItem(s, "A", { stage: "dev", status: "in_progress" }, "worker", T0);
  assert.deepEqual(contextOf(s, s.items["A"]!)!.unverified, [cart.claim]);
});

test("#49 (gate G3-1): a required claim of a later, no longer qualifying snapshot still carries", () => {
  let s = recordContextSnapshot(base(), m, {
    ...good,
    assumptions: [tax],
    ref: "ctx/h1",
    by: "human",
  }).state;
  s = recordContextSnapshot(s, m, {
    ...good,
    assumptions: [cart, tax],
    ref: "ctx/scout",
    by: "worker",
  }).state;
  s = moveItem(s, "A", { stage: "dev", status: "in_progress" }, "worker", T0);
  const ctx = contextOf(s, s.items["A"]!)!;
  assert.equal(ctx.snapshot, "ctx/h1");
  assert.deepEqual(ctx.unverified, [cart.claim]);
});
