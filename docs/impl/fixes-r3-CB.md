# Round 3 fixes — CB

## F1

Events received during mirror creation now register `mirror_pending` continuations (`src/sync/mirror.ts:76`). They reference the existing create result and join its original target and retention group, behind the latest workflow step. The marker stays present after the sync link appears, until the original rule continuation and later event callbacks have registered their writes. This prevents an older deferred edit from overwriting a newer event that sees the link first. Registration and marker cleanup share the original target's transaction lock; registration restores a marker if the earlier workflow removed it after lookup.

SA's production `handlePendingMirroredIssue` and main dispatch implement the exported contract. GitHub callbacks run normal field sync without `createContinuation`, then the original rule for the one new target using `actorTokenFor`. The original inbound handler skips these deferred rules. Plane callbacks authorize the original workspace and selected mapping, then run field/comment sync without `createContinuation`; they leave rules to the original Plane delivery. Both inbound directions pass the original job to the mirror. The callback scope restores the original write delivery identity and trusted workspace metadata; no PAT is persisted with the event.

`src/operations/outbox.ts:165` now acknowledges a committed intent immediately. It does not poll completion or invoke the destination API from the inbound reducer. Redis carries wake-ups; its loss cannot discard the committed intent, and recovery restores missing wake-ups. The synchronous completion loop and timeout/error contract were removed from `src/app/writers.ts`.

Result-dependent work is serialized in durable plans (`src/operations/plans.ts`, `src/operations/outbox.ts:206`). Registration reserves every write step, result binding, predecessor and database follow-up in one transaction. Execution resolves earlier results only after their predecessor completes. It checkpoints the actual API result before database follow-ups; completion, sync-link registration and associated audit changes commit together. A failed link transaction therefore retries its database work using the saved create result, without creating another item. No follow-up relies on an in-memory reducer closure. Plans accept at most 256 steps; recovery scans at most 100 metadata rows and loads one intent payload at a time. Dependency reads select completion fields, avoiding repeated reads of large descriptions.

Production consumers now use these contracts:

- Mirror creates and label changes in `src/sync/mirror.ts` use plans for label IDs, creates, sync links, cross-link comments and audits. The original GitHub issue rule continues for the new target in a durable `mirror_created` step.
- Rule label-name mutations register the upsert and current-field mutation in one ordered plan. The executor reads fields under the target lock; inbound rules never wait for a label ID.
- `src/sync/dev-info.ts:108` submits `upsertRollup` intents. The executor resolves/stores link IDs and recovers deleted or duplicate links at execution time.
- Smart Commits record a step once its write is durably registered, as permitted by F1's Fix. The outbox guarantees execution or an audited terminal failure.
- `src/operations/tooling.ts:83` gives replay a fresh transport ID and carries the original `writeDeliveryId`. Replay-of-replay preserves it too. Continuations restore that same original delivery scope, so a replay that takes the ordinary rule path reuses the continuation's write IDs.

Cross-owner integration was relayed through the driver and is present in the shared tree: SA exposes plan/upsertRollup methods in AppContext, forwards `github.plan` through the assignee wrapper, wires the link reader and dispatches PR/mirror continuations; GB submits label-name mutations; SB scopes each Smart Commit step by its existing `sc:<sha>:<step>` operation ID; CA scopes replay by `job.writeDeliveryId ?? job.deliveryId`; GA persists that metadata in inbound audits and supplies the pending-link migration and retention protection. SA skips the original inbound rule when a mirror create has a continuation, preventing a fast worker from making the original rule run twice.

The stable public API is exported from `src/app/writers.ts`:

```ts
// Same PlanWriter on plane.plan and github.plan:
(key: string | undefined, steps: OutboxPlanStep[], opts?: OutboxPlanOptions)
  => Promise<{ ok: true }>;
// opts: { actorToken?, pendingLink?: Record<string, unknown>, target?: {slug, projectId, issueId},
//         groupRoot?:string, bindings?:Record<string,string>, predecessor?:string,
//         pendingMarker?:{key:string,root:string,link:Record<string,unknown>} }
// Steps:
// {kind:"write", side:"plane"|"github", write:object, bind?:string}
// {kind:"sync_link", link:<upsertSyncLink argument with result references>}
// {kind:"audit", entry:<appendAudit argument with result references>}
// {kind:"dev_info", issueId:string, key:string, linkId:string|ResultReference}
// {kind:"clear_pending_link", key:string}
// Helpers: resultRef("created.id"), resultRef("created.number")
//          resultText("prefix", resultRef("created.id"), "suffix")
```

A reducer continuation is a write step with `kind:"resume_reducer"` and `continuation:{kind:"pr_created"|"mirror_created"|"mirror_pending", workspaceSlug?, job, mappingId, projectId, issueId, identifier}`. Its issue ID can be a result reference in the plan. The outbox dependency `resumeReducer(request)` calls a target-specific reducer, never replays the entire original reducer. SA wires `handleCreatedPr`, `handleMirroredIssue` and `handlePendingMirroredIssue` in main.

