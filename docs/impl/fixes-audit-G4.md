# G4 documentation audit fixes

Owns: `src/api/**`, `src/sync/plane.ts`, `src/sync/reconcile.ts`, `src/queue/cron.ts`, `src/db/**` (migration 009),
`tests/sync/audit-g4.test.ts`, this report.

Numbering: the brief's P1, P2, P5, P6, P9 and P10 are `docs/impl/audit-plane.md` findings **A1, A2, A5, A6, A9, A10**.

Evidence: Context7 `/websites/developers_plane_so` for webhook delivery ("Any 2xx response is treated as a success",
"4xx responses are not retried", "After 5 failed attempts, Plane automatically disables the webhook"), v1 pagination
(`total_pages`, `next_cursor`, `next_page_results`) and the `/work-items/` paths. The docs describe Plane Cloud, so the CE
v1.4.2 behavior was confirmed in the tagged source: `api/urls/work_item.py` (the `/issues/` patterns are "Deprecated",
`work-items` patterns use the same views; no API-key archived-items endpoint exists, `app/urls/issue.py` serves
`archived-issues/` only with `BaseSessionAuthentication`), `api/views/project.py` (project detail returns archived
projects with `archived_at`), `api/views/issue.py` (activities list does not need the item to be visible),
`db/models/issue.py` (`IssueActivity.issue` is `DO_NOTHING`, so activities survive a delete),
`bgtasks/issue_activities_task.py` (`field="archived_at"` with `new_value` `archive`/`manual_archive`/`restore`;
`verb="deleted", field="issue"` on delete), `utils/paginator.py` (`per_page` ≤ 1000, `total_pages`) and
`utils/order_queryset.py` (`-updated_at`, `-created_at` are allowed orderings).

Only check run: `node scripts/typecheck.mjs` on my files and the test, then on `src/**/*.ts tests/**/*.ts` — both pass.
No tests run, nothing staged, committed or pushed.

## A1 [MAJOR] Plane ingress loses deliveries; a disabled webhook goes unnoticed

- `src/api/handler.ts:17` new optional `spool(job)` dep. When `enqueue` fails, the verified delivery is spooled and
  answered **202** `{queued:false, spooled:true}` (`:126`); 503 only when the spool fails too.
- `src/api/handler.ts:9`, `:92` `planeSecret` accepts a list, so during a rotation both the old and the new secret verify
  (fixes the 401-on-rotation loss when both are configured).
- `src/db/migrations/009-plane-ingress-spool-link-visibility.sql`: `inbound_spool` (unique per source and delivery id) and
  `ingress_health`; index on `webhook_deliveries(source, received_at)`.
- `src/db/ledgers.ts:213` `spoolInbound`, `listSpooled`, `deleteSpooled`, `markSpoolFailed`; `:233` `lastDeliveryAt`;
  `readIngressHealth`, `:249` `writeIngressHealth`, `listMappedPlaneProjects`.
- `src/sync/reconcile.ts:177` `replaySpooledDeliveries`: oldest first, deletes after enqueue, stops at the first failure
  (keeps order, `attempts`/`last_error` recorded). The queue job id makes a repeat a no-op.
- `src/sync/reconcile.ts:152` `checkPlaneWebhookHealth`: per mapped project, one `GET …/work-items/?per_page=1&order_by=-updated_at`.
  A change older than 30 min that is newer than the last Plane delivery + 30 min means deliveries stopped. Alerts once
  (`console.error` + audit `plane_webhook_silent`) and audits `plane_webhook_recovered` when deliveries come back. Plane's
  webhook rows cannot be read with an API key, so this indirect check is the best available.
- `src/queue/cron.ts:48` the reconcile job runs the health check; `:53`, `:68` new `replay-spool` scheduler (every 60 s),
  registered only when `startMaintenance` gets `enqueue`.
- Tests: `tests/sync/audit-g4.test.ts:39`, `:49`, `:56`, `:66`, `:81`, `:97`.

## A2 [MAJOR] The sweep orphans archived items and items in archived projects

