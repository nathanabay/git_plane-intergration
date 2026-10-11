# Fix pass r1 — Codex implementer CB (leaf fix-r1-cb)

Read `.unlazy/impl/briefs/COMMON.md` and `.unlazy/impl/briefs/fix-r1-common.md` first; then each
finding's full text in `docs/impl/review-1.md`, and `.unlazy/impl/evidence/plane-webhook-probe.md`.

**Six implementers work at the same time** (Sonnet SA, SB; Codex CA, CB; Gemini Flash GA, GB),
each in its own files. Earlier sessions started these fixes and exited when the editor restarted:
files in your OWNS may already contain partial changes, and an earlier ledger may exist at your
ledger path — read both, keep what is right, finish the rest. If a whole-repo gate fails in a file
you do not own, it is another implementer's work in progress: wait and re-run; never edit it.

Sonnet implementer SB owns the config API and Smart Commits; Sonnet SA owns `src/app/issues.ts` (F5's app half).

Your fixes document: `docs/impl/fixes-r1-CB.md` (one `## F<n>` section per finding below).
Your ledger: `docs/impl/agent-gates/fix-r1-cb.GATES.md` — copy every gate from
`.unlazy/impl/gates/fix-r1-cb.md` exactly, OWNS line included.

## OWNS

    src/sync/mirror.ts, src/sync/dev-info.ts, src/operations/**, tests/mirror/**, tests/dev-info/**, tests/operations/**, docs/impl/fixes-r1-CB.md, docs/impl/agent-gates/fix-r1-cb.GATES.md

## Your findings

- **F3 [BLOCKING]** — the mirror acts only on links with `created_by = 'label_sync'` in both directions; backfilled references never mirror. Test: backfill links #5 to WEB-12, then `issues.edited`/`closed` for #5 writes nothing to Plane.
- **F4 [MAJOR]** — Plane→GitHub labels/assignees: handle UUID arrays under both `labels`/`assignees` and `label_ids`/`assignee_ids` (evidence file); resolve label ids to names via `GET …/labels/` and member ids to GitHub logins via `user_map`.
- **F5 [MAJOR], mirror half** — never ignore an empty Plane assignee set: emit removal of the mapped assignees. (SA restricts the diff to mapped logins in `src/app/issues.ts`.)
