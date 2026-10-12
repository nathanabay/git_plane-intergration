# Fix pass round 5 — five Codex implementers

Read `docs/impl/review-5.md` (findings and their Fix lines), `.unlazy/impl/briefs/COMMON.md` (git rules)
and the spec `docs/superpowers/specs/2026-10-10-plane-github-sync-design.md` (source of truth; no redesign).
F8 was also found independently: `docs/impl/test-change-check-r4.md`, section 3.

## Rules for this round

- **No oracles, no `scripts/heavy.sh`, no gate-check, no whole suite.** The driver runs the full gates after
  this round. While you work, run only:
  - `node scripts/typecheck.mjs <your files> <your tests>`
  - `NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 <at most 3 files>`
- **Memory:** this host is the live Plane server. An automatic guard kills any test run above 2.5 GB.
- **Ownership:** edit only the files in your row. If you need a change elsewhere, send the exact change to
  the driver. If an existing test breaks because of a deliberate fix, tell the driver which test and why.
- Never stage, commit or push.
- Lightweight unlazy: `docs/impl/agent-gates/fix-r5-<you>.GATES.md` with `OWNS:` and one gate per finding,
  with your targeted test or typecheck as the CHECK.

## Ownership

| Agent | Findings | Owns |
|---|---|---|
| CC | F1, F2 (mirror replay and generation identity) | `src/sync/mirror.ts`, `src/operations/tooling.ts`, `tests/mirror/review-r5-cc.test.ts` |
| CA | F4, F5, F6 (PR `{ID}-NEW` lifecycle) | `src/app/pr.ts`, `src/app/issues.ts`, `src/app/rules.ts`, `tests/app/review-r5-ca.test.ts` |
| CB | F9, F11 (Smart Commit replay and retry UI; throttled readiness) | `src/operations/outbox.ts`, `src/operations/plans.ts`, `src/github/smart-commits.ts`, `src/github/pr-automation.ts`, `src/ui/client/Workspace.tsx`, `src/ui/client/http.ts`, `tests/github/review-r5-cb.test.ts` |
| CD | F3, F10 (installation authority, health source) | `src/app/mappings.ts`, `src/app/main.ts`, `src/ui/mapping-check.ts`, `src/ui/client/Admin.tsx`, `tests/app/review-r5-cd.test.ts` |
| CE | F7, F8 (unlink race, durable credential marker) | `src/ui/api.ts`, `src/app/identity.ts`, `src/app/credentials.ts`, `src/config/env.ts`, `src/db/ledgers.ts`, `src/db/migrations/008-*.sql`, `src/db/schema.ts`, `docker-compose.override.yaml`, `deploy/**`, `tests/ui/review-r5-ce.test.ts` |

Only CE writes a migration (008); send any other schema change to the driver, who relays it to CE.
Cross-agent seams this round: F3's re-check at execution time touches the outbox (CB) and F9 needs
`retryFailed` in the UI (CB: Workspace.tsx; the route is CE's api.ts). Agree the interface through the
driver before building on it.

## When done

Write `docs/impl/fixes-r5-<YOU>.md` (per finding: what changed at file:line and which test proves it),
then reply in one line: `<YOU> DONE: <findings> — typecheck + targeted tests pass`.
