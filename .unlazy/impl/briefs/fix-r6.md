# Fix pass round 6 — three Codex implementers

Read `docs/impl/review-6.md` (findings and Fix lines), `docs/impl/gate-run-r5.md` (stale-fixture
failures) and `.unlazy/impl/briefs/COMMON.md`. The spec is the source of truth; do not redesign it.

## Rules (unchanged)

No oracles, `heavy.sh`, gate-check or whole suite. Only typecheck and capped tests:
`NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 <at most 3 files>`.
Edit only your row's files. Never stage, commit or push. Lightweight ledger
`docs/impl/agent-gates/fix-r6-<you>.GATES.md`.

## Shared contract, decided by the driver: frozen write authority

F2 and F4 are the same gap: an intent does not record the authority it was admitted under, so the
authoriser re-derives it later from mutable state (SHA claims, whichever mapping currently links the
target). From this round on:

- **At registration**, every durable intent that originates from a GitHub repository (Smart Commit
  steps, check/deployment rollups, PR linkbacks, mirror writes) stores
  `write._authority = { workspaceSlug: string, mappingId: string, repoId: number, installationId: number }`,
  taken from the verified mapping the reducer is running under. It is set once and never changed.
- **The authoriser** (`createOutboundAuthoriser`), when `_authority` is present, checks that THIS
  mapping still exists and is enabled for that workspace, that its repo and installation are unchanged,
  and that the installation is still allow-listed for that workspace. It does not consult SHA claims or
  other mappings. Intents without `_authority` keep today's checks (older rows).
- `resume_reducer` continuations are authorised by their stored continuation mapping/workspace before
  any side-specific branch (F1).

## Ownership

| Agent | Work | Owns |
|---|---|---|
| CB | F2 (registration side: store `_authority`; Smart Commit admission), F3, stale fixtures in `tests/writers/review-r3.test.ts`, `tests/writers/review-r4-cb.test.ts`, `tests/writers/service.test.ts` | `src/operations/outbox.ts`, `src/operations/plans.ts`, `src/github/smart-commits.ts`, those three test files, `tests/writers/review-r6-cb.test.ts` |
| CD | F1, F4 (authoriser validates `_authority`; `checks.ts` targets scoped to the mapping's workspace; rollups carry `_authority`), F2 validation side | `src/app/mappings.ts`, `src/app/checks.ts`, `src/sync/dev-info.ts`, `src/app/main.ts`, `tests/app/review-r6-cd.test.ts` |
| CA | F5, stale fixtures in `tests/github/review-r4-sc.test.ts` (two NULL-installation cases: give them a verified installation so they test their original intent) | `src/app/pr.ts`, `src/app/issues.ts`, `tests/github/review-r4-sc.test.ts`, `tests/app/review-r6-ca.test.ts` |

Stale-fixture rule: update a fixture only to match a deliberate earlier fix, never weaken what the
test proves, and say in your report which fix made it stale. If `_authority` must also be set in a
file you do not own (for example a reducer in `src/app/pr.ts`), send the exact change to the driver.

## When done

`docs/impl/fixes-r6-<YOU>.md`, then reply `<YOU> DONE: <findings> — typecheck + targeted tests pass`.
