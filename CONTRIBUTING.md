# Contributing to ex-workflow

The conventions below are what the 1.0.0 release (Phase 7, design spec §23) established and every release since has followed. They bind humans and AI agents alike. When a rule here and the design spec disagree, the spec's newer section wins and this file is updated in the same change.

## 1. Branches, commits, pull requests

- `main` is the release line. Work happens on a branch named `feat/<topic>`, `fix/<topic>` or `docs/<topic>` and lands through a pull request; no direct pushes to `main`.
- Commits follow Conventional Commits with a scope: `feat(kanban): …`, `fix(waterfall): …`, `docs(spec): …`, `test(api): …`, `chore(size): …`, `chore(release): …`. The subject says what changed and names the issue (`#27`) or backlog id (`B22`) it closes.
- One concern per commit: a behaviour change, its tests and its spec row travel together; the size-budget re-measure and the CHANGELOG are separate `chore`/`docs` commits so a reviewer can read the diff of each.
- The pre-commit hook runs `format:check`, `lint`, `typecheck`, `schema:check` and `test`. Do not bypass it.
- A pull request description lists the issues closed, the behaviour changes, and the sections of the design spec it adds or amends.

## 2. Spec first

- Every phase or feature starts with a numbered addenda section appended to `docs/superpowers/specs/2026-10-19-ex-workflow-design.md` (`## N. Phase P implementation addenda (…)`), never with a section inserted at the top. The section has a decision table (`Issue | Topic | Decision`, or `Topic | Decision`) and ends with an **Out of scope** row or paragraph.
- Before planning a fix, reproduce the issue on `main` with a read-only probe and record the commit it was reproduced on.
- A decision taken during implementation or review goes into the same section as a new row; it is not left in a chat log or a PR comment.
- Research and proposals live under `docs/research/` with a status line at the top (`proposed`, `superseded by …`, `adopted in …`). They are the input to a spec section, never the record of what shipped.
- One tracking document per concern. Before creating a new `.md`, look for the existing home (README, CHANGELOG, the spec, `docs/research/`) and extend it.

## 3. Code

- Core is pure: no I/O, no clock, no randomness. The file adapter (`src/adapters`) is the only module that touches disk and the CLI is built on it. A new methodology never executes commands, creates workspaces or calls Git; it records what the host did.
- A methodology is a directory `src/<name>/` with `config.ts`, `state.ts`, `roles.ts`, `stages.ts`, `rules.ts`, `ceremonies.ts`, `metrics.ts` and an `index.ts` that exports the factory `<name>()`, the config validator `validate<Name>Config` and its public types. Rules and ceremonies go through `applyAction` so capability checks and rule hooks see them; a ceremony that bypasses it is a bug.
- Every failure is a `WorkflowError` with a documented `code`, a `message` that names the offending value and a `fix` that says what to change. New codes are added to the README Errors list in the same change. Input validation answers `invalid-input`; config validation answers `config-invalid` naming the key and an example value.
- Runtime dependencies stay at `ex-flow` and `exsorted`. A new dependency is an owner decision recorded in the spec.
- Ids pass `assertId`; object lookups use `Object.hasOwn`; nothing written by the adapter leaves `.workflow/`.
- Node ≥ 18, Windows included: no shell assumptions in scripts, `npm.cmd` where npm is spawned.

## 4. Tests

- Test first: a change starts with a failing test next to the code (`src/<area>/*.test.ts`) or in `test/` for cross-cutting behaviour; `scripts/run-tests.mjs` collects every `*.test.ts`.
- Each methodology keeps one end-to-end scenario (`test/<name>.e2e.test.ts` or the colocated lifecycle test) that walks rework, blockers, escalation, retro or review and metrics in one run. A new methodology ships with such a scenario, a CLI round trip (`init`, ceremonies, `next`, `complete`, `status`, `metrics`, save and load) and an unknown-ceremony case.
- `test/compat.test.ts` loads `state.json` fixtures written by published releases (`test/fixtures/compat/<version>/<methodology>/`). A fixture that fails to load is a bug in the loader, fixed there, never by editing the fixture. When a release adds state fields, regenerate the fixtures with `scripts/gen-compat-fixtures.mjs` after it is published so the next release replays it.
- `test/api-surface.test.ts` freezes the public surface in `test/api-surface.json`: the runtime export names of every entry point, the CLI `USAGE` lines, the schema document names and the event kinds. A drift fails the test; an intended addition updates the file in the same commit and is a minor version; a removal is a major version.
- `pnpm run ci` is the definition of green: format, lint, typecheck, schema drift, tests, minified build, dist checks and the size ratchet. Nothing is reported as done until it has run.

## 5. Public surface and versioning

