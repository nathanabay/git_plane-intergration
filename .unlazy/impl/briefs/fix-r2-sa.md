# Fix pass r2 — Sonnet implementer SA (leaf fix-r2-sa)

Read `.unlazy/impl/briefs/COMMON.md`, `.unlazy/impl/briefs/fix-r1-common.md` (rules and the
RESOURCE RULE still apply; read "r1" as "r2" for file names), and each finding's full text in
`docs/impl/review-2.md` (its `Evidence:` and `Fix:` lines are the spec for your change). Also note
which round-1 findings review-2 marked STILL OPEN (prev F2, F14, F18) — they are folded into F1/F7/F14.

Six implementers work at once, each in its own files. Never write outside your OWNS. Fixes document:
`docs/impl/fixes-r2-SA.md` (one `## F<n>` section per finding). Ledger:
`docs/impl/agent-gates/fix-r2-sa.GATES.md` — copy gates G0–G5 from `.unlazy/impl/gates/fix-r2-sa.md`
(not G6). Heavy checks only through `sh scripts/heavy.sh`; ad-hoc tests with
`NODE_OPTIONS=--max-old-space-size=1024 node --test --test-timeout=60000 <file>`.

## OWNS

    src/app/main.ts, src/app/context.ts, src/app/credentials.ts, src/app/mappings.ts, src/app/identity.ts, src/app/issues.ts, src/app/pr.ts, src/app/push.ts, src/app/checks.ts, src/index.ts, src/config/**, src/api/**, deploy/**, docker-compose.override.yaml, tests/deploy/**, tests/api/**, tests/app/**, docs/impl/fixes-r2-SA.md, docs/impl/agent-gates/fix-r2-sa.GATES.md

## Your findings (review-2)

- **F1 [BLOCKING], wiring half** — `src/app/main.ts` must pass a real `verifyMapping` (SB's `src/ui/mapping-check.ts`, with the service PAT client and an installation Octokit) to `createConfigRoutes`. SB makes the API fail closed when it is absent.
- **F12 [MINOR], runtime half** — `src/app/context.ts`: resolve actors by the stable GitHub id, not the login. (SB validates manual links in the API.)
- **F14 [MINOR], wiring half** — `src/app/push.ts` must supply `listCommitRange` (compare API through the installation Octokit) to Smart Commits. (SB owns the smart-commits side.)
- **F15 [MINOR], runtime half** — report which source the App credentials came from and stop the fallbacks from defeating a rotation (`src/app/credentials.ts`). SB reports it through the API.
