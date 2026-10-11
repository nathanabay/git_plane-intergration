# Round 4 fixes — CB

## F2

`src/operations/outbox.ts:374` cancels all pending siblings of a terminally failed plan, removes its `pending_sync_links` barrier and writes one `mirror_create_failed` audit. Production performs these changes and the failed head update in one transaction. Applied siblings and saved API results survive. Cancellation wakes successors on affected targets, with bounded metadata reads.

Plan registration (`:261`) rejects joining a failed group, covering a marker lookup that raced with failure. It serializes generations on the stable pending-marker key, refuses replacing a live different generation and removes pre-upgrade failed markers before reserving a new generation. `src/operations/plans.ts:41` persists marker metadata for explicit recovery. Existing round-3 plans recover their marker key/link from their serialized database follow-ups.

CC owns the mirror query guard and generation-key selection. Those changes are present: a failed marker is ignored before link lookup; re-opt-in can register a fresh generation. CB keeps the caller's generation key unchanged. The production plan returns `{ok:true,inserted:boolean}`; the `PlanWriter` declaration retains an optional `inserted` field for legacy adapters. CC/SC use that result when deciding which continuation owns the original rule.

Proof in `tests/writers/review-r4-cb.test.ts`: terminal create failure cancels siblings and audits once; a late continuation is refused; an edit is not deferred; a re-opt-in replaces a deliberately restored stale failed marker. The transaction test injects an audit-write error and proves that head/siblings remain pending and the marker remains until cleanup and audit can commit together.

## F3

`src/operations/outbox.ts:170` resets failed intents only for explicit replay registration or the authorized retry operation. Replay requires nonempty `scope.writeDeliveryId` and `scope.transportDeliveryId` with different values; the original source-prefixed `deliveryId` still determines write identity. Ordinary retries and duplicate deliveries leave terminal rows unchanged. Reset clears attempts/error/retry time, preserves successful steps and API checkpoints, restores the plan barrier and wakes eligible work. A failed tail is reset even when its plan root is already applied.

`src/operations/outbox.ts:346` exposes `retryFailed(id,workspaceSlug) => {ok:true,retried:boolean}`. Unknown/foreign IDs return an `OperationError` 404; a newer pending generation or an already active replacement partner causes 409. Applied work is not re-executed. A successful manual reset is audited as `outbound_write_retry`. Default retries are thirty attempts with a six-hour window (`:127`), replacing ten attempts/twenty minutes; a one-hour upgrade remains retriable. Explicit configured bounds remain supported.

The driver supplied the two unowned scope changes in `src/app/reducers.ts` and `src/app/writers.ts`: internal `job.writeDeliveryId` and `transportDeliveryId:job.deliveryId` are carried into registration and continuation scopes. SA wires production `ordered.retryFailed` through `composeRoutes`; SB supplies the workspace-admin `POST /workspaces/:slug/outbound-writes/:id/retry`. These changes were requested through the driver and are present; CB did not edit those files.

Proof in `tests/writers/review-r4-cb.test.ts`: ordinary registration does not revive a failed row; explicit replay executes the write once; subsequent replay adds nothing; replay resets an applied-root/failed-tail plan without another create; a failed root itself can be replayed; retrying a superseded generation is refused both while its replacement is pending and after it has linked; a one-hour outage stays pending; manual retry enforces workspace scope and audits once.

## F10

`src/operations/outbox.ts:481` handles actor-token 401 and non-rate-limit 403 by invalidating the stored Plane PAT, auditing `identity_fallback` with `reason:"token_rejected"`, then retrying the same intent with service identity. Invalidation deletes only `plane_pat`, preserving GitHub OAuth. It compares the captured ciphertext so an independently rotated credential is preserved. The audit makes service fallback durable across worker retries/restarts; no PAT is stored in intents, queue data or audit detail. Rate-limit 403s retain the actor credential and remain retriable.

The same wrapper covers direct writes, compound issue mutations and rollup link writes. Every Plane execution receives the immutable `opts.intentId`, including the service retry; CA uses it for ambiguous-create recovery and preserves error response headers so rate limits can be distinguished in production. CA's changes are present and were relayed through the driver.

Proof in `tests/writers/review-r4-cb.test.ts`: actor 401 and 403 each invalidate only the PAT, attempt the service write, survive a service outage and worker restart, then apply with exactly one `token_rejected` audit. The actor attempt, immediate service retry and restarted-worker create all receive the same intent ID. Rate-limit tests use CA's actual `PlaneApiError(403, body, message, headers)` with either `retry-after` or `x-ratelimit-remaining:"0"`; each leaves the token intact and records no fallback.

## Verification

Round-4 verification uses only targeted tests and targeted typecheck. The lightweight ledger is `docs/impl/agent-gates/fix-r4-cb.GATES.md`; its evidence is recorded from direct command runs as this round permits. No oracle, heavy wrapper, gate checker or whole suite was run. No staging, commit or push was performed.

An extra sequential batch covering older writer files was interrupted after its first FIFO regression passed. Node reported pending-promise cancellation for the remaining files, without assertion failures; it is not counted as successful verification. The driver was notified. The new round-4 test file and typecheck are verified separately after the final implementation edits.