- `src/sync/reconcile.ts:33` a 404 is classified before anything happens (`classifyMissing` `:100`, `verdictFromActivities` `:115`):
  archived project (read once per project per sweep) → **archived**; newest `archived_at` activity → **archived**; `deleted`
  activity → orphaned at once; anything else (project gone, no telling activity) → `missing_since` is set and only a second
  sweep that agrees orphans. A link already archived costs one read per sweep.
- Archived links keep `status = 'active'` (PATCH works on archived items in v1.4.2, and nothing that filters on `active`
  changes) with `sync_links.plane_archived_at` set; `onOrphan`/linkback never runs for them. A visible item clears both
  `plane_archived_at` and `missing_since` (`src/db/ledgers.ts:185`), so an unarchived item recovers.
- `src/db/ledgers.ts:190` `markLinkArchived`, `:198` `markLinkMissing`; `:156` re-linking clears `missing_since`;
  `src/db/schema.ts` new optional row fields; migration 009 adds the two columns.
- `reconcileOnce` now returns `{ checked, orphaned, archived, errors }`, and the orphan audit detail has `reason`.
- Tests: `tests/sync/audit-g4.test.ts:134`, `:148`, `:156`, `:164`, `:176`, `:186`.

## A5 [MINOR] The token bucket allows about 2× the limit

- `src/sync/plane.ts:49-51` default burst is `min(10, rate)` instead of a whole minute. `TokenBucket.acquire` also keeps a
  sliding 60-second send history and never exceeds `ratePerMinute` sends in any 60 s window, which is DRF's exact rule.
  Virtual time keeps injected sleeps correct.
- `src/sync/plane.ts:94` `pauseUntil`; `:204` the client pauses the shared budget until `X-RateLimit-Reset` (capped at 60 s)
  when a **service-key** response says `X-RateLimit-Remaining: 0`. An actor key's exhaustion does not pause the service budget.
- Tests: `tests/sync/audit-g4.test.ts:234`, `:247`, `:260`. The existing F11 pacing tests (`burstCapacity: 2`) keep their numbers.

## A6 [MINOR] One rate-limited request per link per sweep

- `src/sync/reconcile.ts:56` links are grouped per project. With more than one link, the project's visible ids are listed
  (`per_page=100&fields=id`), and only ids missing from the list are read one by one. A single link is just read.
- `src/sync/plane.ts:249` `listIssueIds` returns `{ ids, complete, totalPages }` (contract 3). It stops after the first page
  when `total_pages` exceeds the caller's budget (`floor(links/2)`), so a sweep never costs much more than one read per link.
  A partial list only proves the ids it holds.
- Tests: `tests/sync/audit-g4.test.ts:196`, `:205`, `:218`.

## A9 [MINOR] The triage guard is dead on v1.4.2

- `src/sync/plane.ts:317` an id missing after a refresh throws `UnknownPlaneState` with `mayBeTriage: true` (`:312`) and a
  message saying it is "either missing or a triage state". It keeps the "unknown Plane state" phrase that
  `src/app/rules.ts` matches. The `triage` group branch stays, commented as a guard for Plane versions that list triage (`:357`).
- Test: `tests/sync/audit-g4.test.ts:286`.

## A10 [MINOR] Deprecated `/issues/` URLs

- `src/sync/plane.ts:43-45` `PLANE_ITEMS_SEGMENT = "work-items"` and `planeItemsPath()`. Every read and write path in the
  client and the write path uses them, including `getIssueByIdentifier` (`/workspaces/{slug}/work-items/{KEY}/`).
- Test: `tests/sync/audit-g4.test.ts:295`.

## For the driver (outside my row)

1. **Wiring in `src/app/main.ts` (G5)**: `createWebhookRoutes({ …, spool: (job) => spoolInbound(db, job) })`;
   `startMaintenance({ …, enqueue: (job) => queues.enqueueInbound(job) })`. Optional: `planeSecret: [config.PLANE_WEBHOOK_SECRET,
   config.PLANE_WEBHOOK_SECRET_PREVIOUS].filter(Boolean)` with a new optional env var in `src/config/env.ts` and
   `deploy/git-sync.env.example`. Without the spool wiring A1 still answers 503 as before.
