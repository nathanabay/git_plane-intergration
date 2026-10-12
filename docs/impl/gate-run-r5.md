# Round 5 full gate run

Tested committed HEAD `ab32b13ec04273d5ed879326032795ece5728e52` on branch `seal`. All prescribed gates ran once, in the brief's order. Each oracle and the whole suite ran sequentially through `sh scripts/heavy.sh`; no heavy steps overlapped. Typecheck and stub scan then ran with their prescribed commands. HEAD and tracked product, test, oracle, deployment and fork files remained unchanged during the run.

- verify-a1-deploy: PASS
- verify-rules-contract: PASS
- verify-identity-contract: PASS
- verify-a3-schema: PASS
- verify-a2-ingress: PASS
- verify-a4-writepath: PASS
- verify-b3-config-api: FAIL — stale verifier fixture never certifies an installation ID, preventing mapping creation and cascading into dependent assertions.
- verify-a5-a7: PASS
- verify-b4-b8: PASS
- verify-wiring: PASS
- verify-fork-patch all: PASS
- Whole suite: FAIL — five stale fixture/assertion failures: two unresolved-mapping cases, a registration receipt, failed-create generation recovery, and the service mapping fixture.
- Typecheck: PASS
- Stub scan: PASS

## Failures

### verify-b3-config-api — stale oracle fixture

Command: `sh scripts/heavy.sh node scripts/verify-b3-config-api.mjs` (exit 1).

Key error lines from `$HOME/.cache/gitsync-gates/verify-b3-config-api.log`:

```text
FAIL: a workspace admin creates, lists, updates and deletes mappings in their workspace: Expected values to be strictly equal:
FAIL: cross-site writes are refused: missing or foreign Origin is 403, non-JSON is 415: Expected values to be strictly equal:
FAIL: the role is re-checked on every write: a demoted admin's next write is 403 (§8, no caching): Expected values to be strictly equal:
FAIL: rule sets are validated by the §7.5 engine before storage: invalid YAML is 422 with the reason, valid YAML is versioned: Expected values to be strictly equal:
FAIL: conflict policies default per §7.3 and reject unknown fields or policies: Expected values to be strictly equal:
```

Root cause: the fake verifier at `scripts/verify-b3-config-api.mjs:55` checks the project/repository and returns null at `:59`, but never invokes `check.onInstallationVerified`. The current API requires that certification at `src/ui/api.ts:156` and rejects an absent installation ID with 503 at `:162`. Thus the oracle's expected 201 at `scripts/verify-b3-config-api.mjs:84` cannot occur; `mappingId` remains unset, the mapping count stays zero, and subsequent mapping-dependent assertions cascade. The oracle logger truncates assertion messages at the first newline; the 503 cause is established by tracing this fixture into the API guard.

Suggested fix: update the successful fake-verifier branch to certify the intended installation, seed its matching workspace allow-list entry, and assert that mapping creation persists that installation. Keep the negative verifier and fail-closed tests intact.

Owner: **driver** (oracle). API context is **SB**'s round-4 surface; the observed failure is its stale driver-owned fixture.

### Whole suite — throttled installation lookup expectation

Command: `sh scripts/heavy.sh node scripts/run-tests.mjs 450 tests` (exit 1).

Key error: `not ok 293 - F8: a rate-limited 403 from the installation lookup fails the delivery so it retries`; `Missing expected rejection.` Diagnostic rerun reproduced this at `tests/github/review-r4-sc.test.ts:78`.

Root cause: `tests/github/review-r4-sc.test.ts:76` deliberately stores `installationId: null`. Round-5 F3 makes unresolved mappings ineligible: `src/app/mappings.ts:37` joins on the verified installation, audits refused mappings at `:43`, and filters them at `:47`. `handlePlaneIssue` gets no admitted mapping (`src/app/issues.ts:189`) and returns at `:195`, before installation lookup at `:202`. The fake throttled lookup is never called; this is an outdated admission assumption, not observed swallowing of a throttled response.

Suggested fix: make the NULL-mapping reducer case assert suppression and `installation_not_allowed`. Isolate the intended lookup/rate-limit classification test from mapping admission at a reachable helper/API boundary.

Owner: **SC** (declared round-4 test owner); **SA** owns the round-4 mapping-admission surface.

### Whole suite — missing-installation audit expectation

Command: same whole-suite command.

Key error: `not ok 294 - F8: a plain 403/404 means not installed: nothing is registered with installation 0, the skip is audited`; `audited github_not_installed`, actual false. Diagnostic rerun reproduced this at `tests/github/review-r4-sc.test.ts:92`.

Root cause: the fixture at `tests/github/review-r4-sc.test.ts:88` also stores a NULL installation. The same F3 mapping filter skips it and emits `installation_not_allowed` before the mocked 403/404 lookup or `notInstalledWriter` can run. Its expected downstream audit no longer describes this fixture's authorized execution path.

