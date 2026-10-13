# Fix pass: documentation audit findings (five implementers)

Findings: `docs/impl/audit-plane.md` (prefix **P**) and `docs/impl/audit-github.md` (prefix **G**).
Each finding has File, Doc, Code, Impact and Fix lines. Fix every finding in your row, MINOR ones
included. The spec `docs/superpowers/specs/2026-10-10-plane-github-sync-design.md` is the source of
truth for intent. Where a finding needs a spec wording change, tell the driver instead of editing it.

## Rules for this round (user's instruction)

- **Do not run tests.** The driver runs every test once after all coding is done.
- **Do** write regression tests for your fixes, in `tests/<area>/audit-<you>.test.ts`.
- Your only check while working: `node scripts/typecheck.mjs <your files> <your test file>`.
- Use Context7 (`npx ctx7@latest library|docs ...`, or the find-docs skill) whenever you depend on
  Plane or GitHub behavior. Do not guess the API from memory.
- Edit only your row's files. If you need a change elsewhere, send the exact change to the driver.
  Never stage, commit or push.

## Shared contracts (decided by the driver)

1. **GitHub error classifier** (owner G1): new `src/github/errors.ts` exports
   `classifyGithubError(err): { kind: "rate_limited", retryAt: number } | { kind: "permission" } |
   { kind: "not_found" } | { kind: "transient" } | { kind: "permanent" }`. It recognizes primary and
   secondary limits from status, headers (`retry-after`, `x-ratelimit-remaining`, `x-ratelimit-reset`)
   **and** GitHub's documented secondary-limit message body, with a 60-second minimum exponential
   fallback when no header is given. `retryAt` is an epoch-ms deadline to honor in full. Everyone else
   imports it rather than writing their own status checks.
2. **Deferred retry**: a rate-limited job or intent is retried **at `retryAt`**, by delaying the
   queue job or the outbox row, never by sleeping while holding a worker (G1 owns that mechanism).
3. **Complete pagination**: a list read either returns everything, or returns
   `{ items, complete: false }`. Readiness and rollups fail closed on an incomplete read. They never
   treat a first page as the whole set.
4. **Migration 009** (owner G4) is the only schema change this round. Send any column or table you
   need to the driver.

## Ownership

| Agent | Findings | Owns |
|---|---|---|
| G1 (Codex) | G2, G3, G4, G13, P4 | `src/github/errors.ts` (new), `src/sync/backoff.ts`, `src/sync/github.ts`, `src/queue/index.ts`, `src/queue/workers.ts`, `src/operations/outbox.ts`, `src/operations/plans.ts`, `tests/queue/audit-g1.test.ts` |
| G2 (Codex) | G5, G7, G8, G9, G15, G16, G11 (checks.ts and push.ts parts) | `src/app/checks.ts`, `src/app/push.ts`, `src/github/pr-automation.ts`, `src/github/smart-commits.ts`, `src/operations/tooling.ts`, `tests/github/audit-g2.test.ts` |
| G3 (Claude Opus) | G6, G10, P3 | `src/app/pr.ts`, `src/app/issues.ts`, `src/sync/mirror.ts`, `src/app/rules.ts`, `tests/mirror/audit-g3.test.ts` |
| G4 (Claude Opus) | P1, P2, P5, P6, P9, P10 | `src/api/**`, `src/sync/plane.ts`, `src/sync/reconcile.ts`, `src/queue/cron.ts`, `src/db/**` (migration 009, ledgers, schema), `tests/sync/audit-g4.test.ts` |
| G5 (Codex) | G1, G12, G14, G11 (ui/client part), P7, P8 | `src/app/github.ts`, `src/app/main.ts`, `src/app/mappings.ts`, `src/app/context.ts`, `src/app/reducers.ts`, `src/ui/**`, `src/config/env.ts`, `deploy/git-sync.env.example`, `tests/ui/audit-g5.test.ts` |

## When done

Write `docs/impl/fixes-audit-<you>.md`: per finding, what changed (file:line), the new test that
covers it, and anything you deferred or sent to another owner. Then reply in one line:
`<YOU> DONE: <findings> — typecheck passes`.
