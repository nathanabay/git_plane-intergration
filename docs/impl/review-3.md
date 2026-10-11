# Implementation review — round 3

VERDICT: BLOCKING

I reviewed the uncommitted working tree after the six round-2 fix passes, against:
- the spec;
- the plan parts;
- HANDOFF.md's four pitfalls;
- the leaf briefs;
- the probe evidence;
- the driver decisions for this round:
  - an exact `branch.created` trigger;
  - default-branch pushes target only commit-message references;
  - no upgrade path for saved r1 lifecycle tables;
  - CB's ordered durable outbox.

All 17 round-2 findings were adjudicated against the code, not against the `fixes-r2-*.md` answers. F4, F5 and F10 are fixed, and adapted copies of the round-2 reproduction tests now write nothing. The ordered outbox correctly fixes per-target ordering and read-modify-write. However, because reducers now *wait* for outbound completion and the outbox derives write identity from content, three new data-loss and duplication paths appear. §4's isolation is also undone. Two round-2 items remain open in production because a dependency was built but not wired: the user-link lookup, and the installation scoping that is still missing.

Several regressions were reproduced with scratch tests that drive the real outbox, harness or reducers: the A→B→A collapse, the duplicate create, the dropped write on a revoked token, approved overriding ready, a late approval missed past page 1, and the backport branch. The repository was not modified. Plane v1.4.2 facts below were checked read-only in the `plane-test-api-1` container's source. The full suite passes (`sh scripts/heavy.sh node scripts/run-tests.mjs 1 tests` → `tests passed (567 tests in 50 files)`), and the driver oracles pass through `sh scripts/heavy.sh` (ledger G2).

## Task verdicts
- A1: PASS — deploy surface unchanged; verify-a1-deploy passes.
- A2: PASS — the GitHub secret comes from the credential source per delivery; an unreadable stored secret answers 503 and never falls back (comment inaccuracy filed in F15).
- A3: PASS — migration 005 creates `outbound_writes` with a pending `(target_key, sequence)` index; 004 adds the legacy-commit guard. Applying the migrations is checked by verify-a3-schema.
- A4: FINDINGS — F1, F2, F3, F11, F14
- A5: PASS — the 403/404 handling from round 1 is intact; default-branch pushes now resolve commit-message references only (driver decision).
- A6: PASS — `branch.created` is an exact trigger; `branch.*` families stay unknown; dry-run uses the same `ruleEventsFor`.
- A7: FINDINGS — F13
- A8: FINDINGS — F14, F17
- B1: FINDINGS — F15
- B2: PASS — the loader is still shown while permissions load; the iframe has no `sandbox`, so the F11 `window.confirm` dialogs work; verify-fork-patch all passes.
- B3: FINDINGS — F4, F5
- B4: FINDINGS — F12, F16, F17
- B5: FINDINGS — F8, F9, F10, F18
- B6: FINDINGS — F2, F7
- B7: PASS — rollup links unchanged; link writes now record ops (moot on v1.4.2, see F17).
- B8: FINDINGS — F14
- B9: FINDINGS — F5, F6

### Driver decisions weighed
- **`branch.created`:** accepted and implemented exactly (`TRIGGER.branch_pushed = "branch.created"`; first push of a non-default branch only). It still targets commit-message references, which reopens finished items on backport and revert branches: F10.
- **Default-branch pushes use commit-message references only:** implemented (`parseReferences({ ...(defaultPush ? {} : { branch: … }), commits })`, and no association lookup when `defaultPush`).
- **No legacy upgrade of saved tables:** accepted. A table without a hash opens in YAML mode, and nothing is persisted.
- **Ordered outbox:** the ordering design is sound. Registration takes a per-target transaction lock, so sequence order equals commit order. Execution is claimed under `pg_try_advisory_lock` and always runs the oldest pending intent. A terminal failure unblocks the target. Compound label and assignee mutations read current state under the lock. However, the synchronous completion wait and the identity derived from content are not sound: F1, F2, F3.

