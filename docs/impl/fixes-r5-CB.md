# Fix round 5 — CB

F9 and F11 fixed. Only CB-owned implementation/test files and this round's required CB records were written. No staging, commits or pushes.

## F9 — Smart Commit recovery and workspace Retry

- `src/operations/outbox.ts:262` stores SHA/step ownership alongside the immutable write without changing existing intent hashes. `src/operations/outbox.ts:413` revives only failed rows in the requested workspace, using SHA ownership or the original delivery for older untagged intents. Successful rows and saved results remain intact.
- `src/github/smart-commits.ts:343` invokes this recovery on explicit replay before the claimed-SHA/completed-command shortcuts. Fresh deliveries still honor the once-only SHA claim.
- `src/operations/outbox.ts:295` returns a registration receipt; `src/github/smart-commits.ts:368` audits durable acceptance as `registered`, with the outbox ID. Actual worker completion emits `smart_commit_step_executed`/`applied` at `src/operations/outbox.ts:645`.
- `src/ui/client/Workspace.tsx:669` exposes Retry on failed-write audit entries, disables it while busy or scheduled, and displays errors through the existing saver. The button at `src/ui/client/Workspace.tsx:699` calls the workspace-scoped endpoint through `src/ui/client/http.ts:23`; `src/ui/client/http.ts:17` selects valid failed-write IDs.
- Proof: `tests/github/review-r5-cb.test.ts:16` exercises the real push reducer, replay tooling, claimed SHA, successful transition sibling, terminal comment failure, repeat replay, and SHA/workspace isolation. `:63` proves pre-round-5 untagged recovery. `:79` compiles the actual Retry component, clicks its handler against the real API/outbox, verifies successful execution, and checks member, foreign-workspace and CSRF rejection.

## F11 — throttled readiness

- `src/github/pr-automation.ts:299` recognizes retry-after and exhausted-quota 403s before the permanent-unavailable branch, rethrowing the original error and its headers. Ordinary 403/404 permission/missing-resource failures still fail closed and audit unavailability.
- Proof: `tests/github/review-r5-cb.test.ts:130` drives the final successful status event through the real reducer: both throttling forms reject without writes or permission-error audit, then the same signal fires readiness on recovery. `:153` verifies permanent 403/404 and unchanged throttling errors.

## Agreed F3 outbox seam

- Added the driver/CD `authoriseWrite(side, storedWrite, workspaceSlug)` dependency. `src/operations/outbox.ts:505` invokes it before resolving or dispatching the stored template, including reducer resumes. `src/operations/outbox.ts:189` authorizes every failed group member before retry/reset, covering `retryFailed`, Smart Commit replay and outbox-plan replay. Refusals remain failed, record an authority-refused audit, and are terminal even when the callback throws a generic error or 503. The reset transaction commits the refusal audit before propagating the error.
- `src/operations/outbox.ts:180` infers a missing GitHub workspace only during registration, from exactly one matching repo/installation mapping joined to that workspace's allow-list. Ambiguous, unknown and unlisted matches remain NULL. Execution/retry never infer ownership. Existing stored ownership is preserved across re-registration.
- Proof: `tests/github/review-r5-cb.test.ts:170` checks stored marker/root/continuation metadata, terminal execution/retry/replay refusal and refusal before resume resolution. `:207` checks missing workspace and terminal classification. `:222` verifies unique, ambiguous, unknown and unlisted registration, and that later mapping changes cannot repair NULL ownership at execution.
- Driver relay: CC's `restoreCreateWorkflow` in `src/operations/tooling.ts` restores failed workflows directly with SQL. It must use the agreed authorization contract before that reset; this is outside CB ownership. Outbox execution independently refuses unauthorized dispatch.

## Checks

- Final scoped typecheck passed: 60 project files including transitive dependencies.
- Final capped run of `tests/github/review-r5-cb.test.ts`: **8/8 passed**, zero failures.
- Earlier capped two-file run of the seven then-present CB regressions plus `tests/github/smart-commits.test.ts`: **51/51 passed**, zero failures. The final run separately verifies the subsequently added registration-inference case.
- Commands used: `node scripts/typecheck.mjs src/operations/outbox.ts src/operations/plans.ts src/github/smart-commits.ts src/github/pr-automation.ts src/ui/client/Workspace.tsx src/ui/client/http.ts tests/github/review-r5-cb.test.ts`; tests used `NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000` with at most three files.
- An initial three-file regression probe also identified three stale round-4 expectations, relayed to the driver: `tests/github/review-r4-sc.test.ts:72` and `:84` expect unresolved NULL-installation mappings to reach installation lookup; CD's F3 fix disables them. `tests/writers/review-r4-cb.test.ts:21` expects a replacement generation after failed creation; CC's F2 fix retains original ambiguous-create identity. These files were not edited.
- No oracles, heavy.sh, gate-check or whole suite were run. The CB gate ledger retains pending automatic evidence for the driver's permitted verification; direct check results are recorded here.
