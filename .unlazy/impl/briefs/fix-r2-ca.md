# Fix pass r2 — Codex implementer CA (leaf fix-r2-ca)

Read `.unlazy/impl/briefs/COMMON.md`, `.unlazy/impl/briefs/fix-r1-common.md` (rules and the
RESOURCE RULE still apply; read "r1" as "r2" for file names), and each finding's full text in
`docs/impl/review-2.md` (its `Evidence:` and `Fix:` lines are the spec for your change). Also note
which round-1 findings review-2 marked STILL OPEN (prev F2, F14, F18) — they are folded into F1/F7/F14.

Six implementers work at once, each in its own files. Never write outside your OWNS. Fixes document:
`docs/impl/fixes-r2-CA.md` (one `## F<n>` section per finding). Ledger:
`docs/impl/agent-gates/fix-r2-ca.GATES.md` — copy gates G0–G5 from `.unlazy/impl/gates/fix-r2-ca.md`
(not G6). Heavy checks only through `sh scripts/heavy.sh`; ad-hoc tests with
`NODE_OPTIONS=--max-old-space-size=1024 node --test --test-timeout=60000 <file>`.

## OWNS

    src/app/rules.ts, src/app/rule-events.ts, src/app/reducers.ts, src/app/github.ts, tests/a8/**, docs/impl/fixes-r2-CA.md, docs/impl/agent-gates/fix-r2-ca.GATES.md

## Your findings (review-2)

- **F4 [BLOCKING]** — a first push of a branch cut from main must not target the items of PRs that merely contain `main`'s tip (`src/app/rules.ts:123`): only PRs whose head is this branch count.
- **F5 [BLOCKING]** — with a saved lifecycle table, "branch pushed" must fire only for a branch's first push, never for every push or merges to main (`src/app/rules.ts:108`).
- **F10 [MAJOR]** — a completed check *run* must not be reported as `check_suite.<conclusion>` (`src/app/rule-events.ts:29`).