## Previous findings
- prev F1: STILL OPEN — "verifyMapping: createMappingVerifier({ plane: planeClient, github: ghClient })," (src/app/main.ts:56). The verifier is now wired and `authoriseMapping` fails closed with 503. But `createMappingVerifier` still checks only that the App reaches the repo; no installation is tied to a workspace (SA and SB both report it as not done). See F4.
- prev F2: CLOSED — "const identity = JSON.stringify([deliveryId ?? randomUUID(), side, actorUserId ?? null, normalizeValue(wire)]);" (src/operations/outbox.ts:77). Ids no longer depend on position. The content identity introduced F3.
- prev F3: CLOSED — "if (head.write.kind === \"mutate_issue\") {" (src/operations/outbox.ts:203). Label and assign mutations and GitHub `set_assignees` read current state at execution, under the target lock.
- prev F4: CLOSED — "const shas = new Set<string>((needsAssociations ? commits.map((c) => c?.id) : []).filter(" (src/app/rules.ts). A branch cut from main makes no association lookup and writes nothing (adapted reproduction test).
- prev F5: CLOSED — "branch_pushed: \"branch.created\"," (src/github/pr-automation.ts:42). The `ruleSet.defaults` special case is gone. A merge push to main with the saved table writes nothing.
- prev F6: CLOSED — "WHERE target_key = $1 AND status = 'pending' ORDER BY sequence LIMIT 1`, [requested.target_key])).rows[0];" (src/operations/outbox.ts:192). Actor writes go through the same FIFO.
- prev F7: CLOSED — "export async function checkPrReadiness(" (src/github/pr-automation.ts:198). The invented payload fields and the `auto_merge_enabled` case are gone. Readiness is fetched from GitHub and wired from reviews, checks and statuses. New defects in the readiness logic: F8, F9.
- prev F8: CLOSED — "DELETE FROM processed_commits WHERE processed_at < NOW() - INTERVAL '1 day' * $1 AND workspace_slug <> ''" (src/db/ledgers.ts:67). The 004 backfill markers are dead (F17).
- prev F9: CLOSED — "return createPending(db, pendingCreateHash(projectId, name));" (src/queue/workers.ts:128). Markers are scoped by name or title, the final inbound failure is audited, and the inbound horizon is about 17 min. The outbox completion wait that landed alongside this undoes §4: F1.
- prev F10: CLOSED — "return { trigger: `check_suite.${conclusion}`, ...(typeof branch === \"string\" ? { head_branch: branch } : {}), ...repo, ...author };" (src/app/rule-events.ts:28) is now reached only for `check_suite` deliveries; `check_run` emits nothing.
- prev F11: CLOSED — "export function computeYamlHash(text: string): string {" (src/github/pr-automation.ts:60). A diverged body opens in YAML mode, and replacing custom YAML asks for confirmation.
- prev F12: STILL OPEN — "if (deps.lookupGithubUser) {" (src/ui/api.ts:305). `composeRoutes` never passes `lookupGithubUser`, so `PUT /user-links` still stores any login/id pair. Smart Commits still resolve the actor by login. The unlink tombstone and the membership check were not done. See F5.
- prev F13: STILL OPEN — "const deps = mirrorDeps(ctx, mapping, await installationFor(ctx, mapping).catch(() => 0));" (src/app/issues.ts:104). See F7. Typed `UnknownPlaneState`, the bounded 401 retries and the audit correlation fields were done.
- prev F14: CLOSED — "listCommitRange: (before, after) => listCommitRange(ctx, mapping, payload, before, after)," (src/app/push.ts:47). Its premise was wrong (F12).
- prev F15: CLOSED — "githubAppCredentials: { source: app.rows.length > 0 ? \"database\" : \"environment\", decryptOk }," (src/ui/api.ts:507). Credentials no longer fall back once a row has been seen, and a null URL means github.com. Residuals: F15.
- prev F16: CLOSED — "const r = await conn.query<{ ok: boolean }>(\"SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok\", [key]);" (src/github/smart-commits.ts:206), polled to a 30 s deadline. In-process residual: F16.
- prev F17: CLOSED — "opHash(\"plane\", write.issueId, \"links\", write.url)," (src/sync/plane.ts:219). The premise turned out false: Plane v1.4.2 sends no webhook for link writes. See F17.

## Findings

