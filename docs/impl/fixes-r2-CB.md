# Round 2 fixes — CB

## F2

`src/app/writers.ts:46` and `src/operations/outbox.ts:75` derive BullMQ job IDs from the unsanitized delivery ID, destination side,
and canonical write content. Skipped earlier steps cannot move another target onto a retained
job ID. Equivalent object key orders deduplicate; distinct delivery IDs and targets do not.
Queued `apply()` acknowledges actual worker completion rather than `queue.add()`. Pending
writes fail retriably after a bounded wait, so Smart Commits do not create applied step records
or claim a commit before its writes finish.
Completion polling selects only status/result/error, avoiding repeated loads of large write payloads.

`tests/writers/writers.test.ts` reproduces five old failures: positional retry collisions,
key-order/position instability, delivery-ID sanitization collisions, early acknowledgements,
and GitHub target collisions. All five failed before the change and pass after it.
`tests/writers/smart-commit.test.ts` drives the real Smart Commit reducer and database: a
WEB-1/WEB-2 transition with one transient preflight failure applies both targets on retry;
a still-pending outbound write produces neither an applied step nor a commit claim. Both pass.

## F6

`src/operations/outbox.ts:119` implements a durable FIFO outbox. Every write, including result-bearing
and actor-token writes, reserves its place per target before queueing. Workers execute the oldest
pending intent under an advisory lock on a dedicated connection across replicas (and an in-process
guard for single-connection test engines). A delayed retry cannot be overtaken. One intent per
worker invocation preserves queue scheduling. Actual failures have a 30-attempt
budget and backoff stored against the intent; waiting behind another intent spends no failure budget.
Only a Plane user ID is persisted for actor writes; the worker reloads the current PAT before
execution, and a revoked PAT fails closed. Intent recovery covers a crash/failure between durable
registration and Redis enqueue. Completion results, including created IDs, are persisted after
the API succeeds and returned to reducers only then.
Recovery fetches at most 100 small references and loads missing jobs one payload at a time,
so large descriptions/comments cannot accumulate in a batch result.

Registration uses a separate transaction advisory lock so two replicas cannot commit a higher
sequence while an earlier registration is invisible. Terminal status and its failure audit commit
together on production PostgreSQL. Compound Plane label/assignment intents and desired GitHub assignee sets read current
fields under the execution lock, rather than persisting a stale read-modify-write snapshot.

Tests: `outbox.test.ts` covers delayed predecessors, other targets, simultaneous executors,
actor/service ordering, current-PAT reload, revocation, and recovery after Redis enqueue failure.
`postgres-order.test.ts` uses two real PostgreSQL pools to check execution exclusion and ordered
registration commits. `compound.test.ts` covers mirror-plus-rule label updates and a delayed
GitHub addition followed by an empty desired set, preserving unmapped users. `recovery.test.ts`
covers the 100-row recovery bound, later wake-ups, the retry budget, and persisted create results.
All of these pass. `schema.test.ts` failed before migration 005 and now passes against production
migrations. `service.test.ts` failed against the old main wiring, then passed after owner integration:
the real `runService`, a signed issue-close webhook, a transient mirror outage, and a stored user PAT
produce Done as the service followed by Released as the actor. Both intents and BullMQ jobs finish;
Redis stores the user ID without the PAT. CA independently reran the same service test successfully.

### Integrated owner changes

- **GA migration (landed):** `005-outbound-writes.sql` provides the production table.
  Columns: `id`, `sequence`, `side`, `target_key`, `delivery_id`,
  `workspace_slug`, `actor_user_id`, `write`, `status`, `attempts`, `retry_at`, `result`, `error`,
  `created_at`, `updated_at`; pending-target index. Every outbox test uses the real migrations.
- **GA worker hook:** `startWorkers` delegates to `ordered.executePlane/Github`, moves
  `OrderedWriteDeferredError` wake-ups to delayed without spending BullMQ attempts, and runs
  serialized bounded recovery on startup and every 15 seconds. Close drains recovery. Metadata
  jobs fail closed without the hook; failure audit reads `_gitsync` correlation metadata.
- **SA main wiring:** constructs one `createOrderedOutbox`, supplies current-field/assignee
  readers and `vault.load` for current PATs, gives reducers its writers, and gives workers the
  same executor. Creates and other result-bearing writes also traverse this queue.
- **GB compound mutations / SA assignee sync:** live label/assignment actions use optional
  `plane.mutateIssue(target, mutation, opts)`. `assigneeSyncWriter` calls
  `github.setAssignees(write, workspaceSlug)` for every desired set, including `[]`, before
  reading/diffing. Both methods perform the compound operation under the worker's lock.
  Standalone raw writers retain their immediate-field fallback.
- **SB PAT ownership:** `SecretString` carries an optional readonly `planeUserId`;
  `TokenVault.load` attaches the owner. CB reads that ID, never the token plaintext for identity.
- **CA scope metadata:** `deliveryScope` includes nonempty declared Plane `workspace_slug`;
  UUID-only and GitHub payload fields do not populate it. Plane destinations derive their
  workspace from `write.slug`; GitHub destinations use scope metadata for failure correlation.
- **GA legacy fixture:** supplies `getJob()`/completed state, expects content IDs, and expects
  actor writes to fail closed in the legacy adapter. Production actor writes use the outbox.

These edits were made by their respective owners after driver relay and Orca coordination.
CB wrote only the owned writer/outbox, tests, report, and ledger. No spec disagreement.
