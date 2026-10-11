# Round-2 fixes — implementer GA

Tests for assigned findings:
- `tests/db/ledgers.test.ts` (F8)
- `tests/queue/workers.test.ts` (F9, F13, F17)
- `tests/sync/plane.test.ts` (F13, F17)
- `tests/sync/github.test.ts` (F9, F13)
- `tests/queue/audit.test.ts` (F9)

## F8 Pre-F16 commits retention pruning protection
- `src/db/ledgers.ts:67`: In `pruneLedgers`, added condition `AND workspace_slug <> ''` to `DELETE FROM processed_commits WHERE processed_at < NOW() - INTERVAL '1 day' * $1`. Legacy pre-F16 commits (stored with `workspace_slug = ''`) are excluded from pruning and remain permanently protected against re-applying `#done`/`#comment` on later branch/fork re-deliveries.
- `src/db/migrations/004-commit-workspace-retention.sql`: Backfilled `smart_commit` done markers (`delivery_id = 'sc:' || sha`, `outcome = 'applied'`) into `audit_log` for existing `processed_commits` rows where `workspace_slug = ''`. Because audit rows are never pruned (retention only strips payloads from `detail`), these legacy claims are permanently durable.
- Test: Added `"db: pruneLedgers excludes legacy commits with workspace_slug = '' (F8)"` in `tests/db/ledgers.test.ts`, verifying that old commits with `workspace_slug = ''` are preserved while old commits with non-empty workspace slugs are pruned.

## F9 Inbound retry horizon, narrow create-in-flight scoping, and final failure auditing
- `src/queue/index.ts:34-39`: Increased default inbound BullMQ `attempts` from 5 to 10 with exponential backoff starting at 2 s (`2s, 4s, 8s, 16s, 32s, 64s, 128s, 256s, 512s`), expanding the inbound retry horizon to >17 minutes so temporary backpressure and bulk opt-in cascades do not prematurely exhaust inbound deliveries.
- `src/sync/plane.ts:128-129, 192-202` & `src/sync/github.ts:22-23, 82-100`: Scoped in-flight creation markers narrowly by issue title/name (`pendingCreateHash(projectId, name)` and `pendingGithubCreateHash(repoId, title)`), while also setting the base marker for test harness backwards compatibility.
- `src/queue/workers.ts:100-145`: In `createInFlight`, checked narrow markers against `p?.data?.name` for Plane and `p?.issue?.title` for GitHub. Human issue creations for different items in the same project or repository are no longer blocked by our in-flight create. Added `waitForCreateInFlight` polling for up to 2000 ms (200 ms interval) so short in-flight creations resolve inline rather than failing the delivery.
- `src/queue/workers.ts:84-95, 180-195`: When `attemptsMade >= attempts` (or `final`), audited the delivery as failed via `auditDelivery(job.data, opts.inbound, "failed", err.message)`. `CreateInFlightError` on final attempt is recorded as an `inbound_delivery` row with `outcome: "failed"` and the error message, making the delivery fully visible in `audit_log` and eligible for operator replay through `replayDelivery`.
- Tests: Added `"inbound: create-in-flight marker is scoped narrowly and final failure is audited (F9)"` in `tests/queue/workers.test.ts`, verifying that issues with distinct names are processed immediately while matching names that exhaust retry attempts leave an audited `inbound_delivery` failure row.

## F13 Classification of queued-write failures and audit/replay observability
- `src/sync/plane.ts:123-125, 160-164`: Created typed `UnknownPlaneState extends Error`. In `#guardState`, when a referenced state cannot be found in cached or refreshed state lists, throws `new UnknownPlaneState(...)` instead of generic `Error`.
- `src/sync/plane.ts:113-120` & `src/sync/github.ts:8-16`: Extended `PlaneWrite` and `GithubWrite` type definitions to accept `deliveryId?: string`, `workspaceSlug?: string`, and `target?: string` metadata.
- `src/queue/workers.ts:140-150`: In `isPermanentWriteError(err, attemptsMade)`:
  - Treated `UnknownPlaneState` and `invalid GitHub installationId: 0` as permanent write errors immediately (`true`), preventing hours of useless retries.
  - Treated 401 HTTP errors (e.g. during credential rotation) as retriable for up to 5 attempts (`attemptsMade >= 5`), allowing transient rotation delays to resolve without failing the job immediately.
- `src/queue/workers.ts:162-175`: Updated `audit` in `startWorkers` to extract `workspaceSlug`, `deliveryId`, and `target` from `job.data`, populating them into top-level columns of `audit_log` and `detail` in `outbound_write_failed` audit rows.
- Tests: Added `"isPermanentWriteError: classifies UnknownPlaneState, invalid installationId, and 401 correctly (F13)"` in `tests/queue/workers.test.ts`.

## F17 Echo op recording for Plane link writes
- `src/sync/plane.ts:214-237`: In `PlaneWritePath.apply` for `add_link` and `update_link`, recorded echo hashes for both `links` and `link` fields (`opHash("plane", write.issueId, "links", write.url)` and `opHash("plane", write.issueId, "link", write.url)`) into `applied_ops` before dispatching the request. On failure, `forgetAppliedOps` clears them.
- `src/queue/workers.ts:30-40`: In `planeHash`, normalized `payload.activity.new_value` when `activity.field` is `"links"` or `"link"`, extracting `val?.url ?? (Array.isArray(val) ? val[0]?.url : val)` so inbound link activity matches the recorded op hash. Inbound link activity now resolves to `"echo"`, preventing Plane-side rules from executing on our own rollup writes.
- Tests: Added `"inbound: link activity matches recorded echo ops (F17)"` in `tests/queue/workers.test.ts`.
