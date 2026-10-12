# Fix round 6 — CB

Completed F2 registration/Smart Commit admission, F3, and the three assigned writer fixtures. Only CB-owned files and the required CB records were written. No staging, commits, pushes, or forbidden checks.

## F2 — frozen source authority at registration

- `src/operations/plans.ts:12` defines `WriteAuthority` with the agreed workspace, mapping ID, repository and installation. Plans accept `authority` at `:26`; reducer continuations carry it at `:43`. `DeliveryContext.authority` supplies the mapping scope.
- `src/operations/outbox.ts:191` copies and validates authority from an explicitly stamped write, plan options, delivery scope or retained group. Single writes capture it before asynchronous actor lookup (`:271`); plans snapshot their supplied authority before asynchronous work and stamp every step (`:349`). First insertion wins; re-registration never updates the stored authority.
- Authority metadata is excluded from single-write identity (`src/operations/outbox.ts:95`) and anonymous-plan identities, including stamped target metadata. Thus a changed caller mapping finds the original intent rather than replacing its authority with a new row.
- The authorizer receives the stored `_authority`. Remote API dispatch strips it (`src/operations/outbox.ts:548`); local resumes receive the frozen snapshot (`:594`) for nested registrations. Older writes without the field retain legacy authorization.
- `src/github/smart-commits.ts:285` admits commands under the supplied or mapping-scope authority, rejects repository/workspace mismatch and snapshots it before lookups. Each command registration enters that scope (`:372`). Completion claims remain once-only markers, separate from authority.
- Proof: `tests/writers/review-r6-cb.test.ts:14` drives the actual push/inbound reducer with the production authorizer. During the second key lookup it executes the first command before any SHA claim, then throws a transient error. Retry preserves the first successful command and registers/applies the second once. `:56` proves changed mappings cannot replace or rescue frozen authority. `:82` covers mixed destination queues, group inheritance and nested resumes. `:126` covers mismatched admission. `:141` proves named-label target metadata cannot change the original plan IDs or authority.

## F3 — same-workspace multi-project ownership

- `src/operations/outbox.ts:185` infers distinct authorized workspace slugs, rather than counting project mapping rows. Ownership is still inferred only at registration; unresolved rows remain unresolved at execution/retry.
- Proof: `tests/writers/review-r6-cb.test.ts:167` seeds two project mappings for one repo/installation/workspace, verifies fallback inference and dispatches a real PR linkback through the production authorizer. `:195` covers multiple distinct workspace results and unknown ownership, including mapping changes after registration.

## Writer fixture repairs

- `tests/writers/review-r3.test.ts:36`: round-5 F9 introduced registration receipts. The fixture now verifies `ok`, `registered` and the exact persisted outbox ID, retaining the latency, zero remote writes and pending-row assertions.
- `tests/writers/review-r4-cb.test.ts:21`: round-5 F2 intentionally recovers failed creates rather than selecting replacements. The fixture now verifies unchanged root/step IDs, restored pending work and marker, execution to exactly one active partner, marker removal and no second create on duplicate opt-in.
- `tests/writers/service.test.ts:68`: round-5 F3 disabled unresolved mappings. The fixture now seeds the matching allow-list and verified mapping installation. A repeat run also exposed its cold-path heartbeat timing assumption. At `:95` the fixture proves inbound registration completes while Plane remains unavailable, asserts two pending intents and an actual refused HTTP write, then keeps the original one-second unrelated-delivery limit before releasing the outage. FIFO, actor token, completed jobs and secret-absence assertions remain intact.

## F5 integration support

- CA's later-event retention uses `OutboxPlanOptions.holdOnFailure` (`src/operations/plans.ts:30`). `src/operations/outbox.ts:373` admits opted-in continuations behind a failed root and stores the new intents as failed (`:398`), without reviving remote writes or recreating the pending marker. Explicit repair revives the original group in order.
- Proof: `tests/writers/review-r6-cb.test.ts:221` verifies held approved/merged continuations, no implicit retry, original opened-before-approved-before-merged order, and once-only completion after repair. The actual CA F5 reducer/replay/Retry test also passed in the shared capped run.

## Verification and driver relays

- Final scoped typecheck: **passed, 56 project files**, including transitive dependencies. Command: `node scripts/typecheck.mjs src/operations/outbox.ts src/operations/plans.ts src/github/smart-commits.ts tests/writers/review-r3.test.ts tests/writers/review-r4-cb.test.ts tests/writers/service.test.ts tests/writers/review-r6-cb.test.ts`.
- Final capped run of `tests/writers/review-r6-cb.test.ts tests/writers/service.test.ts`: **9/9 passed**, including all eight final CB regressions and the controlled service fixture.
- Shared capped CB/CA/CD run: **15/15 passed**. This preceded strengthening the CB push test to actual inbound reduction and adding the named-label identity regression; both stronger cases passed in the final run.
- Assigned three-file writer run initially passed **17/17**. A subsequent run passed all **16** review-r3/review-r4 tests but exposed the service heartbeat timing issue above; the repaired service fixture passed both its isolated run and the final two-file run. No latency bound was relaxed.
- All test commands used `NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000` with at most three files. No oracles, heavy.sh, gate-check, or whole suite ran. Automatic ledger evidence remains for the driver's permitted verification.
- Driver's push mapping scope is present and exercised. CA's writer contexts propagate explicit frozen authority through mirror/PR continuations. Relayed the optional scope propagation change in unowned `src/app/writers.ts`: copy `request.authority` into the resume scope.
- **Driver fixture follow-up:** unowned `tests/github/review-r5-cb.test.ts:222` still expects two same-workspace project mappings to be ambiguous. That assertion must now expect stored workspace `ws` and successful dispatch; its unknown/unlisted controls should remain. The new F3 regressions provide the replacement positive and negative coverage.
- Relayed the unowned `src/app/main.ts` orphan-linkback registration: stamp `freezeMappingAuthority(mapping)` to include that repository comment in the shared contract.
