# Fix pass r1 — Gemini implementer GB (leaf fix-r1-gb)

Read `.unlazy/impl/briefs/COMMON.md` and `.unlazy/impl/briefs/fix-r1-common.md` first; then each
finding's full text in `docs/impl/review-1.md`, and `.unlazy/impl/evidence/plane-webhook-probe.md`.

**Four implementers work at the same time** (SA, SB on Claude Sonnet; GA, GB on Gemini Flash),
each in its own files. An earlier pair of sessions started these fixes and exited mid-way: files in
your OWNS may already contain partial changes. Read them, keep what is right, finish the rest.
If a whole-repo gate fails in a file you do not own, it is another implementer's work in progress:
wait a few minutes and re-run; never edit it. Report it if it persists.

Your fixes document: `docs/impl/fixes-r1-GB.md` (one `## F<n>` section per finding below).
Your ledger: `docs/impl/agent-gates/fix-r1-gb.GATES.md` — copy gates G0–G5 from
`.unlazy/impl/gates/fix-r1-gb.md` exactly, OWNS line included. **Leave G6 out**: it verifies your finished ledger, so it is the driver's gate, not yours.

## OWNS

    src/ui/app.tsx, src/ui/client/**, src/ui/styles.css, src/ui/build.mjs, src/ui/build.d.mts, src/ui/css.d.ts, src/github/pr-automation.ts, tests/github/pr-automation.test.ts, tests/ui/client.test.ts, tests/ui-client/**, apps/**, packages/**, docs/impl/fixes-r1-GB.md, docs/impl/agent-gates/fix-r1-gb.GATES.md

## Your findings

- **F11 [MAJOR]** — add the simple lifecycle→state mapping table to the workspace UI (each §7.1 lifecycle point → a state, plus branch rules with a base-branch regex) that compiles through B5's `compileLifecycleRules` and saves as a new rule-set version via the existing `PUT …/mappings/:id/rules`; advanced users still edit YAML (§7.1: the table is presentation sugar over one engine). To show a saved table again, embed its JSON in a leading YAML comment from `compileLifecycleRules` and parse it back in the UI; a hand-edited rule set falls back to the YAML editor.
- **F14 [MINOR]** — `ready_for_merge` must fire: emit it from `prEventToRuleEvent` when a PR is approved and all its check suites have passed (document which payloads carry that), or remove it from the configurable set and say why.
- **F15 [MINOR]** — the web fork's settings page must render a loader until `workspaceUserInfo` is loaded, then the iframe or `NotAuthorizedView`. Regenerate `apps/web/git-sync.patch` and the mirrored files; `node scripts/verify-fork-patch.mjs all` must pass.
