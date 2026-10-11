# Round-3 fixes — implementer GA

Tests for assigned findings:
- `tests/db/ledgers.test.ts` (F4, F13)
- `tests/queue/workers.test.ts` (F11, F14, F17)
- `tests/sync/plane.test.ts` (F17)

## F4 Workspace to GitHub installation allow-list table and ledger functions
- **Migration `src/db/migrations/006-workspace-installations.sql`:**
  - Created table `workspace_installations`:
    - `installation_id BIGINT PRIMARY KEY` (a GitHub App installation belongs to at most one workspace)
    - `workspace_slug TEXT NOT NULL`
    - `account_login TEXT` (optional label for the org/user)
    - `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`
    - Index `idx_workspace_installations_slug` on `workspace_slug`.
  - Also created table `pending_sync_links` per cross-owner contract with CB:
    - `key TEXT PRIMARY KEY`, `outbox_id TEXT NOT NULL REFERENCES outbound_writes(id) ON DELETE CASCADE`, `link JSONB NOT NULL`, `created_at TIMESTAMPTZ DEFAULT now()`.
- **Ledger functions (`src/db/ledgers.ts`):**
  - `allowlistInstallation(db, installationId, workspaceSlug, accountLogin?)`: registers or updates an installation allow-list mapping for a workspace (idempotent for same workspace, conflict-guards races).
  - `removeInstallationAllowlist(db, installationId)`: deletes an installation allow-list mapping.
  - `listWorkspaceInstallations(db, workspaceSlug?)`: lists all allow-listed installations ordered by `workspace_slug` and `installation_id`.
  - `getInstallationWorkspace(db, installationId)`: resolves which workspace slug is bound to a GitHub App installation.
- **Verification:**
  - `tests/db/ledgers.test.ts` verifies registering, listing, conflict handling, and deletion of allow-listed installations.