### F1 [BLOCKING] Reducers wait synchronously for outbound completion, so one side's outage stalls and then fails the other side's deliveries
File: src/operations/outbox.ts:156
Spec: §4, §5, §7.3
Evidence: `enqueue` registers the intent, then polls until `const deadline = Date.now() + (deps.completionTimeoutMs ?? 30_000);` and throws `QueuedWritePendingError`. `src/app/main.ts:89` sets no timeout. Nothing in `src/` catches the error, so the inbound job fails. Inbound workers run with `concurrency: 1` (`src/queue/workers.ts:254`).
- **Stall:** during a Plane outage, each GitHub delivery that writes to Plane holds `inbound-github` for 30 s per write. GitHub-only deliveries (PR comments, checks, rollups) queue behind it. That violates §4: "separated so one side's outage cannot stall the other".
- **Backlog without an outage:** a backlog of more than about 25 outbound jobs at the 50/min limiter has the same effect.
- **Abandoned reducers:** after 10 inbound attempts (about 17 min of backoff plus 10 × 30 s of waiting), the delivery is failed for good. The intent already registered still runs hours later, but the rest of the reducer never does. Example: `createPlaneItem` issues `create_issue`, then `upsertSyncLink`. The Plane item appears, but the link is never written, so the GitHub issue is "not opted in" from then on.
- **Duplicates on replay:** replay mints a new delivery id (`tooling.ts:96`), so every write the first attempt already applied (comments included) is applied again.
- **Regression:** the round-1 F9 design had reducers return once the write was durably queued. CB changed `apply()` to acknowledge completion so that Smart Commits record a step only after it is applied.
Fix: Return from `apply()` once the intent is durably registered, for every write whose result the reducer does not need. Only writes that need a result (Plane `create_issue`, `upsert_label`, `add_link`/`update_link`, GitHub `create_issue`) should wait, and they should be split into reducer continuations rather than blocking the inbound worker. For example, persist "after create X, upsert link Y" as a follow-up intent on the same target, run by the outbox after X applies. Smart Commits should record a step as applied when its intent is registered (the outbox now guarantees eventual execution or an audited terminal failure), or record a pending step completed by the outbox. Add a test: with Plane down, an unrelated GitHub-only delivery completes in under 1 s.

### F2 [BLOCKING] A pending create plus a second delivery for the same object creates duplicate Plane items
File: src/sync/mirror.ts:118
Spec: §5, §7.3
Evidence: GitHub sends `issues.opened` and `issues.labeled` for an issue created with the `plane` label, and both reach `return createPlaneItem(payload, deps);` while no link exists. With F1's 30 s wait:
1. D1's `create_issue` intent is registered but still pending, so D1 times out and backs off.
2. D2 still finds no link and registers its own `create_issue`. The job ids differ because `writeJobId` hashes the delivery id.
3. After the outage both intents execute.

Scratch test (`dupcreate.test.ts`, real `makeOrderedOutbox` + migrations) shows two `applied` rows with ids `plane-1` and `plane-2`. `createRequested` in `src/app/pr.ts` has the same gap: its guard checks only for an audit row with `outcome='created'`, so a `synchronize`/`edited` delivery during the window registers a second `-NEW` create. Before round 2, `create_issue` ran inline, so a failed delivery left nothing behind. `withObjectLock` serialises D1 and D2, but D1 releases the lock while its create is still pending.
Fix: Give creates an idempotency key that does not depend on the delivery, e.g. `create:gh:{repoId}#{number}→{projectId}` and `create:pr:{repo}#{n}:{key}`. Register the intent under that id (`ON CONFLICT DO NOTHING` returns the existing intent), and write the pending link row in the same transaction as the intent, so a second delivery sees "creation in progress". Test: two deliveries for one issue during a pending create produce one Plane item.

### F3 [BLOCKING] Identical writes within one delivery collapse into one, so A→B→A sequences end in the wrong state
File: src/operations/outbox.ts:77
Spec: §5, §7.2, §7.5
Evidence: `const identity = JSON.stringify([deliveryId ?? randomUUID(), side, actorUserId ?? null, normalizeValue(wire)]);`, and the `seq` set in `deliveryScope` (`src/app/reducers.ts`) is never used. The insert is `ON CONFLICT (id) DO NOTHING`, and `resultOf` returns the first write's result. Scratch test (`aba.test.ts`): one push whose commits say `WEB-1 #in-progress`, `WEB-1 #done`, `WEB-1 #in-progress`.
- The third transition has the same id as the first and is never executed.
- WEB-1 ends `done`, not `in-progress`.
- The Smart Commit ledger records that step as `applied`.

