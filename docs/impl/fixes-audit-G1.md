# G1 documentation audit fixes

Owns: src/github/errors.ts, src/sync/backoff.ts, src/sync/github.ts, src/queue/index.ts, src/queue/workers.ts, src/operations/outbox.ts, src/operations/plans.ts, tests/queue/audit-g1.test.ts, this report.

Acceptance before implementation:

- [x] G2: classify primary and secondary limits, preserve permission errors, and use a minute-based exponential fallback.
- [x] G3: preserve complete server deadlines and release workers instead of sleeping.
- [x] G4: delay inbound jobs and outbox reads at the required deadline, including cross-job installation throttling.
- [x] G13: confirm accessible issue label absence before treating removal 404 as success.
- [x] P4: identify duplicate Plane comment deliveries without confusing subsequent edits or explicit replay.
- [x] Regression tests written; only the allowed scoped typecheck run; no tests run, staging, commits, pushes, or edits outside ownership.

G1 implemented all five assigned findings. The regression file is `tests/queue/audit-g1.test.ts`; its 11 tests were written and typechecked, **not executed**. Functional test execution belongs to the driver. No source change was deferred within G1's ownership. `src/operations/plans.ts` needed no change and remains untouched by G1.

## G2 — primary and secondary limit classification

- `src/github/errors.ts:40` implements the agreed `classifyGithubError(err)` contract, with optional clock/attempt arguments for deterministic scheduling. It reads status, normalized header names/values, the top-level error message and GitHub's response-body message. A message-only secondary 403 is rate limited; ordinary 403 remains permission failure; 404, transient failures and permanent failures remain distinct.
- Headerless limits start at 60 seconds and grow exponentially, with a one-hour fallback ceiling and explicit retry budgets. Durable queue/outbox attempt counts keep that progression after a process restart. Waiting on an already established cooldown does not spend a request attempt.
- `src/queue/workers.ts:254` uses the classifier for permanent-write decisions; `src/sync/github.ts:58` stops retrying inside the inline write path. Deferred rejected writes clear their echo markers.
- Regression coverage: **“G2: message-only secondary 403 is retriable; permission and not-found remain distinct”**, **“G2/G3: long, mixed-case and numeric headers preserve all server deadlines”**, **“G4: inbound and raw outbound reads move to delayed, with bounded exponential secondary retries”**, and **“G2/G3: a GitHub write clears echo markers and defers instead of sleeping/retrying.”** Response-body-only identification is explicitly asserted.
- Context7 fetched with `npx ctx7@latest docs /websites/github_en_rest "Exceeding primary and secondary rate limits retry-after x-ratelimit-reset wait at least one minute"`: [GitHub rate-limit behavior](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api). The docs identify secondary errors by message and require a minute minimum when neither retry-after nor an exhausted-quota reset supplies the wait.

## G3 — full deadlines, deferred execution

- `src/sync/backoff.ts:16` removes the five-minute cap from retry-after seconds/dates and reset timestamps. Header deadlines are honored in full. The generic Plane/network fallback remains available; the GitHub classifier supplies its minute-based fallback.
- `src/github/errors.ts:9` carries the absolute epoch-ms deadline in `GithubRateLimitError`; `src/sync/github.ts:65` uses the request wrapper rather than sleeping. The old optional constructor `sleep` argument is accepted for source compatibility but never used for rate limits.
- `src/queue/workers.ts:49` moves jobs to BullMQ delayed at the exact deadline and throws `DelayedError`, releasing the worker. `src/operations/outbox.ts:87` gives ordering deferrals an optional absolute deadline. `src/operations/outbox.ts:462` persists `retry_at` without clipping it to a generic backoff. Outbox execution releases target locks/connections before the worker defers its wake-up.
- If the configured maximum retry lifetime/attempt budget is exhausted, existing terminal-failure behavior remains; it never sends an early request to work around the deadline.
- Regression coverage: the long-header test asserts 15-, 30-, and 45-minute waits; **“G3: ordered retries use absolute deadlines without adding worker scheduling drift”** also covers restart fallback and already-blocked attempt accounting; the inline write test asserts zero sleeps and one rejected HTTP request.
- Context7 `/websites/github_en_rest`: [REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api). Both server headers represent wait constraints; this implementation conservatively honors the later deadline if both are supplied.

