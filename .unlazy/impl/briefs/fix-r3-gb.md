# Fix pass r3 — Gemini implementer GB (leaf fix-r3-gb)

Read `.unlazy/impl/briefs/COMMON.md` and `.unlazy/impl/briefs/fix-r1-common.md` (rules and RESOURCE
RULE apply; read "r1" as "r3" for file names), and each finding's full text in `docs/impl/review-3.md`
— its `Evidence:` and `Fix:` lines specify the change. Review 3 also lists three round-2 findings STILL
OPEN (prev F1 scope, prev F12 lookup unwired, prev F13 silent loss); they are folded into F4, F5 and F7.

Six implementers work at once, each in its own files; never write outside your OWNS. When a fix needs a
change in someone else's file, write the exact change in your fixes doc and tell the driver.
Fixes document: `docs/impl/fixes-r3-GB.md` (one `## F<n>` section per finding). Ledger:
`docs/impl/agent-gates/fix-r3-gb.GATES.md` — gates G0–G5 from `.unlazy/impl/gates/fix-r3-gb.md` (not G6).
Heavy checks only via `sh scripts/heavy.sh`; ad-hoc tests with
`NODE_OPTIONS=--max-old-space-size=1024 node --test --test-timeout=60000 <file>`.

## OWNS

    src/github/pr-automation.ts, src/ui/app.tsx, src/ui/client/**, src/ui/styles.css, src/ui/build.mjs, src/ui/build.d.mts, src/ui/css.d.ts, apps/**, packages/**, tests/github/pr-automation.test.ts, tests/ui/client.test.ts, tests/ui-client/**, docs/impl/fixes-r3-GB.md, docs/impl/agent-gates/fix-r3-gb.GATES.md

## Your findings (review-3)

- **F4 [BLOCKING], UI half** — an instance-admin screen to allow-list GitHub App installations per workspace, using SB's API (shape at the top of the F4 section of `docs/impl/fixes-r3-SB.md`).
- **F9 [MAJOR]** — readiness must fire on common repos: account for commit statuses, approvals past the first page, and a reasonable rule for which checks must pass (`src/github/pr-automation.ts:169`).