Tests: `tests/writers/service.test.ts` boots the real service with PostgreSQL, Valkey, signed webhooks and a Plane write API outage. An unrelated GitHub `check_run` finishes in under one second while the service/actor writes retain FIFO. `tests/writers/review-r3.test.ts` checks immediate registration, both mirror directions and checkpointed link recovery. `tests/mirror/service-plan.test.ts` exercises the real assignee wrapper and original issue rule, recovery, replay, fast-worker timing, deferred edits before/after link creation and comments in both directions. The pending-edit regression failed before this extension because no edit intent was registered (`0 !== 1`). `tests/dev-info/outbox.test.ts` checks queued link-ID persistence/deletion recovery. `tests/operations/replay-outbox.test.ts` failed with five intents before CA's scope wiring and passes with two afterward, with each comment applied once.

## F2

Mirror plans use object keys independent of transport delivery: `create:gh:<workspace>:<repoId>#<number>:<projectId>` and `create:plane:<workspace>:<projectId>:<issueId>:<repoId>` (`src/sync/mirror.ts:284`, `:467`). SA's PR `-NEW` plans use `create:pr:<workspace>:<repoId>#<number>:<projectId>`.

The first plan intent and `pending_sync_links` identity marker commit atomically with the rest of the plan. A conflicting registration reuses the existing plan, including when its first step already applied or a later delivery contains different fields/labels. It cannot append a second create or mutate the original plan. A later source event registers a separate continuation in the same ordering group. The marker is deleted only after no other pending workflow steps remain; installing the link alone does not release the event barrier. Creates reserve object/intent targets rather than a project's entire issue collection.

Tests: the opened/labeled pending-create regression in `tests/writers/review-r3.test.ts` checks one item, its actual labels, one active link, both cross-link comments and one completed audit after recovery. `tests/writers/postgres-order.test.ts` concurrently registers the same create from independent PostgreSQL pools and checks one intent/marker/API create and a deferred event whose marker was cleared after lookup: registration restores the marker, preserves the create result and clears it after the callback. SA's `tests/app/pr-new-plan.test.ts` covers the PR continuation. A negative control that restores delivery-scoped plan/marker keys reproduces two creates (`2 !== 1`).

## F3

`src/operations/outbox.ts:86` includes a content occurrence ordinal in write identity. The counter is keyed by normalized content, destination and actor within the original delivery scope; another target or different write cannot steal its position. Equal content repeated after an intervening write gets a distinct ordinal. Retrying the same traversal reproduces the same IDs. Smart Commit steps supply their explicit stable operation ID, so skipping an earlier completed identical command cannot collapse a later command.

The optional `skipTerminalState` flag remains content in the intent and job. The executor strips only the private plan metadata and preserves the flag when it calls the real write path.

Tests: `tests/writers/review-r3.test.ts` checks three A→B→A intents, identical retry keys, head-only wakes and the final A state. `tests/writers/smart-commit.test.ts` drives a real three-commit push and verifies three registrations/claims and A→B→A API execution. `tests/writers/compound.test.ts` checks add-label→remove-label→add-label without synchronous ID reads. The guard regression distinguishes flagged/unflagged IDs and checks persistence, recovery and executor input. Removing the ordinal in a negative control makes the A→B→A regression fail.

## F6

`src/operations/outbox.ts:345` reloads the actor PAT at execution. A removed/revoked token uses the service identity and records `identity_fallback` with `reason:"token_revoked"`, actor ID, outbox ID, delivery and workspace. Retries deduplicate that audit. Neither the intent nor Redis stores a PAT, and a checkpointed write is not reattributed during a database-follow-up retry.

`tests/writers/outbox.test.ts` verifies current-PAT loading, credential absence from durable/queue data, same-target FIFO, service fallback and one audit with the exact reason. Restoring the previous revoked-token 403 in a negative control makes this test fail; the write would be dropped.

The cross-owner F11 cap is also implemented in this outbox: `maxAttempts` defaults to 10 and `maxTargetBlockDurationMs` to 1,200,000. The first retry timestamp lives in durable error JSON. Backoff is clipped to that deadline; expiry fails/audits the intent and wakes its successor without another API call. Only eligible target heads hold wake-ups, including in recovery; completion/failure wakes the next head/dependent. `tests/writers/recovery.test.ts` proves bounded recovery, attempt and time caps, successor progress and unrelated creates in the same project. GA owns the HTTP request token bucket and worker-side handling.

All source/test edits stayed inside CB's OWNS. Negative controls used private copies and were removed. Final G0–G5 acceptance is recorded by the real checker in `docs/impl/agent-gates/fix-r3-cb.GATES.md`; heavy oracles and the whole suite use `scripts/heavy.sh`. No staging or committing was performed. No spec disagreement or unimplemented CB remainder is declared.
