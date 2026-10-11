# Fix pass r3 — Codex implementer CA (leaf fix-r3-ca)

Read `.unlazy/impl/briefs/COMMON.md` and `.unlazy/impl/briefs/fix-r1-common.md` (rules and RESOURCE
RULE apply; read "r1" as "r3" for file names), and each finding's full text in `docs/impl/review-3.md`
— its `Evidence:` and `Fix:` lines specify the change. Review 3 also lists three round-2 findings STILL
OPEN (prev F1 scope, prev F12 lookup unwired, prev F13 silent loss); they are folded into F4, F5 and F7.

Six implementers work at once, each in its own files; never write outside your OWNS. When a fix needs a
change in someone else's file, write the exact change in your fixes doc and tell the driver.
Fixes document: `docs/impl/fixes-r3-CA.md` (one `## F<n>` section per finding). Ledger:
`docs/impl/agent-gates/fix-r3-ca.GATES.md` — gates G0–G5 from `.unlazy/impl/gates/fix-r3-ca.md` (not G6).
Heavy checks only via `sh scripts/heavy.sh`; ad-hoc tests with
`NODE_OPTIONS=--max-old-space-size=1024 node --test --test-timeout=60000 <file>`.

## OWNS

    src/app/rules.ts, src/app/rule-events.ts, src/app/reducers.ts, src/app/github.ts, tests/a8/**, docs/impl/fixes-r3-CA.md, docs/impl/agent-gates/fix-r3-ca.GATES.md

## Your findings (review-3)

- **F10 [MAJOR]** — `branch.created` must not target commit-message references in a way that reopens finished items on backport and revert branches (`src/app/rules.ts:142`). Decide the correct target set (§7.1 "branch pushed" is about the branch's own work), document it, and test backport and revert branches.