## F11 Outbox wake-up rate-limiting, client-side rate budget, and head-of-line unblocking
- **Client-side rate budget in `PlaneClient` (`src/sync/plane.ts`):**
  - Implemented `TokenBucket` rate limiter:
    - Default rate: `rateLimitPerMinute: 60` (matching Plane's `API_KEY_RATE_LIMIT = 60/minute`). Configurable via `opts.rateLimitPerMinute` or `opts.requestsPerMinute`.
    - `burstCapacity`: configurable burst ceiling (defaults to `rateLimitPerMinute`).
    - Every HTTP request in `PlaneClient.request()` acquires a token via `await this.#rateLimiter.acquire()` before issuing the request or retry.
    - Token reservations are serialized through a promise queue (`#queue`) to prevent microtask concurrency races from over-allocating tokens.
    - When available tokens fall below cost, `acquire()` sleeps for the exact time required to accumulate the necessary token fraction (`ceil(needed / fillRate)`), smoothly pacing requests without exceeding the per-minute quota.
    - Exposes `client.rateLimitPerMinute` and `client.rateBudget` (`TokenBucket`) so callers and tests can inspect budget capacity and rates.
- **Decoupled BullMQ worker limiter from API capacity (`src/queue/workers.ts`):**
  - Removed BullMQ worker-level `limiter: { max: opts.planeWritesPerMinute ?? 50, duration: 60_000 }` on `outboundPlane`.
  - In BullMQ, worker limiters count every job entering processing. When jobs throw `OrderedWriteDeferredError` to park behind an in-flight head, each delayed wake-up consumed one of the 50 slots per minute without making any remote HTTP requests, starving other active targets and leading to synthetic 30-second timeouts.
  - Remote HTTP rate limits are now handled cleanly at the client token bucket layer in `PlaneClient`. Removing the BullMQ worker-level limiter allows deferred wake-ups to be processed immediately when ready without spending Plane's rate budget on deferred wake-up checks.
- **Verification:**
  - `tests/sync/plane.test.ts` tests that a burst of 5 concurrent requests or writes exceeding burst capacity is properly paced under the 60/min budget, verifying that excess writes wait ~1000ms each and total sleep time conforms to the rate budget.
  - `tests/queue/workers.test.ts` exercises inbound and outbound worker concurrency, error handling, and deferred job processing.

### F11 contract for CB (head-of-line unblocking and attempt cap)
- **Problem addressed:** Retriable intents backing off through 30 attempts with exponential delays could hold a target key blocked for ~3.8 hours. Furthermore, creates keyed coarsely by project (`[plane, slug, projectId, "issues"]`) allowed a single failing create to stall all creates across the project.
- **Exact contract required in `src/operations/outbox.ts`:**
  1. **Option & Field Names (with units and defaults):**
     - `maxAttempts?: number`: default `10` (maximum retry attempts per outbound intent). Bounded to ~17–20 minutes maximum backoff rather than 3.8+ hours.
     - `maxTargetBlockDurationMs?: number`: default `1_200_000` ms (20 minutes). Hard ceiling on the duration a single head intent may remain retrying before being classified as terminally failed.
     - `targetKey` scoping for creates: Key create intents by object idempotency key (`create:gh:{repoId}#{number}→{projectId}` / `create:pr:...`) or include item identifier rather than a coarse project-level key (`[plane, slug, projectId, "issues"]`), ensuring independent creates advance in parallel.
  2. **Terminal Handling at Cap:**
     - When `attempts >= (deps.maxAttempts ?? 10)` or blocking duration expires:
       - Update row in `outbound_writes`: `status = 'failed'`, `retry_at = NULL`.
       - Atomically record terminal failure in `audit_log` (`kind: "outbound_write_failed"`, `outcome: "failed"`, `error: message`, `detail: { outboxId, target, write }`).
       - **Target Unblocking:** Immediately invoke `wakeFollowing(head)` to wake the next pending intent on that `target_key`, preventing head-of-line starvation of subsequent writes.
       - Throw `QueuedWriteFailedError(head.id, message)` rather than rescheduling so BullMQ does not spend further attempts.
  3. **Worker Behavior Relying on Outbox:**
     - Workers in `src/queue/workers.ts` do not manage per-target FIFO or dependent step scheduling. They delegate directly to `ordered.executePlane(job)` / `ordered.executeGithub(job)`.
     - When `OrderedWriteDeferredError` is thrown, the worker parks the BullMQ job with `moveToDelayed(Date.now() + err.retryAfterMs, token)` and throws `DelayedError()` without spending BullMQ retry attempts.
     - The worker BullMQ limiter is eliminated so delayed wake-ups never exhaust API rate limit quotas.

## F13 Retention pruning of outbound writes
- **Migration `src/db/migrations/005-outbound-writes.sql`:**
  - Added column `outbound_retention_days INT NOT NULL DEFAULT 30` to `instance_settings`.
  - Added index `idx_outbound_writes_retention ON outbound_writes(status, updated_at) WHERE status IN ('applied', 'failed')`.
- **Ledger functions (`src/db/ledgers.ts`):**
  - Updated `readRetention(db)` to query `outbound_retention_days` and return `{ ..., outboundDays: number }` (defaulting to 30 days).
  - Updated `pruneLedgers(db, retention)` to prune applied and failed rows older than `retention.outboundDays ?? retention.deliveryDays`:
    `DELETE FROM outbound_writes WHERE status IN ('applied', 'failed') AND updated_at < NOW() - INTERVAL '1 day' * $1 ...`
  - **Invariants:**
    - Rows with status `pending` are strictly preserved regardless of age so that uncompleted / retriable work is never dropped.
    - Plan roots and steps are preserved while any sibling in the same plan is still pending (`EXISTS (SELECT 1 FROM outbound_writes sibling WHERE sibling.status = 'pending' AND sibling.write->'_plan'->>'root' = outbound_writes.write->'_plan'->>'root')`), or while referenced by `pending_sync_links`.
    - Once all steps in a plan have completed (no pending siblings remain), the root and its completed steps prune normally past retention.
- **Verification:**
  - `tests/db/ledgers.test.ts` tests that applied/failed outbound writes older than 30 days are pruned, while recent writes, pending writes, and writes with pending plan children or pending sync links are preserved, and that completed plans prune normally.
  - `tests/reconcile/reconcile.test.ts` verifies `readRetention` and `pruneLedgers` across ledger tables.

## F14 De-duplicate failure audits and fix correlation field
- **Inbound failure audit de-duplication (`src/queue/workers.ts`):**
  - `processInbound`: Inbound deliveries now only audit `failed` when an attempt is final (`isFinal && !_auditedFinal`), rather than logging a `failed` audit on every retry attempt (which previously emitted 11 duplicate rows with full payloads for an exhausted delivery).
  - Stamped `_auditedFinal = true` so the worker's `failed` event listener does not log a redundant audit row.
  - When an inbound retry eventually succeeds, previously recorded failed audits for that delivery are updated to `outcome = 'superseded'` in `audit_log`, ensuring only genuine, unrepaired failures appear in the replay list.
- **Replay identity (cross-owner coordination F1 with CB):**
  - Added optional `writeDeliveryId?: string` to `InboundJob` (`src/queue/index.ts`). A replay keeps a fresh transport `deliveryId` (so the duplicate ledger admits it), while `writeDeliveryId` carries the original delivery identity for write deduplication.
  - `auditDelivery` in `src/queue/workers.ts` preserves `writeDeliveryId` in the audit log `detail`.
- **Outbound audit de-duplication and correlation (`src/queue/workers.ts`):**
  - Worker `failed` listener now skips logging outbound failure if `_gitsync` is present on job data or if the error is `QueuedWriteFailedError`, because terminal outbound failures are already audited atomically inside the outbox.
  - Worker `audit` helper reads `outboxId` from `g?.id ?? g?.outboxId`, matching the outbox intent table schema where the identifier is `id`.
- **Classification update (`src/queue/workers.ts`):**
  - Removed `/invalid GitHub installationId: 0/` from `isPermanentWriteError` (F7 alignment: transient installation lookup failures should retry rather than immediately terminating Plane->GitHub sync).
- **Verification:**
  - `tests/queue/audit.test.ts` and `tests/queue/workers.test.ts` verify that explicit transient attempts (`{ attemptsMade: 0, maxAttempts: 10 }`) leave no failed audit rows, final attempts (`{ attemptsMade: 9, maxAttempts: 10 }`) write exactly one failed audit row, subsequent success marks prior failures `superseded` leaving only `handled` rows, and `writeDeliveryId` is preserved in `auditDelivery`. Standalone invocations omitting `attemptInfo` default to `isFinal = true`. Also verifies `isPermanentWriteError` classification.

## F17 Cleanup dead safeguards (004 backfill, link ops, service user config)
- **Drop dead 004 backfill (`src/db/migrations/004-commit-workspace-retention.sql`):**
  - Removed dead audit log backfill insert which used `workspace_slug = ''` that never matched runtime queries (`recorded()` checks `workspace_slug = $2`).
- **Remove unconsumed link ops (`src/sync/plane.ts`, `src/queue/workers.ts`):**
  - Removed link op recording (`recordAppliedOps` and `forgetAppliedOps`) from `add_link` and `update_link`. Plane v1.4.2 link endpoints (`IssueLinkListCreateAPIEndpoint` / `IssueLinkDetailAPIEndpoint`) invoke `issue_activity` (not `model_activity`), which sends no webhooks. The recorded link ops expired unconsumed and polluted `applied_ops`.
  - Simplified `planeHash` in `src/queue/workers.ts` to remove unnecessary link URL parsing.
  - Cleaned up invented link-echo test payloads in `tests/queue/workers.test.ts`.
- **Execution-time skipTerminalState check (cross-owner coordination F10):**
  - `PlaneWritePath.apply` in `src/sync/plane.ts` inspects `write.skipTerminalState`.
  - When set, it strictly fails closed:
    - Fetches current issue state without swallowing errors; any GET error (such as Plane 503 or network issue) propagates so BullMQ retries the write.
    - If the current state ID is not in cached project states, refreshes the project state list from Plane once.
    - If the state ID remains unresolved, throws `UnknownPlaneState` rather than guessing or proceeding.
    - Only skips the write and records `skipped_terminal_state` audit if the confirmed current state group is `completed` or `cancelled`.
    - Only proceeds to PATCH after positively verifying the current state is not completed or cancelled.
  - Verified by CA's positive and negative-control test suite in `tests/a8/fixes-r3.test.ts`.
- **Cross-owner note for SA:**
  - `PLANE_SERVICE_USER_ID` should be made required in `src/config/env.ts` and in `deploy/git-sync.env.example` as echo dropping relies on it.
- **Cross-owner note for CB (`tests/mirror/service-plan.test.ts`):**
  - In `tests/mirror/service-plan.test.ts:100`, the test fixture passes `resumeReducer: (request) => handleMirroredIssue(ctx, request)`. To execute deferred `mirror_pending` continuation writes, `resumeReducer` should dispatch `mirror_pending` to `handlePendingMirroredIssue(ctx, request)` (matching production wiring in `src/app/main.ts:104`).

