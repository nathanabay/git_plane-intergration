# Fix pass r2 — Gemini implementer GB (leaf fix-r2-gb)

Read `.unlazy/impl/briefs/COMMON.md`, `.unlazy/impl/briefs/fix-r1-common.md` (rules and the
RESOURCE RULE still apply; read "r1" as "r2" for file names), and each finding's full text in
`docs/impl/review-2.md` (its `Evidence:` and `Fix:` lines are the spec for your change). Also note
which round-1 findings review-2 marked STILL OPEN (prev F2, F14, F18) — they are folded into F1/F7/F14.

Six implementers work at once, each in its own files. Never write outside your OWNS. Fixes document:
`docs/impl/fixes-r2-GB.md` (one `## F<n>` section per finding). Ledger:
`docs/impl/agent-gates/fix-r2-gb.GATES.md` — copy gates G0–G5 from `.unlazy/impl/gates/fix-r2-gb.md`
(not G6). Heavy checks only through `sh scripts/heavy.sh`; ad-hoc tests with
`NODE_OPTIONS=--max-old-space-size=1024 node --test --test-timeout=60000 <file>`.

## OWNS

    src/github/pr-automation.ts, src/ui/app.tsx, src/ui/client/**, src/ui/styles.css, src/ui/build.mjs, src/ui/build.d.mts, src/ui/css.d.ts, apps/**, packages/**, tests/github/pr-automation.test.ts, tests/ui/client.test.ts, tests/ui-client/**, docs/impl/fixes-r2-GB.md, docs/impl/agent-gates/fix-r2-gb.GATES.md

## Your findings (review-2)

- **F3 [BLOCKING]** — no read-modify-write of Plane label/assignee lists against a queue (`src/github/pr-automation.ts:309`): compute deltas at apply time or send add/remove operations, so concurrent updates are not lost.
- **F7 [MAJOR]** — `ready_for_merge` must fire on real GitHub payloads, and its one live path is wrong (`src/github/pr-automation.ts:161`).
- **F11 [MAJOR]** — a stale embedded mapping comment must never silently discard hand-written rules (`src/github/pr-automation.ts:91`): detect divergence and fall back to the YAML editor, keeping the user's rules.
