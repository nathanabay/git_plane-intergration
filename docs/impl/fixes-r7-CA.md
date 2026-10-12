# CA — review 7 fixes

Implemented F1, F2, the relayed mapping-scope contract, and the stale PR recovery fixture update.
Product/test edits are limited to the five assigned files. No staging, commits, pushes, or
changes to `mappings.ts`, `writers.ts`, the outbox, or another owner's files.

## F1 — refresh installation before freezing authority

- `src/app/push.ts:31` resolves the delivery's installation, persists any allowed update, and
  verifies workspace authorization before entering the frozen authority scope or looking up
  the unmapped sender. The scope preserves the original write-delivery identity on replay.
- `src/app/pr.ts:173` performs the same refresh/authorization before PR mapping work enters
  `deliveryScope.run` and its writer context. `src/app/pr.ts:125` scopes standalone readiness
  work while preserving an already admitted snapshot for nested readiness.
- `src/app/pr.ts:328` resumes PR work under the dispatched saved authority. It leaves durable
  authority and successful results unchanged. `src/app/issues.ts:17` enters the same agreed
  scope for ordinary issue work and all mirror continuation paths, preserving dispatched
  snapshots alongside the existing writer wrappers.
- Proof: `tests/app/review-r7-ca.test.ts:78` uses the actual push/inbound reducers and production
  authorizer with installations 1 and 4242 allowed. It verifies refreshed authority before an
  unmapped sender's profile lookup, unchanged intent identities/authority through repair,
  and once-only Smart Commit state/comment plus branch rollup execution.
  `tests/app/review-r7-ca.test.ts:105` verifies the equivalent PR create/tail-failure/replay
  path, including once-only state, comment, rollup and linkback. Registration spies assert
  that each insertion actually runs in the refreshed authority scope.
  `tests/app/review-r7-ca.test.ts:132` proves both reducers reject an unlisted replacement
  installation before registration, leaving the verified mapping unchanged.

## F2 — confirmed orphans bypass the failed-create fence

- `src/app/pr.ts:207` excludes a failed workflow from the event fence only when its saved
  successful Plane create result identifies an orphaned PR link for the exact workspace,
  target project, repository and PR number. A fresh request can then reach the existing
  orphan replacement-generation policy. Ambiguous/unlinked failures stay on their old identity
  and remain held for explicit repair; original successful delivery replay remains guarded.
- Proof: `tests/app/review-r7-ca.test.ts:142` creates the partner, terminally fails the original
  tail, performs actual reconciliation orphaning, checks old-delivery replay, and issues a
  fresh request with pending and completed replacement replays. It verifies one distinct
  replacement intent, exactly two total partners, one active replacement link, and unchanged
  original failed workflow rows.

## Stale fixture

`tests/mirror/review-r5-cc.test.ts:141` now requires explicit replay before an ambiguous
terminal PR create resumes. The deliberate round-6 F5 fix replaced implicit edit recovery
with held continuations and explicit repair. The fixture still verifies that the edit is
durably retained under the original root, that every row remains failed before repair,
that unavailable recovery never produces a second POST, and that all lookups retain the
original `external_id`. Mirror re-opt-in expectations are unchanged.

## Verification

Final typecheck exited 0: `typecheck passed (44 project files)`.
The capped regression batch exited 0: **16 passed, 0 failed**, no cancellations/skips.

```sh
node scripts/typecheck.mjs src/app/push.ts src/app/pr.ts src/app/issues.ts tests/mirror/review-r5-cc.test.ts tests/app/review-r7-ca.test.ts
NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/app/review-r7-ca.test.ts tests/mirror/review-r5-cc.test.ts tests/app/review-r6-ca.test.ts
```

The batch includes round-6 terminal-unlinked event retention, explicit replay/Retry and source
authority regressions. No oracles, heavy.sh, gate-check, gate-lint, or whole suite ran.
The four declared ledger outcomes passed direct permitted checks; driver-generated checker
evidence remains pending in `docs/impl/agent-gates/fix-r7-CA.GATES.md`.
