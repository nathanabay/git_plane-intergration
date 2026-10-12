# Round 5 CC — F1 and F2

## F1 — replay reaches failed create-plan tails

`src/operations/tooling.ts:144` binds the original source/delivery identity to registered create workflow roots through durable `outbound_writes.delivery_id` and `_plan.root`, scoped to the audited workspace. `replayDelivery` restores those roots before enqueueing the original event (`:180`), so mirror active-link and PR created-audit shortcuts cannot strand their failed tails.

`restoreCreateWorkflow` (`src/operations/tooling.ts:83`) transactionally resets only failed steps, preserves immutable write contents and saved API results, restores the original pending marker, and rejects conflicting newer barriers or an unresolved create with an existing active partner. Production uses a dedicated connection and the outbox execution/registration locks. Regular outbox recovery supplies queue wake-ups.

`src/sync/mirror.ts:93` recognizes a continuation already bound to the original delivery, including replay, and avoids registering a second event continuation. The corresponding guard was sent to the driver for CA's ownership of `src/app/pr.ts`; CA implemented it in `deferPendingPr`. CC did not edit that file.

Proof: `tests/mirror/review-r5-cc.test.ts:64` runs audited UI replay through the real mirror reducer after the GitHub cross-link fails. It verifies successful steps/results remain unchanged, one partner and one cross-link exist, the original rule continuation runs exactly once, and repeated replay adds no successful effects. The real PR reducer test at `:88` repairs a failed continuation after its link/created audit committed and verifies the original rule and rollup complete once. The conflict/rollback test is at `:189`.

## F2 — ambiguous creates retain their identity

`src/sync/mirror.ts:111` separates recovery from replacement. Without a confirmed orphan matching the saved create result (`:131`), a failed workflow is restored under its original root (`:146`) and generation selection defers. The executor then uses the existing result checkpoint or Plane's old external-id lookup; unavailable recovery never grants a new create identity. A confirmed orphan can advance even when its old tail failed. Generation discovery also recognizes retained root marker metadata. If terminal workflow rows were pruned but their failure audit remains, selection defers (`:125`) instead of inventing a new identity.

Proof: the mirror and PR cases at `tests/mirror/review-r5-cc.test.ts:103` let a real Plane POST commit, discard its response, make external-id recovery unavailable until terminal outbox failure, then re-opt-in and explicitly replay. Every recovery lookup uses the original create intent; only one POST/partner exists after recovery. A fresh PR event may append its own ordered continuation to that same root. `:156` proves saved-result recovery after local link failure. `:174` proves a missing local link alone cannot authorize replacement and actual reconciliation orphaning can. `:202` covers confirmed orphan replacement after a failed tail; `:214` covers retention safety.

## Validation and scope

- `node scripts/typecheck.mjs src/sync/mirror.ts src/operations/tooling.ts tests/mirror/review-r5-cc.test.ts` — passed, 43 imported project files checked.
- Final `NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/mirror/review-r5-cc.test.ts` — 9 passed, 0 failed.
- The capped three-file regression run also passed all 11 round-4 mirror tests and all 16 tooling tests. Its sole round-5 failure was the overly strict row-count assertion for CA's fresh-event fence, corrected and covered by the final 9/9 run.
- Only CC-owned source/test paths and the explicitly requested CC ledger/report were written. No existing test needed an ownership-external edit. No staging, commits, pushes, or prohibited checks were performed.

The ledger has three direct checks verified and no deferred implementation work. Formal gate-check evidence and the broader driver gates remain driver-owned, as requested. Network behavior uses in-process fakes with the real write paths/reducers; production advisory-lock concurrency was inspected, not exercised against the live database. Already-pruned failed workflows fail closed/defer; their lost immutable data is not reconstructed as a new intent.
