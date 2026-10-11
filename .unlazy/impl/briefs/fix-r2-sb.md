# Fix pass r2 — Sonnet implementer SB (leaf fix-r2-sb)

Read `.unlazy/impl/briefs/COMMON.md`, `.unlazy/impl/briefs/fix-r1-common.md` (rules and the
RESOURCE RULE still apply; read "r1" as "r2" for file names), and each finding's full text in
`docs/impl/review-2.md` (its `Evidence:` and `Fix:` lines are the spec for your change). Also note
which round-1 findings review-2 marked STILL OPEN (prev F2, F14, F18) — they are folded into F1/F7/F14.

Six implementers work at once, each in its own files. Never write outside your OWNS. Fixes document:
`docs/impl/fixes-r2-SB.md` (one `## F<n>` section per finding). Ledger:
`docs/impl/agent-gates/fix-r2-sb.GATES.md` — copy gates G0–G5 from `.unlazy/impl/gates/fix-r2-sb.md`
(not G6). Heavy checks only through `sh scripts/heavy.sh`; ad-hoc tests with
`NODE_OPTIONS=--max-old-space-size=1024 node --test --test-timeout=60000 <file>`.

## OWNS

    src/ui/api.ts, src/ui/validate.ts, src/ui/mapping-check.ts, src/ui/plane-auth.ts, src/ui/http.ts, src/ui/static.ts, src/github/smart-commits.ts, src/github/html.ts, src/auth/**, src/rules/**, tests/ui/auth.test.ts, tests/ui/instance.test.ts, tests/ui/operations.test.ts, tests/ui/static.test.ts, tests/ui/workspace.test.ts, tests/ui/harness.ts, tests/github/smart-commits.test.ts, tests/github/fakes.ts, tests/auth/**, tests/rules/**, Dockerfile, .dockerignore, docs/impl/fixes-r2-SB.md, docs/impl/agent-gates/fix-r2-sb.GATES.md

## Your findings (review-2)

- **F1 [BLOCKING], API half** — mapping create/update must **fail closed** when no verifier is configured (`src/ui/api.ts:132` currently returns early). SA wires the real verifier.
- **F12 [MINOR], API half** — validate manual user links (require the GitHub id; check it against the login through the App when reachable).
- **F14 [MINOR], smart-commits half** — make the >20-commit path robust when `listCommitRange` is supplied (SA wires it); keep the loud audit when it is not.
- **F15 [MINOR], API half** — expose the credential source in the instance API (`src/ui/api.ts:479`).
- **F16 [MINOR]** — the Smart Commit advisory lock needs a timeout (`src/github/smart-commits.ts:181`) so one stuck delivery cannot stall the inbound queue.