Rules that write X, Y, X to one item in one delivery behave the same way, and two identical comments from two rules become one. Round 2 asked for identity "never reused for a different write". A later write with equal content *is* a different write when an intervening write changed the state.
Fix: Include a stable ordinal of the write within the reducer step in the identity: for Smart Commits the step id `sc:<sha>:<step>`; for other reducers a per-delivery occurrence counter keyed by content hash (the n-th occurrence of identical content). Retries must reproduce the same ordinal. Keep content in the hash so the round-2 F2 shift cannot recur. Test the A→B→A push above.

### F4 [BLOCKING] Any workspace admin can still map any repository the App reaches (no installation-to-workspace scoping)
File: src/ui/mapping-check.ts:43
Spec: §8, §9, §3
Evidence: The verifier resolves `installationIdFor(owner, repo)` and accepts when `GET /repos/{owner}/{repo}` returns the same id and name. Nothing records which installations or orgs a workspace may use, and nothing stops two workspaces mapping the same repository (`fixes-r2-SA.md` and `-SB.md`: "Not done … per-workspace allow-list"). On an instance with more than one workspace, an admin of workspace B can map org A's repository. Then:
- A's issues, PRs and comments flow into B's project.
- Labelling a B item `github` writes issues and comments into A's repository with A's installation token.

This is the escalation round 1 F2 and round 2 F1 described. Only the Plane-side half is closed.
Fix: Add an instance-admin table `workspace_installations(workspace_slug, installation_id)` with an endpoint and UI (§8 instance scope), and require the repository's installation to be allow-listed for the workspace in `createMappingVerifier`. Until that exists, refuse a mapping whose installation is already used by a mapping in another workspace. Test both refusals.

### F5 [MAJOR] User links are still unverified in production, and Smart Commits attribute by login
File: src/ui/api.ts:305
Spec: §9, §7.2
Evidence: The user-link lookup is never wired, so the account check is skipped:
- `if (deps.lookupGithubUser) {` guards the account check.
- `composeRoutes` (`src/app/main.ts:50-66`) never passes `lookupGithubUser`.
- `grep -rn createGithubUserLookup src` finds only its definition.

So `PUT /user-links` fails open exactly as round 2 described. There is also no workspace-membership check of `planeUserId`. Smart Commits build `users: usersFor(ctx.db, slug)` (`src/app/push.ts:41`), and `resolveActor` calls `planeUserIdForGithubLogin(sender.login)`, which runs `lower(gh_login)`. The id-based `usersByGithubId` is used only in `actorTokenFor`. So a GitHub user who registers a linked user's old login after a rename is attributed as that Plane user on `#done`/`#comment` (the HANDOFF attribution pitfall), and assignee mapping (`issues.ts`, `rules.ts`) also goes by login. `DELETE /user-links` still has no tombstone; the next event re-links by email. Impact today: no production code stores PATs (no caller of `TokenVault.store`), so the effect is wrong attribution and assignment rather than misuse of a token.
Fix: Pass `lookupGithubUser: createGithubUserLookup(...)` in `composeRoutes`, make it required, and fail closed (503) like `verifyMapping`. Check `planeUserId` against `/workspaces/{slug}/members/`. Give `processPush` `usersByGithubId(ctx.db, slug, payload.sender)`. Add an unlink tombstone honoured by `ensureLinkedByEmail`. Add a wiring test through `composeRoutes`.