Suggested fix: assert the unresolved-mapping audit and zero writes here; cover permanent lookup classification separately from the unresolved-mapping guard.

Owner: **SC** (declared round-4 test owner); related mapping policy owner **SA**.

### Whole suite — registration receipt assertion

Command: same whole-suite command.

Key error: `not ok 709 - F1: durable acknowledgement does not poll or call an unavailable destination`. Diagnostic rerun at `tests/writers/review-r3.test.ts:36` showed:

```text
actual: { ok: true, registered: true, outboxId: 'write-…' }
expected: { ok: true }
```

Root cause: `src/operations/outbox.ts:295` now distinguishes durable registration from API completion by returning the registration flag and intent ID, supporting round-5 F9's audit semantics. The test deep-compares the entire receipt to its earlier `{ ok: true }` shape. It fails before reaching the independent latency and no-external-call assertions at `tests/writers/review-r3.test.ts:37` and `:38`.

Suggested fix: assert `ok`, `registered` and the durable `outboxId`, keeping the latency, untouched destination and pending-row assertions.

Owner: **CB** (round-4 outbox contract owner). This older test file is outside the explicit round-4 ownership row and requires driver assignment.

### Whole suite — failed-create replacement expectation

Command: same whole-suite command.

Key error: `not ok 715 - F2: terminal creation failure cancels the group, removes its barrier, and allows edit/re-opt-in`; expected `created`, actual `ignored`. Diagnostic rerun reproduced this at `tests/writers/review-r4-cb.test.ts:51`.

Root cause: the test still expects a fresh generation after terminal failure (comment at `tests/writers/review-r4-cb.test.ts:46`). Round-5 F2 intentionally restores the original failed workflow at `src/sync/mirror.ts:146` and returns null at `:147` until its saved result/old external identity is recovered. Without a confirmed orphan, re-opt-in must not report a newly registered create. The pending marker and original intents are revived instead.

Suggested fix: expect recovery/deferral, verify original root and step IDs remain unchanged, and execute recovery to prove a single partner rather than asserting a new generation.

Owner: **CB** (declared round-4 test owner); **CC** owns the generation-selection contract.

### Whole suite — running-service mapping fixture

Command: same whole-suite command.

Key error: `not ok 726 - F2/F6: the running service registers mirror and actor intents without waiting, preserving FIFO`; `actor rule never completed; successful writes: []`. Diagnostic rerun reproduced this at `tests/writers/service.test.ts:102`.

Root cause: the fixture inserts its mapping at `tests/writers/service.test.ts:67` without `installation_id` and does not seed `workspace_installations`, although its webhook uses installation 1 at `:85`. The F3 filter in `src/app/mappings.ts:37` and `:47` therefore excludes the mapping before mirroring or its actor rule can register any writes. The empty destination record is explained by admission refusal, not evidence of a FIFO or actor-token execution failure.

Suggested fix: seed installation 1 as authorized for `ws` and persist installation 1 on the mapping before starting the service. Retain the outage, actor-attribution and FIFO assertions.

Owner: **CB** (outbox/FIFO service test), with **SA** for the round-4 mapping authority contract. The service test file is outside the explicit round-4 row and needs driver assignment.

## Diagnostic reruns

Only the five failed tests were rerun once, sequentially through the heavy wrapper:

```sh
sh scripts/heavy.sh env NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 --test-name-pattern='^F1: durable acknowledgement|^F2: terminal creation failure|^F2/F6: the running service' tests/writers/review-r3.test.ts tests/writers/review-r4-cb.test.ts tests/writers/service.test.ts
sh scripts/heavy.sh env NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 --test-name-pattern='^F8: a rate-limited 403|^F8: a plain 403/404' tests/github/review-r4-sc.test.ts
```

The writer rerun returned 0 pass, 3 fail; the GitHub rerun returned 0 pass, 2 fail. Each reproduced its original failure, with zero cancellations. No flaky outcome was observed. The failing oracle was not rerun.

## Counts and validation

**12 pass, 2 fail across 14 prescribed gates.** The two failing gates comprise one oracle and the whole suite, not six separate gate failures. The suite reported five failing tests and zero cancellations; its wrapper does not print a total passing count on failure. Typecheck passed for 136 project files, and the stub scan passed for 144 files.

Typecheck command: `node scripts/typecheck.mjs "src/**/*.ts" "src/**/*.tsx" "tests/**/*.ts"`.

Stub-scan command: `node scripts/verify-no-stubs.mjs src tests`.

Only this report and its report-coverage ledger were written in the repository. No product, test or oracle fixes, staging, commits or pushes were performed. Other agents' existing metadata and review documents were left untouched.
