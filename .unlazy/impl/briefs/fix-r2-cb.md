# Fix pass r2 — Codex implementer CB (leaf fix-r2-cb)

Read `.unlazy/impl/briefs/COMMON.md`, `.unlazy/impl/briefs/fix-r1-common.md` (rules and the
RESOURCE RULE still apply; read "r1" as "r2" for file names), and each finding's full text in
`docs/impl/review-2.md` (its `Evidence:` and `Fix:` lines are the spec for your change). Also note
which round-1 findings review-2 marked STILL OPEN (prev F2, F14, F18) — they are folded into F1/F7/F14.

Six implementers work at once, each in its own files. Never write outside your OWNS. Fixes document:
`docs/impl/fixes-r2-CB.md` (one `## F<n>` section per finding). Ledger:
`docs/impl/agent-gates/fix-r2-cb.GATES.md` — copy gates G0–G5 from `.unlazy/impl/gates/fix-r2-cb.md`
(not G6). Heavy checks only through `sh scripts/heavy.sh`; ad-hoc tests with
`NODE_OPTIONS=--max-old-space-size=1024 node --test --test-timeout=60000 <file>`.

## OWNS

    src/app/writers.ts, src/sync/mirror.ts, src/sync/dev-info.ts, src/operations/**, tests/writers/**, tests/mirror/**, tests/dev-info/**, tests/operations/**, docs/impl/fixes-r2-CB.md, docs/impl/agent-gates/fix-r2-cb.GATES.md

## Your findings (review-2)

- **F2 [BLOCKING]** — outbound job ids must not be positional: a retried delivery must neither drop a write nor record a Smart Commit as applied when it was not (`src/app/writers.ts:25`). Use content-derived ids (e.g. a hash of the write) and make the success record follow the write.
- **F6 [MAJOR]** — outbound writes for the same target must apply in order: a delayed retry or an inline actor-token write must not overtake a newer write (`src/app/writers.ts:35`). If `src/queue/**` (GA) needs a change, write it in your fixes doc and tell the driver.
