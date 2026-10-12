# Round 6 CC — mirror registration authority

`src/sync/mirror.ts` scopes both public mirror entry points with the verified mapping's
`freezeMappingAuthority(mapping)` snapshot. Direct updates, cross-link writes, create-plan
steps and deferred `resume_reducer` registration therefore inherit the same source authority.
Pending mirror continuations re-enter these entry points, so the writes they register receive
authority even when the worker starts with a fresh delivery scope.

The nested scope preserves the caller's delivery, replay and operation metadata and restores
the caller's scope after completion. Direct consumers without an outer scope receive a fresh
delivery ID. Only the shared outbox copies the snapshot to durable `write._authority`.

`tests/mirror/review-r6-cc.test.ts` checks persisted outbox rows for linked updates in both
directions, every step of both create workflows, deferred events on both destination queues,
and writes registered after continuation dispatch. It drains workflows with the production
authorizer installed, checks scope restoration, and verifies that re-registering an existing
intent after a mapping change preserves the first authority. A direct-caller case covers the
absence of an outer delivery scope. Existing fixtures were not changed.

Shared seam: the mapping helper's owner narrowed its input to the four authority fields,
allowing `MirrorMapping` to pass directly without a cast. CC did not edit shared seam files.

Validation:

- `NODE_OPTIONS=--max-old-space-size=1024 node scripts/typecheck.mjs "src/sync/mirror.ts" "tests/mirror/review-r6-cc.test.ts"`
  — passed, 33 project files.
- `NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/mirror/review-r6-cc.test.ts tests/mirror/mirror.test.ts`
  — all 26 existing mirror tests passed; the four new tests initially failed during fixture
  setup because the new mapping INSERT omitted the required `sync_direction` column.
- After supplying `sync_direction: bidirectional` in the new fixture,
  `NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/mirror/review-r6-cc.test.ts`
  — passed, 4 tests, 0 failures/cancellations/skips.

Both lightweight ledger gates passed by direct execution. Only two test files were exercised;
every test invocation used heap 1024, concurrency 1 and timeout 60000. Product code was unchanged
after the successful typecheck and existing mirror-test run.

No spec disagreement. No staging, commits or pushes. No oracle, heavy wrapper, gate-check or
whole-suite execution.
