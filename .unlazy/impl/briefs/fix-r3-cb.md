# Fix pass r3 — Codex implementer CB (leaf fix-r3-cb)

Read `.unlazy/impl/briefs/COMMON.md` and `.unlazy/impl/briefs/fix-r1-common.md` (rules and RESOURCE
RULE apply; read "r1" as "r3" for file names), and each finding's full text in `docs/impl/review-3.md`
— its `Evidence:` and `Fix:` lines specify the change. Review 3 also lists three round-2 findings STILL
OPEN (prev F1 scope, prev F12 lookup unwired, prev F13 silent loss); they are folded into F4, F5 and F7.

Six implementers work at once, each in its own files; never write outside your OWNS. When a fix needs a
change in someone else's file, write the exact change in your fixes doc and tell the driver.
Fixes document: `docs/impl/fixes-r3-CB.md` (one `## F<n>` section per finding). Ledger:
`docs/impl/agent-gates/fix-r3-cb.GATES.md` — gates G0–G5 from `.unlazy/impl/gates/fix-r3-cb.md` (not G6).
Heavy checks only via `sh scripts/heavy.sh`; ad-hoc tests with
`NODE_OPTIONS=--max-old-space-size=1024 node --test --test-timeout=60000 <file>`.

## OWNS

    src/app/writers.ts, src/sync/mirror.ts, src/sync/dev-info.ts, src/operations/**, tests/writers/**, tests/mirror/**, tests/dev-info/**, tests/operations/**, docs/impl/fixes-r3-CB.md, docs/impl/agent-gates/fix-r3-cb.GATES.md

## Your findings (review-3)

- **F1 [BLOCKING], root cause** — reducers must not wait for outbound completion (`src/operations/outbox.ts:156`). Enqueue durably and return; a write whose result a reducer needs (a created id) must continue in a follow-up job, not a synchronous poll. This is the root of F1 and feeds F2, F3 and F11 — redesign rather than tune the timeout.
- **F2 [BLOCKING]** — a pending create plus a second delivery for the same object must not create duplicate Plane items (`src/sync/mirror.ts:118`).
- **F3 [BLOCKING]** — identical writes within one delivery must not collapse when they are not adjacent (A→B→A) (`src/operations/outbox.ts:77`).
- **F6 [MINOR]** — a write whose actor PAT was revoked before execution falls back to the service identity, audited (`src/operations/outbox.ts:201`).
