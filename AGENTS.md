# Agent instructions

`CONTRIBUTING.md` is the single rule book for this repository and binds every agent, human or AI, exactly as it binds a person; read it before changing anything. This file only lists what CI cannot check, so do these by hand:

- [ ] Spec first: the decision is a numbered section or row in `docs/superpowers/specs/2026-10-19-ex-workflow-design.md` before the code; a decision taken during the work becomes a new row there.
- [ ] One concern per commit, Conventional Commits with a scope; the size re-measure and the CHANGELOG are separate commits.
- [ ] Never bypass the pre-commit hook (`--no-verify` is not allowed); if it fails, fix the cause and commit again.
- [ ] Research and proposals under `docs/research/` carry a status line (`proposed`, `superseded by ...`, `adopted in ...`).
- [ ] No new tracking, checklist, TODO or roadmap document: extend the README, CHANGELOG, the spec or `docs/research/`.
- [ ] `pnpm run ci` has run and is green before anything is called done.
