# Fix pass r3 — Gemini implementer GA (leaf fix-r3-ga)

Read `.unlazy/impl/briefs/COMMON.md` and `.unlazy/impl/briefs/fix-r1-common.md` (rules and RESOURCE
RULE apply; read "r1" as "r3" for file names), and each finding's full text in `docs/impl/review-3.md`
— its `Evidence:` and `Fix:` lines specify the change. Review 3 also lists three round-2 findings STILL
OPEN (prev F1 scope, prev F12 lookup unwired, prev F13 silent loss); they are folded into F4, F5 and F7.

Six implementers work at once, each in its own files; never write outside your OWNS. When a fix needs a
change in someone else's file, write the exact change in your fixes doc and tell the driver.
Fixes document: `docs/impl/fixes-r3-GA.md` (one `## F<n>` section per finding). Ledger:
`docs/impl/agent-gates/fix-r3-ga.GATES.md` — gates G0–G5 from `.unlazy/impl/gates/fix-r3-ga.md` (not G6).
Heavy checks only via `sh scripts/heavy.sh`; ad-hoc tests with
`NODE_OPTIONS=--max-old-space-size=1024 node --test --test-timeout=60000 <file>`.

## OWNS

    src/parse/**, src/sync/plane.ts, src/sync/github.ts, src/sync/ophash.ts, src/sync/router.ts, src/sync/reconcile.ts, src/db/**, src/queue/**, tests/parse/**, tests/sync/**, tests/db/**, tests/queue/**, tests/reconcile/**, tests/smoke/**, docs/impl/fixes-r3-GA.md, docs/impl/agent-gates/fix-r3-ga.GATES.md

## Your findings (review-3)

- **F4 [BLOCKING], storage half** — add a migration with a workspace→installation allow-list table (SB publishes the shape in `docs/impl/fixes-r3-SB.md`, F4 section; read it first) and ledger functions for it.
- **F11 [MAJOR]** — deferred outbox wake-ups must not consume the Plane rate-limit budget, and one failing intent must not block its target or a project's creates for hours (`src/queue/workers.ts:284`).
- **F13 [MINOR]** — prune `outbound_writes` on the retention setting (`src/db/migrations/005-outbound-writes.sql:2`).
- **F14 [MINOR]** — no duplicated failure audits; write the missing correlation field (`src/queue/workers.ts:260`).
- **F17 [MINOR]** — remove or use the dead safeguards: 004 backfill markers, unconsumed link ops, optional `PLANE_SERVICE_USER_ID` (`src/sync/plane.ts:219`).