2. **Remaining `/issues/` callers**: `src/app/main.ts:140` and `src/app/pr.ts:429` (G3) should build their paths with
   `planeItemsPath(slug, projectId, issueId)` (+ `links/`) from `src/sync/plane.ts`.
3. **`src/github/smart-commits.ts` `isPermanent` (G2)**: also treat `UnknownPlaneState` as permanent (as `workers.ts` and
   `rules.ts` already do). Otherwise an unknown or triage state id is retried.
4. **`deploy/APPLY.md`**: add (a) re-enabling a Plane webhook that Plane disabled after 5 failed attempts (workspace
   settings → Webhooks), and what the `plane_webhook_silent` audit/log means; (b) secret rotation order: set the new
   secret as current with the old one as previous in git-sync, restart, rotate in Plane, then drop the previous one.
5. **Spec** §1.3 / §5: an archived Plane item (or archived project) does not orphan a link. It is marked archived, stays
   active and gets no linkback. An unexplained 404 orphans only on a second sweep. The Plane ingress answers 2xx once the
   delivery is queued or spooled.
6. **Existing tests that encode the old behavior and need updating** (not my files):
   - `tests/reconcile/reconcile.test.ts`: the fake plane only has `getIssue`. A 404 now needs `getProject` and
     `listIssueActivities` and orphans immediately only with a `deleted` activity (otherwise on the second sweep). The
     result also has `archived`. The batch test (7 links in one project) now lists ids first (`listIssueIds`).
   - `tests/queue/cron.test.ts:25`: same fake; add `getProject`/`listIssueActivities` (returning a `deleted` activity) and
     `latestIssueUpdate`, or expect orphaning after two runs.
   - `/issues/` → `/work-items/` in Plane URL matchers: `tests/a8/harness.ts:78-96`, `tests/sync/plane.test.ts:23,83,153`,
     `tests/a8/rule-events.test.ts:57`, `tests/a8/fixes-r2.test.ts:46,73,132,142`, `tests/a8/fixes-r3.test.ts:30`,
     `tests/a8/rule-engine.test.ts:187`, `tests/a8/echo-loop.test.ts:87`, `tests/app/review-r5-ca.test.ts:115,168,169`,
     `tests/mirror/review-r5-cc.test.ts:117`. (GitHub `/repos/…/issues/…` routes and `tasks.example/…/issues/` browser
     URLs are not Plane API paths and stay.)
7. Migration 009 is mine and holds only the tables and columns above. Nobody has sent me a column request.

## Deferred

- The silent-webhook state is in `ingress_health` and the audit log only. Showing it in the admin UI is G5's call.

## Round 2 (driver follow-ups)

- **`deploy/APPLY.md`**: §8 now describes the sliding-window limiter (burst ≤ 10). New §12 covers: how Plane delivery
  works (only transport failures are retried; 2xx once queued or spooled); re-enabling a webhook Plane disabled after 5
  failed attempts, with what the `plane_webhook_silent` and `plane_webhook_recovered` audits and the log line mean;
  rotating the secret with `PLANE_WEBHOOK_SECRET_PREVIOUS`. Plane generates the secret, so a short 401 gap between
  regenerating it and restarting git-sync cannot be avoided, and the runbook says so.
- **Tests updated to the new behavior** (fakes and Plane URL matchers only; GitHub routes and assertion intent unchanged):
  - `tests/reconcile/reconcile.test.ts`: the fake gains `listIssueIds`, `getProject` and `listIssueActivities` (a 404 item
    has a `deleted` activity). Results include `archived: 0`. The reads-only test keeps "no `request()`, no write path".
  - `tests/queue/cron.test.ts`: same fake additions, plus `latestIssueUpdate`, so the first run still orphans.
  - `/issues/` → `/work-items/` in `tests/a8/harness.ts` (Plane fetch fake), `tests/sync/plane.test.ts:23,83,153`,
    `tests/a8/rule-events.test.ts:57`, `tests/a8/fixes-r2.test.ts:46,73,132,142`, `tests/a8/fixes-r3.test.ts:30`,
    `tests/a8/rule-engine.test.ts:187`, `tests/a8/echo-loop.test.ts:87`, `tests/app/review-r5-ca.test.ts:115,168,169`,
    `tests/mirror/review-r5-cc.test.ts:117`.
  - **Missed in my first list, fixed the same way:** `tests/mirror/review-r4-cc.test.ts:46,52,261` (its own Plane fetch fake).
