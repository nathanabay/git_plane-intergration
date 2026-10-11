# Round-1 fixes — implementer GA

Tests for assigned findings: `tests/parse/references.test.ts` (F1), `tests/smoke/live-smoke.test.ts` (F1), `tests/sync/plane.test.ts` (F13), `tests/sync/github.test.ts` (F13), `tests/db/ledgers.test.ts` (F16), `tests/reconcile/reconcile.test.ts` (F17).

## F1 A 403 from the identifier endpoint treated as unknown/inaccessible
- `src/parse/references.ts`: `resolveReferences` catches `PlaneApiError` and treats status 403 (inaccessible or unknown project, e.g. `JIRA-12` or private project outside service account scope) identically to 404 (non-existent issue sequence in known project). It records the reference as unknown and populates `statuses[r.identifier] = err.status` rather than throwing. Network errors and 5xx errors continue to throw so BullMQ retries transient outages. (SA similarly handles 403 in `src/app/context.ts` `issueResolver`).
- `tests/parse/references.test.ts`: Added test `"F1: resolveReferences treats 403 like 404; one ref answers 403 and the other still links"`.
- `tests/smoke/live-smoke.test.ts`: Updated assertion for unknown project `ZZZZ-999999` to expect 403 (measured on real Plane v1.4.2), and added check for unknown sequence in the known project expecting 404.

## F13 Create-type writes record echo op with in-flight marker
- `src/sync/plane.ts`: `create_issue` and `add_comment` record an in-flight pending marker via `markCreatePending` before dispatching the POST request (`pendingCreateHash(projectId)` for issue creation and `pendingCommentHash(issueId)` for comments). In a `finally` block, `clearCreatePending` removes the marker. Upon receiving the response id, `#recordCreated` records the `created` op in `applied_ops`.
- `src/sync/github.ts`: `create_issue` sets an in-flight pending marker using `pendingGithubCreateHash(repoId)` before the POST request and clears it in `finally`. After receiving the created issue number, it records the `created` op and individual `label:<name>` ops for all initial labels in `applied_ops` before returning.
- `src/db/ledgers.ts`: Added `markCreatePending`, `clearCreatePending`, and `createPending` using `applied_ops` with `PENDING_TTL_SECONDS = 30`.
- Tests: Added `"write: create_issue and add_comment mark create pending during in-flight request and bind id afterwards (F13)"` in `tests/sync/plane.test.ts` and `"write: create_issue records created and initial label ops, and marks pending in-flight (F13)"` in `tests/sync/github.test.ts`.

## F16 Commit claim key (sha, workspace_slug) [DB half]
- `src/db/migrations/004-commit-workspace-retention.sql`: Adds `workspace_slug TEXT NOT NULL DEFAULT ''` to `processed_commits`, drops single-column primary key, and sets primary key to `(sha, workspace_slug)`. This allows a repository mapped into multiple Plane workspaces to execute Smart Commits once per workspace, while fork or branch re-deliveries of the same SHA to the same workspace deduplicate.
- `src/db/ledgers.ts`: Updated `claimCommit(db, sha, repoId, workspaceSlug = "")` and `releaseCommit(db, sha, workspaceSlug = "")` with `workspaceSlug` parameter defaulting to `""`, preserving backward compatibility for legacy callers and the A3 schema oracle.
- Caller: `src/github/smart-commits.ts` (`processPush`) passes `slug` as the fourth argument to `claimCommit`.
- Tests: Added `"db: claimCommit per (sha, workspace_slug) and releaseCommit (F16)"` in `tests/db/ledgers.test.ts`, asserting that the same SHA claims in different workspaces, duplicate pushes in the same workspace return false, and releasing one workspace allows re-claiming only that workspace. SB covers end-to-end Smart Commit deduplication in `tests/github/smart-commits.test.ts`.

## F17 Retention settings and idempotency ledger pruning
- `src/db/migrations/004-commit-workspace-retention.sql`: Adds `delivery_retention_days INT NOT NULL DEFAULT 30`, `commit_retention_days INT NOT NULL DEFAULT 180`, and `audit_payload_retention_days INT NOT NULL DEFAULT 90` to `instance_settings`. Adds indexes `idx_webhook_deliveries_received` on `webhook_deliveries(received_at)` and `idx_processed_commits_processed` on `processed_commits(processed_at)`.
- `src/db/ledgers.ts`: Implemented `readRetention(db)` reading `instance_settings` (with default fallbacks 30, 180, 90) and `pruneLedgers(db, retention)` which removes old `webhook_deliveries` and `processed_commits`, and strips `'payload'` from old `audit_log.detail` JSONB (`detail = detail - 'payload'`) while keeping audit metadata intact.
- `src/queue/cron.ts`: Added `prune-ledgers` scheduled job in `startMaintenance` alongside `reconcile` and `prune-ops`. Each run calls `readRetention(db)` dynamically so changes to `instance_settings` apply without service restart.
- Tests: Added `"F17: readRetention returns default settings and respects instance_settings updates"` and `"F17: pruneLedgers prunes webhook_deliveries, processed_commits, and strips audit_log payload"` in `tests/reconcile/reconcile.test.ts`.
