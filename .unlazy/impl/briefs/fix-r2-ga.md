# Fix pass r2 — Gemini implementer GA (leaf fix-r2-ga)

Read `.unlazy/impl/briefs/COMMON.md`, `.unlazy/impl/briefs/fix-r1-common.md` (rules and the
RESOURCE RULE still apply; read "r1" as "r2" for file names), and each finding's full text in
`docs/impl/review-2.md` (its `Evidence:` and `Fix:` lines are the spec for your change). Also note
which round-1 findings review-2 marked STILL OPEN (prev F2, F14, F18) — they are folded into F1/F7/F14.

Six implementers work at once, each in its own files. Never write outside your OWNS. Fixes document:
`docs/impl/fixes-r2-GA.md` (one `## F<n>` section per finding). Ledger:
`docs/impl/agent-gates/fix-r2-ga.GATES.md` — copy gates G0–G5 from `.unlazy/impl/gates/fix-r2-ga.md`
(not G6). Heavy checks only through `sh scripts/heavy.sh`; ad-hoc tests with
`NODE_OPTIONS=--max-old-space-size=1024 node --test --test-timeout=60000 <file>`.

## OWNS

    src/parse/**, src/sync/plane.ts, src/sync/github.ts, src/sync/ophash.ts, src/sync/router.ts, src/sync/reconcile.ts, src/db/**, src/queue/**, tests/parse/**, tests/sync/**, tests/db/**, tests/queue/**, tests/reconcile/**, tests/smoke/**, docs/impl/fixes-r2-GA.md, docs/impl/agent-gates/fix-r2-ga.GATES.md

## Your findings (review-2)

- **F8 [MINOR]** — commits claimed before F16 must not be re-applied after retention prunes their claim (`src/db/ledgers.ts:67`).
- **F9 [MAJOR]** — inbound retries must not exhaust in ~30 s, and a final failure must be loud (audited, replayable) (`src/queue/workers.ts:135`).
- **F13 [MINOR]** — classify queued-write failures correctly and make them visible to the delivery's audit and replay (`src/sync/plane.ts:157`).
- **F17 [MINOR]** — link writes must record an echo op so Plane-side rules do not run on our own rollup writes (`src/sync/plane.ts:208`).
