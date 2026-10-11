# Fix pass r3 — Sonnet implementer SB (leaf fix-r3-sb)

Read `.unlazy/impl/briefs/COMMON.md` and `.unlazy/impl/briefs/fix-r1-common.md` (rules and RESOURCE
RULE apply; read "r1" as "r3" for file names), and each finding's full text in `docs/impl/review-3.md`
— its `Evidence:` and `Fix:` lines specify the change. Review 3 also lists three round-2 findings STILL
OPEN (prev F1 scope, prev F12 lookup unwired, prev F13 silent loss); they are folded into F4, F5 and F7.

Six implementers work at once, each in its own files; never write outside your OWNS. When a fix needs a
change in someone else's file, write the exact change in your fixes doc and tell the driver.
Fixes document: `docs/impl/fixes-r3-SB.md` (one `## F<n>` section per finding). Ledger:
`docs/impl/agent-gates/fix-r3-sb.GATES.md` — gates G0–G5 from `.unlazy/impl/gates/fix-r3-sb.md` (not G6).
Heavy checks only via `sh scripts/heavy.sh`; ad-hoc tests with
`NODE_OPTIONS=--max-old-space-size=1024 node --test --test-timeout=60000 <file>`.

## OWNS

    src/ui/api.ts, src/ui/validate.ts, src/ui/mapping-check.ts, src/ui/plane-auth.ts, src/ui/http.ts, src/ui/static.ts, src/github/smart-commits.ts, src/github/html.ts, src/auth/**, src/rules/**, tests/ui/auth.test.ts, tests/ui/instance.test.ts, tests/ui/operations.test.ts, tests/ui/static.test.ts, tests/ui/workspace.test.ts, tests/ui/harness.ts, tests/github/smart-commits.test.ts, tests/github/fakes.ts, tests/auth/**, tests/rules/**, Dockerfile, .dockerignore, docs/impl/fixes-r3-SB.md, docs/impl/agent-gates/fix-r3-sb.GATES.md

## Your findings (review-3)

- **F4 [BLOCKING], lead** — scope GitHub App installations to workspaces: the mapping verifier (`src/ui/mapping-check.ts:43`) must accept a repository only if its installation is allow-listed for this workspace by an instance admin, and the instance API must manage that allow-list. GA adds the table, GB the instance-admin UI. Publish the API shape at the top of the F4 section of `docs/impl/fixes-r3-SB.md`.
- **F5 [MAJOR], API half** — user links must be verified in production (`src/ui/api.ts:305`); fail closed when no lookup is configured. SA wires the real lookup.
- **F12 [MINOR]** — a failing compare call must not fail the whole push, and fix the >20-commit premise (`src/github/smart-commits.ts:138`).
- **F16 [MINOR]** — the in-process Smart Commit lock must never admit a second holder after a waiter times out (`src/github/smart-commits.ts:198`).