### F6 [MINOR] A write whose actor PAT is revoked before execution is dropped instead of falling back to the service identity
File: src/operations/outbox.ts:201
Spec: §9
Evidence: `if (!actor) throw new PlaneApiError(403, {}, "actor's Plane PAT has been revoked or removed");`. `isPermanentWriteError` treats it as permanent, so the intent fails on its first attempt and the write is never made (scratch `aba.test.ts` test 3). §9 and HANDOFF say a missing token falls back to the service identity, with an audit row. Intents can wait hours behind an outage, so an unlink in that window loses the user's transitions. Latent today, because nothing stores PATs (F5).
Fix: When the token is gone at execution, apply the write as the service identity and audit `identity_fallback` with `reason: "token_revoked"`. Never drop it.

### F7 [MAJOR] A transient installation-lookup failure still becomes a permanent, silent write loss
File: src/app/issues.ts:104
Spec: §4, §7.6
Evidence: `const deps = mirrorDeps(ctx, mapping, await installationFor(ctx, mapping).catch(() => 0));` is unchanged; round 2 asked to fail the delivery instead. A GitHub 5xx or network error in `installationIdFor` registers GitHub writes with `installationId: 0`. Then:
- `GithubWritePath` throws `invalid GitHub installationId: 0`, which `isPermanentWriteError` now classifies as permanent.
- The intent goes `failed` on its first attempt.
- Inbound retries hit the same content id and get the stored failure at once.