## G4 — reads and cross-job cooldowns

- `src/github/errors.ts:90` exports `withGithubRateLimits(client, { key, db?, now? })`. A request-function proxy preserves Octokit request properties/auth hooks and gates reads and writes before HTTP. It converts rate-limit responses into a scheduling error. Composed/double-wrapped clients do not count the same response twice.
- `src/github/errors.ts:73` / `:81` persist cooldowns in existing `webhook_deliveries` rows under reserved `github-rate-limit:<key>` IDs, using `received_at` as the deadline and `GREATEST` so concurrent jobs cannot shorten it. Future cooldown rows survive normal age-based ledger pruning. Keys separate installations, App requests and public-host requests; no new schema/migration was needed.
- The four workers now use `processQueueJob` (`src/queue/workers.ts:311`). Raw inbound read failures honor headers instead of the old two-second replay schedule. Outbox read failures during assignee reconciliation, continuation and other execution persist the same deadline (`src/operations/outbox.ts:462`). The worker/outbox can extend a headerless fallback from durable attempts and republish the later shared cooldown.
- G5 integration was communicated through commentary and confirmed in the shared source: `src/app/github.ts` wraps installation, App, repository-installation discovery and public-profile clients; `src/app/main.ts` passes `db`. Those files were changed by G5, not G1. Other owners import the common classifier instead of interpreting a rate-limited 403 as missing permissions or an absent installation.
- Regression coverage: **“G4: inbound and raw outbound reads move to delayed, with bounded exponential secondary retries”**, **“G3/G4: cooldown persists between clients and blocks reads from other jobs until the full deadline”**, and **“G4: durable outbox read failures retain the full retry_at and release execution.”** The outbox test refuses a read at the former five-minute cap.
- Context7 `/websites/github_en_rest`: [JavaScript header-aware retry example](https://docs.github.com/en/rest/guides/scripting-with-the-rest-api-and-javascript), [rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api). Context7 `/websites/developers_plane_so`: [Plane header format](https://developers.plane.so/api-reference/introduction); the shared backoff parser retains epoch-seconds reset handling.

## G13 — inaccessible resources are not successful label removals

- `src/sync/github.ts:138` handles removal 404 by GETting the issue through the same installation client. Only a well-formed labels array lacking the target label proves success. Existing labels, malformed/missing labels and inaccessible/missing issues propagate the failure. A throttled confirmation read defers through the shared mechanism.
- Regression coverage: **“G13: 404 removal succeeds only for an accessible, well-formed issue lacking the label”** covers absent/present labels, malformed responses, permission failures, missing private resources, and throttled reads.
- Context7 fetched with `npx ctx7@latest docs /websites/github_en_rest "404 Not Found for existing private resource authentication"`: [GitHub private-resource 404 behavior](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api). A 404 alone does not establish desired label absence.

## P4 — stable Plane comment identity across delivery attempts

- This fix chooses the audit's explicit alternative: derive GitHub comment-write identity from the original Plane comment ID. `src/queue/workers.ts:21` derives a workspace/project/issue/comment identity for `issue_comment` create/created deliveries, independent of transport UUID and mutable body text. It does not collapse ordinary issue edits or comment updates.
- `src/queue/workers.ts:31` claims that identity for five minutes with an atomic delivery-ledger upsert. `src/queue/workers.ts:146` retains the original transport ID in audit records, passes a stable delivery identity to reducers, releases failed claims, and records `detail.writeDeliveryId` so explicit audit replay can repair the original write. Replay bypasses the short admission deduplication claim.
- `src/operations/outbox.ts:103` keys resulting GitHub comments by stable source identity, destination and occurrence. For these immutable comment creations it excludes mutable body text from the write ID. Thus TTL expiry, a fresh delivery UUID or a re-read of subsequently edited text cannot register another GitHub comment for the same source operation. Distinct Plane comment IDs remain distinct even with identical text.
- Regression coverage: **“P4: fresh Plane delivery UUIDs deduplicate one immutable comment, but distinct comments and replay run”**, **“P4: failed content claims are released, and TTL expiry retains the same durable write identity”**, and **“P4: duplicate Plane comment attempts register only one GitHub comment even after claim expiry.”** The last test changes the late retry's text and still expects one durable GitHub write.
- Context7 fetched with `npx ctx7@latest docs /websites/developers_plane_so "X-Plane-Delivery unique UUID per delivery attempt webhook_id activity timestamp"`: [delivery-attempt identity](https://developers.plane.so/dev-tools/intro-webhooks) and [v1-style data/activity payload](https://developers.plane.so/dev-tools/build-plane-app/webhooks). The newer v2 stable `event_id` is **not** assumed for this CE v1.4.2 service.
- Driver spec change requested through commentary: §5 must distinguish transport delivery deduplication from stable comment-operation deduplication; Plane retries may have new `X-Plane-Delivery` UUIDs. Exact replacement for the broad content-key claim: “Plane comment creations are deduplicated by stable comment identity; transport delivery IDs remain separate. Ordinary edits retain their own identities.” G1 did not edit the spec.

## Driver integration notes

- `tests/sync/github.test.ts` contains superseded assertions outside G1 ownership: unconditional removal-404 success and successful inline rate-limit retries/sleeps (including the old retry cap). Replace these with deferred-error/confirmed-absence expectations. New G1 regressions cover the intended behavior. G1 did not edit or run those tests.
- Any webhook-health query over `source='github'` must exclude the reserved `github-rate-limit:%` delivery IDs, because their `received_at` stores a future cooldown deadline. The current G4 silence detector queries Plane only and is unaffected. The reserved `content:plane-comment-*` claim IDs are also internal ledger metadata, not transport deliveries.
- Scope remains GitHub rate-limit scheduling plus the assigned Plane duplicate-comment fix. G4's Plane client/limiter remains G4-owned. If enforcing the shared deferred-429 rule for Plane's HTTP retry loop as well, change its 429 branch to propagate `PlaneApiError` with response headers to this scheduler rather than sleeping in `PlaneClient.request`; G1 did not edit that file.

## Allowed validation

Only this scoped compiler check was run (repeated after corrections):

```text
node scripts/typecheck.mjs src/github/errors.ts src/sync/backoff.ts src/sync/github.ts src/queue/index.ts src/queue/workers.ts src/operations/outbox.ts src/operations/plans.ts tests/queue/audit-g1.test.ts
```

Result: `typecheck passed (31 project files)`. The first pass found three test-fixture function signatures accepting no route argument; those signatures were corrected, and subsequent passes succeeded. No tests, gate-check commands, test oracles, staging, commits or pushes were run during this fix pass. All G1 edits are within its row plus this required report. Acceptance accounting: 6 met, 0 unmet, 0 abandoned, with runtime regressions left unexecuted as the user required.

## Round 2

The driver expanded G1 ownership to existing tests asserting inline GitHub retries/sleeps or the former five-minute cap. This round edits only `tests/sync/github.test.ts` and this report; production code is unchanged. The earlier integration note about leaving that test file untouched is superseded.

- [x] Replace unconditional label-removal-404 success with confirmed accessible-issue absence.
- [x] Replace inline retry/sleep expectations with deferred errors and complete deadlines.
- [x] Preserve bounded-retry coverage through the queue scheduler.
- [x] Search all existing tests for superseded GitHub retry/cap expectations, and run only the scoped typecheck.

`tests/sync/github.test.ts:63` now verifies the DELETE followed by the exact issue GET route/parameters, successful absence confirmation, zero sleeps, and no echo marker. The adjacent negative regression checks case-insensitive presence in both label representations, missing/malformed label data, and GET permission/404 failures, preserving the original error and clearing the marker. The throttled-confirmation regression requires a deferred 15-minute deadline, two HTTP calls, and no success or echo marker.

`tests/sync/github.test.ts:134` replaces successful inline 403/429 retry expectations with `GithubRateLimitError`, the original cause, a full deadline, exactly one HTTP request, zero sleeps, and cleared echo markers. It covers two-second Retry-After, a headerless 429's one-minute minimum, and a 15-minute Retry-After. Plain 403 preserves the permission error instead of becoming a scheduling error. Distinct installation IDs isolate the intentional shared cooldowns between fixtures.

`tests/sync/github.test.ts:164` asserts an exhausted primary quota's exact 45-minute reset deadline and verifies that an immediate subsequent write is blocked before HTTP, with the same deadline and no echo marker. `tests/sync/github.test.ts:186` replaces the old inline six-call retry cap with a six-attempt queue budget: five explicit delays with persisted attempt counts and exponential deadlines, then terminal `UnrecoverableError`, six total work invocations, and no sixth delay. A simulated clock advances to each deadline; the regression never waits in real time.

Searches across `tests/` found no other existing assertions requiring this GitHub behavior replacement. `tests/sync/backoff.test.ts` checks valid header parsing and the generic 60-second fallback ceiling, not the removed five-minute header cap. Existing G1 regressions explicitly reject requests at the former five-minute cap. Plane retry/pacing assertions belong to their respective owners and were left unchanged.

Context7 was refreshed with both commands below. [GitHub rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) supports full reset/Retry-After waits, a minute minimum without those headers, exponential retry progression, and a bounded retry count. [GitHub REST troubleshooting](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api) explains private-resource 404s, supporting the accessible-issue confirmation requirement. Deferring through the queue instead of sleeping follows the driver's agreed execution contract.

```text
npx ctx7@latest docs /websites/github_en_rest "Exceeding primary and secondary rate limits retry-after x-ratelimit-reset wait at least one minute"
npx ctx7@latest docs /websites/github_en_rest "404 Not Found for existing private resource authentication"
node scripts/typecheck.mjs tests/sync/github.test.ts
```

Validation: scoped typecheck passes (`30 project files`). Tests were written and updated but **not run**. No staging, commits, pushes, or other check commands were run. Round 2 acceptance: 4 met, 0 unmet, 0 abandoned.

## G4 relay — shared Plane deferral integration

Applied items 1 and 2 under **“Diffs for the driver”** in `docs/impl/fixes-audit-G4.md` exactly as written, as authorized by the driver.

- `src/github/errors.ts:46` recognizes `PlaneRateLimitError` by its error name and finite carried `retryAt`. Unsent budget deferrals keep that resolved deadline without substituting the exponential fallback. For a sent request, the result is the maximum of the carried deadline and the response classification. The name-based check avoids importing the Plane module back into its own classifier dependency.
- `src/queue/workers.ts:61` and `src/operations/outbox.ts:464` increment attempts only when an error's `requestMade` is not explicitly `false`, regardless of its class. Both retain existing terminal limits for actual failed requests.
- Added three regressions in the owned `tests/queue/audit-g1.test.ts`: **“G4 relay: Plane deferrals preserve their carried deadline and any later response deadline”** (`:88`), **“G4 relay: queue deferrals spend attempts only for errors with an actual request”** (`:97`), and **“G4 relay: outbox budget deferrals retain zero attempts until a request actually fails”** (`:114`). They cover short unsent deadlines without fallback drift, both orders of carried/response deadlines, typed Plane and generic unsent errors, persisted zero attempts and exact retry timestamps, and exhaustion of a one-request budget after an actual failure.

Context7 refreshed with `npx ctx7@latest docs /websites/developers_plane_so "rate limits X-RateLimit-Reset X-RateLimit-Remaining Retry-After 429"`. [Plane's API introduction](https://developers.plane.so/api-reference/introduction) documents remaining-quota and epoch-seconds reset headers. Local budget deferral identity and request-attempt accounting follow the driver's shared execution contract and G4's provided code; this change assumes no additional Plane v2 behavior.

Only validation run:

```text
node scripts/typecheck.mjs src/github/errors.ts src/queue/workers.ts src/operations/outbox.ts tests/queue/audit-g1.test.ts
```

Result: `typecheck passed (31 project files)`. The three new regressions were written and typechecked, **not executed**. No tests, staging, commits or pushes were run. Both requested relay items are complete; no change outside G1 ownership was made.
