# Fix pass r1 — Codex implementer CA (leaf fix-r1-ca)

Read `.unlazy/impl/briefs/COMMON.md` and `.unlazy/impl/briefs/fix-r1-common.md` first; then each
finding's full text in `docs/impl/review-1.md`, and `.unlazy/impl/evidence/plane-webhook-probe.md`.

**Six implementers work at the same time** (Sonnet SA, SB; Codex CA, CB; Gemini Flash GA, GB),
each in its own files. Earlier sessions started these fixes and exited when the editor restarted:
files in your OWNS may already contain partial changes, and an earlier ledger may exist at your
ledger path — read both, keep what is right, finish the rest. If a whole-repo gate fails in a file
you do not own, it is another implementer's work in progress: wait and re-run; never edit it.

Sonnet implementer SA owns the other `src/app/*.ts` files and the queues (F2-runtime, F5-app, F6, F9, F12). F7 routes more events into A6 from your files; if it needs a hook in an SA file (`push.ts`, `checks.ts`, `issues.ts`, `main.ts`), describe it in your fixes doc and tell the driver.

Your fixes document: `docs/impl/fixes-r1-CA.md` (one `## F<n>` section per finding below).
Your ledger: `docs/impl/agent-gates/fix-r1-ca.GATES.md` — copy gates G0–G5 from
`.unlazy/impl/gates/fix-r1-ca.md` exactly, OWNS line included. **Leave G6 out**: it verifies your finished ledger, so it is the driver's gate, not yours.

## OWNS

    src/app/rule-events.ts, src/app/rules.ts, src/app/reducers.ts, src/app/github.ts, tests/a8/**, docs/impl/fixes-r1-CA.md, docs/impl/agent-gates/fix-r1-ca.GATES.md

## Your findings

- **F7 [MAJOR]** — route `push`, `commit.pushed_to_default`, `check_suite.*`, `deployment_status.*`, `issue.*`, `comment.*` into A6 for the mapping's rules, with the linked issues as targets (§7.5).
- **F10 [MAJOR]** — rebuild the echo-loop fixtures (`tests/a8/`) from `.unlazy/impl/evidence/plane-webhook-probe.md` (UUID arrays, `labels`, and the web app's `label_ids`/`assignee_ids`/`state_id`); label echoes must terminate with **zero** extra writes.

## Coordination (driver decision)

Export ONE shared function from `src/app/rule-events.ts` that maps a `(source, event, payload)`
delivery to the A6 `RuleEvent`(s) — the same mapping the live reducers use — and name it, with
its signature, at the top of `docs/impl/fixes-r1-CA.md`. CB makes the dry-run adapter
(`src/operations/tooling.ts`, CB's file) delegate to it so dry-run matches live behaviour (§7.6).
Do not edit `tooling.ts`. If F7 needs a hook in an SA file, write the exact change in your fixes
doc and tell the driver.