A short GitHub blip therefore permanently drops Plane→GitHub mirroring for that delivery, recoverable only by a replay (with F1's duplication).
Fix: Remove the `.catch(() => 0)` so the delivery fails and retries. Treat `installationId: 0` as a programming error, not a remote permanent error.

### F8 [MAJOR] When both "approved" and "ready for merge" are mapped, the approved rule runs last and overwrites the ready state
File: src/app/pr.ts:151
Spec: §7.1
Evidence: `handleForMapping` calls `fireReadyForMerge(...)` before the lifecycle rules, which then run `pull_request.approved` for the same delivery. Scratch test (`ready.test.ts`): table with `approved → In Progress` and `ready_for_merge → In Review`, checks already green, one approval → `PATCH s-review`, then `PATCH s-prog`. The item ends in the earlier lifecycle state. Mapping both points is the ordinary table setup.
Fix: Run `fireReadyForMerge` after the delivery's own lifecycle rules (and after `pull_request.approved` in the same delivery). Add the two-point test.

### F9 [MAJOR] Readiness is judged too strictly to fire on common repos, ignores commit statuses, and misses approvals past the first page
File: src/github/pr-automation.ts:169
Spec: §7.1
Evidence: `isReadyForMerge` requires `checkSuites.length > 0` and every suite to be `completed` with `success` or `neutral`. Cases where readiness never fires (scratch evaluations):
- A suite left `queued` by an installed app with checks:write that creates no runs.
- A `skipped` suite: path- or `if:`-filtered Actions workflows produce these, and branch protection treats them as passing.
- A `stale` suite.
- A repo with no check suites at all.

Commit statuses (Jenkins, CircleCI, Vercel) are never read, so a red status does not block readiness. `handleCommitStatus` only re-runs the same suite check, and the App permissions documented in `docs/research/findings-github.md` do not include "Commit statuses", so `status` deliveries are probably never sent. `GET …/pulls/{n}/reviews` is called without `per_page` or pagination (default 30, oldest first): one CHANGES_REQUESTED, 29 COMMENTED and an APPROVED on page 2 evaluate as not ready (scratch). Check-suites are not paginated either.
Fix: Ignore suites with `latest_check_runs_count === 0`. Accept `skipped`, and treat `stale` as not blocking. Also require the combined status (`GET /commits/{sha}/status`) to be `success` or to have no statuses. Paginate reviews and check-suites with `per_page: 100`. Either add Commit statuses: read to the documented App permissions or drop the `status` route. Test each case.

### F10 [MAJOR] `branch.created` targets commit-message references, so backport and revert branches reopen finished items
File: src/app/rules.ts:142
Spec: §7.1, §7.5
Evidence: `branch.created` runs over `referencedIssues`, which includes references parsed from the introduced commits' messages and from the branch name. Scratch tests, with both unsaved and saved defaults:
- `release/1.2` created with a cherry-pick whose message is "fixes QLL-1 …" → `PATCH iss-1 s-prog`.
- GitHub's revert branch `revert-12-octo/QLL-1-login` → `PATCH iss-1 s-prog`.

QLL-1 is Done in both cases and is moved back to In Progress. This is the same harm as round 2's F4, reached through another input.
Fix: For the "branch pushed" lifecycle, never move an item backwards. Skip targets whose state group is `completed` or `cancelled` (rule condition or executor guard). Restrict `branch.created` targets to references in the branch name, excluding `revert-*` prefixes. Test both payloads.

### F11 [MAJOR] Deferred outbox wake-ups consume the Plane rate-limit budget, and one failing intent blocks its target (or a whole project's creates) for hours
File: src/queue/workers.ts:284
Spec: §9, §4
Evidence: The outbound Plane worker has `limiter: { max: … 50, duration: 60_000 }`. BullMQ counts every job taken into processing, and a job that throws `OrderedWriteDeferredError` is moved to delayed without returning its slot. Every job behind a backing-off head defers to the same `retry_at`, so N blocked jobs spend N of the 50 slots on each wake. Example: 200 blocked jobs use about 4 minutes of Plane capacity every 10 minutes, starving other targets into F1's 30 s timeouts. Each intent can also make several service-PAT GETs (`#guardState`, `readPlaneIssueFields`) on top of its PATCH, so 50 jobs per minute can exceed Plane's 60 requests per minute. Head-of-line blocking:
- A retriable failure blocks its target for about 3.8 h (30 attempts, 10 min cap).
- `targetKey` for `create_issue` is `[plane, slug, projectId, "issues"]`, so one stuck create blocks every create in the project.
Fix: Have only the head intent's job hold a wake-up; jobs behind it should park without a delayed job and be woken by the head's completion. Count real HTTP requests in a token bucket, not BullMQ jobs. Key creates by their idempotency key (F2), not by project. Cap a retriable head's blocking time, e.g. mark it failed after a bounded window and audit it.

### F12 [MINOR] The >20-commit premise is wrong, and a failing compare call fails the whole push
File: src/github/smart-commits.ts:138
Spec: §7.2
Evidence: `export const PUSH_PAYLOAD_COMMIT_LIMIT = 20;`. GitHub's `push` webhook lists up to **2048** commits; 20 is the Events API limit. Round 1's F18 rested on that confusion. As a result:
- Every push of 20+ commits makes needless compare calls.
- A new branch pushed with 20+ commits writes a false `smart_commit_truncated` audit.
- The real limit (>2048) is never detected.

`const raw = await deps.listCommitRange(before, after);` propagates any error. A compare that GitHub refuses (404 or 422) fails `processPush`, so `branchPushed` and `runPushRules` never run, and after 10 attempts the delivery's Smart Commits are lost, even the ones listed in the payload.
Fix: Set the threshold to 2048. On a 404 or 422 from compare, fall back to the payload's commits with a `smart_commit_truncated` audit, and rethrow only 5xx and network errors.

### F13 [MINOR] `outbound_writes` is never pruned
File: src/db/migrations/005-outbound-writes.sql:2
Spec: §5, §7.6
Evidence: The table is referenced only in `src/operations/outbox.ts`, and `pruneLedgers` does not touch it. Every write keeps its full payload (descriptions, comment HTML) and result for ever, on a disk- and memory-constrained host. Every other ledger has a retention setting.
Fix: Prune `applied` and `failed` rows older than the delivery retention (they are only needed to dedupe retries of the same delivery), in `pruneLedgers` with its own retention column.

### F14 [MINOR] Failure audits are duplicated, and one correlation field is never written
File: src/queue/workers.ts:260
Spec: §7.6
Evidence:
- **Inbound:** `processInbound` audits `failed` on every attempt, and the final-attempt handler adds one more. An exhausted delivery leaves 11 `inbound_delivery failed` rows, each with the full payload, so the replay list shows duplicates. A delivery that failed once and later succeeded still has a replayable `failed` row.
- **Outbound:** the outbox audits a terminal failure, then throws `QueuedWriteFailedError` (a `PlaneApiError` 422, so `UnrecoverableError`), and the worker's `failed` handler audits it again.
- **Dead field:** that handler reads `outboxId` from `_gitsync`, whose field is named `id`, so `outboxId` is never written.
Fix: Audit inbound failure once per delivery (final attempt), and mark it superseded when a later attempt succeeds. Skip the worker-side outbound audit when the outbox already audited. Read `_gitsync.id`.

### F15 [MINOR] Credential health is re-derived rather than reported, and two comments or fallbacks misstate behaviour
File: src/api/handler.ts:149
Spec: §8, §9
Evidence:
- **Health:** `/instance/health` derives `source` from whether the row exists, not from `credentials.describe()` (which has no consumer), so it can disagree with what the process actually uses.
- **Restart:** `sawRow` is held only in memory, so after a restart a deleted row, or a cold start during a database outage, uses the environment secret again, even one rotated out because it leaked.
- **Handler comment:** "503, so GitHub redelivers" is wrong. GitHub does not redeliver failed webhooks automatically, so events during a decrypt failure are lost unless someone redelivers them from GitHub.
Fix: Pass `credentials.describe` into `ConfigApiDeps` and report it. Persist "a stored row has existed" (e.g. a flag in `instance_settings`) so the environment fallback is refused after the first save. Fix the comment, and document manual redelivery in the runbook.

### F16 [MINOR] The in-process Smart Commit lock can admit a second holder after a waiter times out
File: src/github/smart-commits.ts:198
Spec: §5
Evidence: Holder H runs, and waiter A is the last queued. A times out, and `if (tails.get(key) === chained) tails.delete(key);` deletes the key's tail while H is still running. A retried delivery R then starts from `Promise.resolve()` and runs concurrently with H. In production the advisory lock still excludes R, so the gap is real only on engines without `withConnection` (PGlite) and any path that skips the advisory layer.
Fix: On timeout, leave the waiter's link in the chain (resolve it as soon as `prev` settles, as a no-op), instead of deleting the tail.

### F17 [MINOR] Dead safeguards: the 004 backfill markers are never read, link ops are never consumed, and `PLANE_SERVICE_USER_ID` stays optional
File: src/sync/plane.ts:219
Spec: §5, §1.3
Evidence:
- **004 backfill:** migration 004's markers use `workspace_slug = ''`, but `recorded()` queries `delivery_id = $1 AND workspace_slug = $2`, so they never match. Legacy commits are protected by `claimed()` and the prune exclusion instead.
- **Link ops:** Plane v1.4.2's link endpoints (`IssueLinkListCreateAPIEndpoint` / `IssueLinkDetailAPIEndpoint`) call only `issue_activity.delay(type="link.activity.*")`, and that task sends no webhook. `model_activity` (the webhook source) is called only from the issue and comment views. So the two `links`/`link` ops recorded per link write are never consumed and expire unused, and the F17 test feeds a payload Plane never sends.
- **Service user:** `PLANE_SERVICE_USER_ID?: string` is still optional (`src/config/env.ts:14`), although actor-based echo dropping depends on it.
Fix: Drop the 004 backfill (or query it), remove the link op recording and its invented-payload test, and record the probe fact in the evidence file. Make `PLANE_SERVICE_USER_ID` required at config load and in `deploy/git-sync.env.example`.

### F18 [MINOR] Smaller rule-path defects: misleading audit, an unmatchable branch rule, readiness API cost, and a partial table hash
File: src/app/pr.ts:89
Spec: §7.1, §7.5
Evidence:
- **Misleading audit:** a branch-less first push whose commits mention a relation-tier key logs `rule_match applied` for that item although `mayChangeState` blocks the write.
- **Unmatchable rule:** the table lets a branch rule use the `branch_pushed` point with a base-branch regex, but `branch.created` events carry no `base_branch`, so the rule never matches.
- **API cost:** `fireReadyForMerge` checks readiness (reviews + check-suites) before looking up links, and every completed `check_run` triggers `/commits/{sha}/pulls` plus both readiness calls. Five completions made 20 GETs in a scratch run, even for PRs with no links.
- **Partial hash:** `computeYamlHash` covers the YAML body but not the embedded JSON, so a hand-edited comment shows a table that does not match the rules.
Fix: Audit `ignored` when the executor skips every target. Hide the base-branch field for `branch_pushed`. Look up links first and evaluate readiness only on `check_suite` completion and review submission. Hash the comment JSON together with the body.
