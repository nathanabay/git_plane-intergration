# Fix pass r3 — Sonnet implementer SA (leaf fix-r3-sa)

Read `.unlazy/impl/briefs/COMMON.md` and `.unlazy/impl/briefs/fix-r1-common.md` (rules and RESOURCE
RULE apply; read "r1" as "r3" for file names), and each finding's full text in `docs/impl/review-3.md`
— its `Evidence:` and `Fix:` lines specify the change. Review 3 also lists three round-2 findings STILL
OPEN (prev F1 scope, prev F12 lookup unwired, prev F13 silent loss); they are folded into F4, F5 and F7.

Six implementers work at once, each in its own files; never write outside your OWNS. When a fix needs a
change in someone else's file, write the exact change in your fixes doc and tell the driver.
Fixes document: `docs/impl/fixes-r3-SA.md` (one `## F<n>` section per finding). Ledger:
`docs/impl/agent-gates/fix-r3-sa.GATES.md` — gates G0–G5 from `.unlazy/impl/gates/fix-r3-sa.md` (not G6).
Heavy checks only via `sh scripts/heavy.sh`; ad-hoc tests with
`NODE_OPTIONS=--max-old-space-size=1024 node --test --test-timeout=60000 <file>`.

## OWNS

    src/app/main.ts, src/app/context.ts, src/app/credentials.ts, src/app/mappings.ts, src/app/identity.ts, src/app/issues.ts, src/app/pr.ts, src/app/push.ts, src/app/checks.ts, src/index.ts, src/config/**, src/api/**, deploy/**, docker-compose.override.yaml, tests/deploy/**, tests/api/**, tests/app/**, docs/impl/fixes-r3-SA.md, docs/impl/agent-gates/fix-r3-sa.GATES.md

## Your findings (review-3)

- **F5 [MAJOR], wiring half** — pass a real `lookupGithubUser` to `createConfigRoutes` in `src/app/main.ts`, and make Smart Commits attribute by GitHub id, not login.
- **F7 [MAJOR]** — a transient installation-lookup failure must not become a permanent, silent write loss (`src/app/issues.ts:104`).
- **F8 [MAJOR]** — when both "approved" and "ready for merge" are mapped, the ready state must win (`src/app/pr.ts:151`).
- **F15 [MINOR]** — report credential health instead of re-deriving it, and correct the misleading comments and fallbacks (`src/api/handler.ts:149`).
- **F18 [MINOR]** — the smaller rule-path defects listed in the finding (`src/app/pr.ts:89`).
