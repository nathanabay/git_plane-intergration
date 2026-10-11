# Fix pass round 4 — all six implementers

Read `docs/impl/review-4.md` (the findings) and `.unlazy/impl/briefs/COMMON.md` (git rules). The spec
`docs/superpowers/specs/2026-10-10-plane-github-sync-design.md` is the source of truth; do not redesign it.

## User rule for this round: no slow gates

The user will run every gate and oracle after the coding is finished, so **do not run oracles,
`scripts/heavy.sh`, `gate-check`, or the whole test suite.** While you work, run only:

- typecheck: `node scripts/typecheck.mjs <your files> <your test file>`
- your targeted tests: `NODE_OPTIONS=--max-old-space-size=1024 node --test --test-timeout=60000 <test files>`
  (only the test files that cover the files you changed)

Unlazy, lightweight: keep `docs/impl/agent-gates/fix-r4-<you>.GATES.md` with `OWNS:` and one gate per
finding you fix. Each gate's CHECK is your targeted test or typecheck, not an oracle. Mark it with
the checker or by running the CHECK yourself.

## Ownership (disjoint: edit only your files; ask the driver for anything else)

| Agent | Findings | Owns |
|---|---|---|
| CB (Codex) | F2, F3, F10 | `src/operations/outbox.ts`, `src/operations/plans.ts`, `tests/writers/review-r4-cb.test.ts` |
| CA (Codex) | F9, prev F17 | `src/sync/plane.ts`, `src/config/env.ts`, `tests/sync/review-r4-ca.test.ts` |
| CC (Codex) | F4, prev F5 (assignee mapping by id, `src/sync/mirror.ts:238`) | `src/sync/mirror.ts`, `tests/mirror/review-r4-cc.test.ts` |
| SA (Claude) | F1, F5 | `src/app/main.ts`, `src/app/mappings.ts`, `src/ui/mapping-check.ts`, `tests/app/review-r4-sa.test.ts` |
| SB (Claude) | F11, prev F15 | `src/ui/api.ts`, `src/app/credentials.ts`, `src/app/identity.ts`, `src/db/ledgers.ts`, `src/db/migrations/007-*.sql`, `src/db/schema.ts`, `tests/ui/review-r4-sb.test.ts` |
| SC (Claude) | F6, F7, F8, prev F18 | `src/github/pr-automation.ts`, `src/app/pr.ts`, `src/app/issues.ts`, `src/app/rules.ts`, `tests/github/review-r4-sc.test.ts` |

Only SB writes a migration (007). If you need a schema change, send its exact SQL to the driver,
who relays it to SB. If an existing test breaks because of a deliberate fix, tell the driver which
test and why rather than editing a file you do not own.

## When done

Write `docs/impl/fixes-r4-<YOU>.md`: per finding, what changed (file:line) and which test proves it.
Then reply in one line: `<YOU> DONE: <findings> — typecheck + targeted tests pass`.