- Semver from 1.0.0 on the `latest` dist-tag. Additions are minor, removals and behaviour changes that break a documented contract are major, documentation-only releases are patch. Pre-releases use `X.Y.Z-stage` under the `stage` dist-tag; the registry reserves `0.0.0`, so never use it.
- The frozen surface is: exports of every entry point, CLI commands and flags, the schema documents, the event kinds and their payload keys, the error codes, and the `.workflow/state.json` shape. A state written by any earlier release loads unchanged; every new state field is optional.
- Types in `src/types.ts` drive the JSON Schema. After a type change run `pnpm schema:gen`; `pnpm schema:check` fails the build when the committed `src/schema/generated.ts` drifts.
- A new entry point gets: an `exports` and `typesVersions` entry in `package.json`, a `tsup.config.ts` entry, a `scripts/measure-<name>-entry.ts`, a check in `scripts/check-dist.mjs` (shared `WorkflowError` identity, factory name, config validator), a row in the API-surface file and a row in the README entry-point table listing its actual exports.
- Methodology entries expose the same shape: the factory, the config validator and the public types; helper exports (`ceremonies`, `metrics`, `report`, `roles`, `rules`, `stages`) are either exported by all methodologies or documented as the exception in the README table.

## 6. Size budgets

- `size-budget.json` is measured with `pnpm size` over the minified single-entry bundles (`core+<methodology>`, `schema`, each `dist/*/index.mjs`). Budgets ratchet down automatically; raising one is an owner decision.
- A raise is recorded in the `note` field in the same commit: date, cause, old → new bytes, and the word `measured`. `pnpm size --write` keeps the note.
- A new entry is seeded at its measured size. Existing budgets are not loosened to make room for a new feature unless the note explains the measured additive cost (a shared planner hook, for example).
- The version string is part of the bundle: re-measure after the version bump, not before.

## 7. Documentation

**README** is written for users of the package, not for the project history. Each methodology has the same footprint, and a new one adds all of it in one change:

1. a column in the "Pick a methodology" table (roles, flow, ceremonies, metrics), or a paragraph below it when it does not share the core table;
2. a quick-start section with a runnable SDK snippet, roles and stages;
3. the `init` line in the CLI reference;
4. `### <Name> (\`<Name>Config\`)` under Configuration with a `Key | Meaning` table, defaults and locked keys;
5. a bold block under Ceremonies with one bullet per ceremony: name, input shape, caller role, effect;
6. new error codes in Errors, new schema documents in JSON Schema;
7. the entry-point row with its actual exports;
8. the counts in Compatibility and versioning (schema documents, event kinds);
9. the accepted limitations as bullets under Known limitations, written as what happens and what to do.

The Install line names the supported `latest` version. The README does not carry roadmaps, status history, publishing notes or the reasoning behind a limitation; the spec and the CHANGELOG do.

**CHANGELOG** has one entry per release, `## X.Y.Z (YYYY-MM-DD)`, newest first:

- an opening line naming the theme, the issues and the spec section;
- one bullet per change with the issue or backlog id, the user-visible behaviour and the names of the new ceremonies, keys, flags or exports;
- a closing **Compatibility** (or **Migration**) paragraph that states, explicitly, every change to `state.json`, the schema documents, the event kinds, the exports and the CLI, every deliberate behaviour change, the `VERSION` string, and "loads unchanged" for earlier states when that is true. A documentation release says "no code, schema, CLI or `state.json` change".

**Examples** under `scripts/example-*.ts` are synthetic, assert their final outcome, perform no I/O and run with `pnpm exec tsx`; CI or the release checklist runs them.

## 8. Release checklist

In this order; every step is a commit on the release branch unless noted.

1. Spec section written and reviewed; CHANGELOG entry drafted with the Compatibility paragraph.
2. `package.json` `version`, `VERSION` in `src/index.ts` and the pinned string in `src/index.test.ts` bumped; README Install line updated to the new `latest`; `package.json` description and keywords still true.
3. `pnpm size --write` after the bump; the `note` explains any raise.
4. `pnpm run ci` green; `pnpm exec tsx scripts/example-*.ts` green.
5. `test/api-surface.json` diff reviewed: only additions for a minor, nothing for a patch.
6. Pull request to `main`, merged with a merge commit (history is kept).
7. Tag the merge commit `vX.Y.Z` and create the GitHub release with the CHANGELOG entry as its body.
8. `npm publish` (moves `latest`), or `npm publish --tag stage` for a pre-release; `npm view ex-workflow dist-tags` confirms.
9. After publishing a release that adds state fields: regenerate the compatibility fixtures to include it and commit them with the next change.
10. Downstream (workflowAI) bumps its dependency only after the npm publish is confirmed.
