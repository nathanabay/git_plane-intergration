# Fix pass r1 — Gemini implementer GA (leaf fix-r1-ga)

Read `.unlazy/impl/briefs/COMMON.md` and `.unlazy/impl/briefs/fix-r1-common.md` first; then each
finding's full text in `docs/impl/review-1.md`, and `.unlazy/impl/evidence/plane-webhook-probe.md`.

**Four implementers work at the same time** (SA, SB on Claude Sonnet; GA, GB on Gemini Flash),
each in its own files. An earlier pair of sessions started these fixes and exited mid-way: files in
your OWNS may already contain partial changes. Read them, keep what is right, finish the rest.
If a whole-repo gate fails in a file you do not own, it is another implementer's work in progress:
wait a few minutes and re-run; never edit it. Report it if it persists.

Your fixes document: `docs/impl/fixes-r1-GA.md` (one `## F<n>` section per finding below).
Your ledger: `docs/impl/agent-gates/fix-r1-ga.GATES.md` — copy every gate from
`.unlazy/impl/gates/fix-r1-ga.md` exactly, OWNS line included.

## OWNS

    src/parse/**, src/sync/plane.ts, src/sync/github.ts, src/sync/ophash.ts, src/sync/router.ts, src/sync/reconcile.ts, src/db/**, src/queue/cron.ts, tests/parse/**, tests/sync/**, tests/db/**, tests/reconcile/**, tests/smoke/**, docs/impl/fixes-r1-GA.md, docs/impl/agent-gates/fix-r1-ga.GATES.md

## Your findings

- **F1 [BLOCKING]** — `resolveReferences` (src/parse/references.ts): a **403** from the identifier endpoint means unknown/inaccessible, exactly like 404; audit it, never throw. Update `tests/smoke/live-smoke.test.ts` to expect 403 for an unknown project (measured on a real Plane — see the evidence file).
- **F13 [MINOR]** — create-type writes in `src/sync/plane.ts`/`github.ts` record their echo op only after the response; record a pending op before the request and bind it to the id afterwards, or prove with a test that the race is harmless.
- **F16 [MINOR], DB half** — make the commit claim key `(sha, workspace_slug)` (new migration; keep `004-*` if a previous session already started it, read it first) so one repo mapped into two workspaces processes each workspace once, while fork re-delivery of a SHA into the same workspace still dedupes. Keep `claimCommit`'s signature backwards compatible or update its one caller list in your fixes doc (SB passes the workspace).
- **F17 [MINOR]** — prune `webhook_deliveries`, `processed_commits` and old audit payloads on a retention setting from the maintenance job (`src/queue/cron.ts`), reading TTL/retention from `instance_settings` on every run. Put the tests in `tests/reconcile/` (not `tests/queue/`, which SA owns).