- Left as is: `tests/sync/review-r4-ca.test.ts` (sends `/issues/` as an arbitrary path to a catch-all fake), and
  `tests/smoke/live-smoke.test.ts:65` (live cleanup DELETE on the deprecated path, which still works on v1.4.2).
- Still on the deprecated path in source: `src/app/main.ts:140` (G5). The a8 harness no longer answers `/issues/`, so a
  test reaching that line would get the fake's default response.
- Typecheck `src/**/*.ts tests/**/*.ts`: passes (146 files). No tests run.

## Round 2: contract 2 for Plane (a 429 defers the job, never sleeps a worker)

### What changed (`src/sync/plane.ts`)

- `:28` new `PlaneRateLimitError extends PlaneApiError` (status 429, headers kept, `retryAt` epoch ms, `requestMade`).
  Because it is still a `PlaneApiError` 429, every existing check (`isPermanent` in rules and smart commits,
  `isPermanentWriteError`, the outbox's 401/403 actor fallback) still treats it as transient. G1's `classifyGithubError`
  reads its `status` and `response.headers` as `rate_limited`, so `processQueueJob` (`moveToDelayed(retryAt)`) and the
  outbox `failIntent` (`retry_at`) already defer it. No new deferral path.
- `:235` `request()` no longer sleeps and resends on 429, for any method. It throws once. The deadline comes from
  `classifyGithubError` itself (Retry-After, else X-RateLimit-Reset when Remaining is 0, else the 60 s minimum), so there
  is one rule. A service-key 429 also pauses the shared budget until that deadline (`:240`), so other requests on the
  key defer without being sent. 5xx and network retries for idempotent requests are unchanged.
- `:41`, `:152` the local budget waits inline at most `PLANE_MAX_INLINE_WAIT_MS` (2 s; `maxInlineWaitMs` option). A longer
  wait (a paused key, a full sliding window) throws `PlaneRateLimitError` with `requestMade: false` and the time the
  budget frees up. Nothing is consumed. Calling `TokenBucket.acquire()` directly without `maxWaitMs` behaves as before.
- Callers outside a queue (UI mapping checks, membership lookups) now get the 429 error immediately instead of waiting
  up to 5 retries inline.

### Tests (`tests/sync/audit-g4.test.ts`)

- `:330` GET, PATCH and POST: one call, no sleep, `retryAt` = Retry-After, and the classifier agrees.
- `:345` X-RateLimit-Reset deadline. The next request on the key defers unsent (`requestMade: false`).
- `:358` `processQueueJob` moves the job to the deadline (`DelayedError`) without sleeping. A budget deferral is never
  scheduled before its own `retryAt`.
- `:250` (round 1 A5 test, mine) now expects the exhausted key to defer instead of sleeping 30 s.

### Diffs for the driver (files outside my row)

1. **`src/github/errors.ts` (G1)**: honor the carried deadline. Otherwise a budget deferral with no headers is
   rescheduled at the classifier's 60 s × 2^n fallback instead of its real deadline: correct, but later than needed.
   Insert right after the `if (err instanceof GithubRateLimitError) { … }` block in `classifyGithubError`:
   ```ts
   // src/sync/plane.ts already resolved this deadline (also for waits refused before any request was sent).
   if (err instanceof Error && err.name === "PlaneRateLimitError" && Number.isFinite((err as { retryAt?: unknown }).retryAt)) {
     const own = (err as Error & { retryAt: number }).retryAt;
     const fromResponse = (err as { requestMade?: unknown }).requestMade === false ? undefined
       : classifyGithubError({ status: 429, response: (err as { response?: unknown }).response, message: err.message }, opts);
     return { kind: "rate_limited", retryAt: Math.max(own, fromResponse?.kind === "rate_limited" ? fromResponse.retryAt : 0) };
   }
   ```
2. **`src/queue/workers.ts` `processQueueJob` and `src/operations/outbox.ts` `failIntent` (G1)**: a deferral raised
   before any request should not use up the rate-limit attempt budget, the same as `GithubRateLimitError`:
   ```diff
   - const attempts = count + (err instanceof GithubRateLimitError && !err.requestMade ? 0 : 1);
   + const attempts = count + ((err as { requestMade?: unknown } | null)?.requestMade === false ? 0 : 1);
   ```
   ```diff
   - const attempts = head.attempts + (err instanceof GithubRateLimitError && !err.requestMade ? 0 : 1);
   + const attempts = head.attempts + ((err as { requestMade?: unknown } | null)?.requestMade === false ? 0 : 1);
   ```
3. **`src/github/smart-commits.ts` (G2)**: today a 429 inside a Smart Commit is counted as "pending" and becomes a plain
   `SmartCommitRetry`. That drops the deadline, and BullMQ's 2 s exponential backoff retries early and spends attempts.
   Carry the deadline:
   ```diff
   - import { PlaneApiError, TriageWriteRejected, UnknownPlaneState } from "../sync/plane.ts";
   + import { PlaneApiError, PlaneRateLimitError, TriageWriteRejected, UnknownPlaneState } from "../sync/plane.ts";
   ```
   Next to `isPermanent`:
   ```ts
   const rateLimitedUntil = (e: unknown): number => { const c = classifyGithubError(e); return c.kind === "rate_limited" ? c.retryAt : 0; };
   ```
   After `const retries: string[] = [];` (line 320): `let retryAt = 0; // contract 2: latest Plane deadline among pending commands`.
   In each of the three non-permanent branches (the `step` catch `pending++`, the lookup `else { pending++; … }`, the states
   `else { pending++; … }`), add `retryAt = Math.max(retryAt, rateLimitedUntil(e));`. Replace line 350:
   ```diff
   - if (retries.length) throw new SmartCommitRetry(`Smart Commits left pending, retry the delivery: ${retries.join("; ")}`);
   + if (retries.length) {
   +   const message = `Smart Commits left pending, retry the delivery: ${retries.join("; ")}`;
   +   if (retryAt) throw new PlaneRateLimitError(retryAt, { message });
   +   throw new SmartCommitRetry(message);
   + }
   ```
4. **Existing tests that encode the old sleep-and-resend behavior**:
   - `tests/sync/plane.test.ts:60-64`: add `PlaneRateLimitError` to the import on line 6 and replace the test with:
     ```ts
     test("client: 429 throws PlaneRateLimitError at the Retry-After deadline without sleeping", async () => {
       const { client, sleeps, calls } = harness([{ status: 429, body: {}, headers: { "retry-after": "2" } }]);
       await rejects(client.request("GET", "/x/"), (e: any) => e instanceof PlaneRateLimitError && e.retryAt >= Date.now() + 1000);
       deepStrictEqual(sleeps, []); strictEqual(calls.length, 1);
     });
     ```
   - `tests/sync/review-r4-ca.test.ts:40-51`: import `PlaneRateLimitError` and split the POST case out of the loop:
     ```ts
     test("F9 idempotent reads/updates still retry, and a rejected POST 429 defers at Retry-After", async () => {
       for (const method of ["GET", "PATCH"]) {
         let attempt = 0;
         const h = fixture(() => ++attempt === 1 ? json({}, 503) : json({ id: "ok" }));
         deepStrictEqual(await h.client.request(method, "/issues/", {}), { id: "ok" });
         strictEqual(h.calls.length, 2); deepStrictEqual(h.sleeps, [1000]);
       }
       const p = fixture(() => new Response("{}", { status: 429, headers: { "retry-after": "2" } }));
       await rejects(p.client.request("POST", "/issues/", {}), (e) => e instanceof PlaneRateLimitError && e.requestMade);
       strictEqual(p.calls.length, 1); deepStrictEqual(p.sleeps, []);
       let attempt = 0;
       const h = fixture(() => { if (++attempt === 1) throw new Error("temporary read outage"); return json({ id: "ok" }); });
       await h.client.request("GET", "/issues/"); strictEqual(h.calls.length, 2);
     });
     ```
   I found no other test that expects a Plane 429 to be retried inline. The F11 pacing tests (waits ≤ 1 s) stay under the 2 s inline limit.

Typecheck `src/**/*.ts tests/**/*.ts`: passes (147 files). No tests run, nothing staged.

## Round 2, item 4 applied (driver assigned these two test files to G4)

- `tests/sync/plane.test.ts`: `PlaneRateLimitError` added to the import (line 6). The old "client: 429 waits for
  Retry-After" test (lines 60-64) is replaced by "client: 429 throws PlaneRateLimitError at the Retry-After deadline
  without sleeping": it rejects with `retryAt` ≥ now + 1 s, makes 1 call and has no sleeps.
- `tests/sync/review-r4-ca.test.ts`: `PlaneRateLimitError` added to the import (line 9). The F9 test (line 38) now covers
  only GET and PATCH in its 503 retry loop, with one 1 s sleep each, as before. The POST 429 case is separate: it rejects
  with `PlaneRateLimitError` and `requestMade`, makes 1 call and has no sleeps. The network-error GET retry is unchanged.
- Exactly the replacements written in item 4 above; nothing else in either file changed.
- Typecheck `src/**/*.ts tests/**/*.ts`: passes (147 files). No tests run, nothing staged.

## Test phase

### The three orphaning failures: the test fixtures encode behavior A2 changed on purpose (not a regression)

- Cause: these tests orphan a PR's created Plane item with **one** `reconcileOnce` sweep using the real `PlaneClient` over
  the a8 fake. In that fake a created item's GET answers 404, the project read answers `{}` (not archived), and the
  activities read answers `{}` (no delete row). Under A2 (docs audit, Plane finding A2: archived items must not be
  orphaned) an unexplained 404 only sets `missing_since`, so the link stayed active and no replacement was created
  ("expected 2, got 1"). The replacement logic (G3's pr.ts/mirror.ts) is not involved: once the link is orphaned, all
  three tests pass unchanged.
- Fix (test fixtures only): the tests mean "actual orphaning", meaning the Plane item was deleted. Each file gets a
  `deletedInPlane(client)` reader: the real client answers `getIssue` (the fake's 404), `getProject` and
  `listIssueIds`, and `listIssueActivities` reports Plane's delete row (`verb: "deleted", field: "issue"`). That is
  the documented way a sweep confirms a delete in one pass. Every assertion about the single distinct replacement,
  the replays and the link statuses (`["orphaned", "active"]`) is unchanged.
  - `tests/app/review-r5-ca.test.ts`: helper after the imports; both `reconcileOnce` calls (F4 "actual orphaning…" and
    F4 "a pruned completed workflow…") use it. The exact-result assertion gains the new `archived: 0` field.
  - `tests/app/review-r7-ca.test.ts`: same helper; the F2 test's `reconcileOnce` uses it.
- Runs (capped command, one file at a time):
  - `tests/app/review-r5-ca.test.ts`: all pass, 0 failed.
  - `tests/app/review-r7-ca.test.ts`: the F2 orphaning test passes.

### Not mine, for the driver: 3 other failures in `tests/app/review-r7-ca.test.ts`

These were not on the driver's list and are unrelated to G4's files (no Plane reconcile, handler, client or migration
involvement). They are about GitHub installation refresh on the repository mapping:
- `F1: push refreshes 1 to 4242 before unmapped-sender lookup…` (line 92): `1 !== 4242` at :102.
- `F1: PR refreshes 1 to 4242 before create admission…` (line 119): `1 !== 4242` at :126, where the mapping's
  `installation_id` stays 1 after feeding a job from installation 4242.
- `F1: unlisted replacement installation is rejected by both actual reducers…` (line 146): missing expected
  rejection `/not allowed/` at :150.
The files involved this round are `src/app/github.ts` (installation lookup now through `withGithubRateLimits`; suspended
or invalid ids throw) and `src/app/reducers.ts` (new `installation` and `installation_repositories` handling). Those
belong to G5 and G1. I did not change them.

Typecheck of both test files passes. Nothing staged, committed or pushed.
