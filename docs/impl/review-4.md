# Implementation review — round 4

VERDICT: BLOCKING

Reviewed the working tree on branch `seal` (HEAD fd280fa) after the six round-3 fix passes (`docs/impl/fixes-r3-{SA,SB,CA,CB,GA,GB}.md`), against the spec, the plan parts, HANDOFF.md's four pitfalls and the probe evidence. Every round-3 finding was adjudicated against the code, not against the write-ups.

Per the driver's instructions for this round, the oracles and the whole suite were **not** run (the user runs all gates once coding is finished). Every claim below comes from reading code, with the file:line quoted. No repository file other than this review and its ledger was modified.

The round-3 rewrite fixes what it set out to fix:
- reducers acknowledge durable intent and no longer wait for completion;
- creates use object idempotency keys;
- an occurrence ordinal fixes A→B→A;
- only the target head holds a wake-up, and the BullMQ limiter is gone;
- `outbound_writes` is pruned.

The new durable-plan machinery has no failure path, though:
- A plan step that fails for good leaves its `pending_sync_links` barrier behind for ever (F2).
- A failed intent can never be re-run, by replay or otherwise (F3).
- An object key that never changes blocks a later re-create (F4).

The F4 allow-list was built but never wired into the running service, so production refuses every new mapping (F1).

## Task verdicts
- A1: PASS — deploy surface unchanged; `PLANE_API_RATE_PER_MINUTE` is documented in `deploy/git-sync.env.example` (oracles not run this round, per driver).
- A2: PASS — ingress unchanged; replay's `writeDeliveryId` is set only from the internal job or worker-written audit detail, never from a webhook payload.
- A3: PASS — migration 006 creates `workspace_installations` and `pending_sync_links` as contracted; the dead 004 backfill is gone.
- A4: FINDINGS — F2, F3, F9, F10
- A5: PASS — reference parsing unchanged; default-branch pushes use commit messages only.
- A6: PASS — `branch.created` targets only branch-name references, skips `revert-` branches and terminal states (`src/app/rules.ts:107`); misleading audit residual noted under prev F18.
- A7: PASS — reconciliation unchanged; orphaned links stay orphaned (the re-opt-in consequence is F4).
- A8: FINDINGS — F1
- B1: FINDINGS — prev F15 residuals (credential health re-derived, `sawRow` in memory only) are not re-filed; see the prev line.
- B2: PASS — web fork unchanged since round 3.
- B3: FINDINGS — F1, F5, F11
- B4: PASS — compare threshold is 2048 with a 404/422 fallback; Smart Commits attribute by `sender.id`; each step runs under `sc:<sha>:<step>`.
- B5: FINDINGS — F6, F7
- B6: FINDINGS — F2, F4, F8
- B7: PASS — rollups are submitted as `upsert_rollup` intents, and link ids are recovered at execution.
- B8: FINDINGS — F3
- B9: FINDINGS — F10, F11

## Previous findings
- prev F1: CLOSED — "// Acknowledges durable intent, not API completion. Outages belong to the outbound worker." (src/operations/outbox.ts:202). `enqueue` returns `{ ok: true }` after registration; results are consumed through durable plans.
- prev F2: CLOSED — "const key = `create:gh:${mapping.workspaceSlug}:${mapping.ghRepoId}#${issue.number}:${mapping.planeProjectId}`;" (src/sync/mirror.ts:136). The plan root id hashes that key, and the marker is written in the same transaction. The fixed key introduced F4.
- prev F3: CLOSED — "return writeJobId(side, write, scope.deliveryId, actorUserId, scope.operationId ? `${scope.operationId}:${ordinal}` : ordinal);" (src/operations/outbox.ts:92)
- prev F4: STILL OPEN — "verifyMapping: createMappingVerifier({ plane: planeClient, github: ghClient })," (src/app/main.ts:58). The allow-list table, API and UI exist, but `installationWorkspace` is never passed, so the live verifier refuses everything (F1). Existing mappings are never checked against the allow-list (F5).
- prev F5: STILL OPEN — "const del = await db.query(`DELETE FROM user_map WHERE workspace_slug = $1 AND plane_user_id = $2 RETURNING id`, [slug, userId]);" (src/ui/api.ts:333). The lookup and member check are now wired and fail closed, and `push.ts:41` uses `usersByGithubId`. There is still no unlink tombstone (F11), and assignees are still mapped by login (`src/sync/mirror.ts:238`).
- prev F6: CLOSED — "detail: { outboxId: head.id, actorUserId: head.actor_user_id, reason: "token_revoked", identity: "service" } });" (src/operations/outbox.ts:352). This covers a token removed from the vault. A token Plane rejects is still dropped (F10).
- prev F7: STILL OPEN — "if (status === 404 || status === 403) return 0;" (src/app/issues.ts:153). The `.catch(() => 0)` is gone, but a GitHub secondary rate limit (403 + retry-after) still becomes installation 0 and is persisted into a durable plan (F8).
- prev F8: CLOSED — "await afterRules?.();" (src/app/pr.ts:193). `readyAfter` runs after the delivery's lifecycle rules.
- prev F9: STILL OPEN — "return { total_count: 0 };" (src/github/pr-automation.ts:296). Pagination, skipped/stale/0-run suites and the combined status were added. A failed status read is swallowed as "no statuses", and the App permission list still lacks Commit statuses (F6).
- prev F10: CLOSED — "const ownBranch = typeof branch === "string" && !/^revert-/i.test(branch);" (src/app/rules.ts:107), plus the execution-time `skipTerminalState` guard in `src/sync/plane.ts`.
- prev F11: CLOSED — "if ((await deps.db.query("SELECT 1 FROM outbound_writes WHERE target_key = $1 AND status = 'pending' AND sequence < $2 LIMIT 1", [row.target_key, row.sequence])).rows.length) return;" (src/operations/outbox.ts:145). Only the head wakes; the outbound worker has no `limiter`; blocking is capped. The 20-minute cap feeds F3.
- prev F12: CLOSED — "export const PUSH_PAYLOAD_COMMIT_LIMIT = 2048;" (src/github/smart-commits.ts:139)
- prev F13: CLOSED — "DELETE FROM outbound_writes" (src/db/ledgers.ts:81) for `applied`/`failed` rows past `outbound_retention_days`; pending plans and marker-referenced rows are kept.
- prev F14: CLOSED — "const outboxId = g?.id ?? g?.outboxId ?? undefined;" (src/queue/workers.ts:219). Inbound failures are audited on the final attempt only and superseded on success.
- prev F15: STILL OPEN — "let sawRow = false;" (src/app/credentials.ts:39). The handler comment is fixed, but the restart fallback is still in memory only, and `/instance/health` still re-derives `source` from row existence (src/ui/api.ts:547).
- prev F16: CLOSED — "void chained.then(() => { if (tails.get(key) === chained) tails.delete(key); });" (src/github/smart-commits.ts:201)
- prev F17: STILL OPEN — "PLANE_SERVICE_USER_ID?: string;" (src/config/env.ts:14). The 004 backfill and link-op recording are removed, but the service user id is still optional at config load.
- prev F18: STILL OPEN — "await appendAudit(ctx.db, { kind: "rule_match", source: opts.source ?? "github", deliveryId: opts.deliveryId, workspaceSlug: slug, detail, outcome: "applied" });" (src/app/rules.ts:80). The hash, the hidden base-branch field and the readiness API cost are fixed. A rule whose executor skipped every target is still audited `applied`.

## Findings

### F1 [BLOCKING] The installation allow-list is never wired, so production refuses every new or repo-changed mapping
File: src/app/main.ts:58
Spec: §8, §9
Evidence: `verifyMapping: createMappingVerifier({ plane: planeClient, github: ghClient }),` passes no `installationWorkspace`. In `src/ui/mapping-check.ts:57-58`, `const allowedFor = deps.installationWorkspace ? await deps.installationWorkspace(installationId) : null;` is followed by `if (allowedFor !== slug) return "That GitHub installation is not allowed …"`. `grep -rn "createMappingVerifier(" src tests` finds the production call and two unit-test calls, and no test goes through `composeRoutes`. SB's write-up names this hand-off ("SA's `src/app/main.ts` must pass `installationWorkspace: installationWorkspaceFromDb(db)`"); it was not done. Result: an instance admin allow-lists installation 123 for `qelal` in the new Admin panel, a `qelal` admin POSTs `/mappings` for a repo on 123, and gets 422 every time. §8's repo↔project mapping cannot be configured on the live service.
Fix: In `composeRoutes`, pass `installationWorkspace: installationWorkspaceFromDb(db)` to `createMappingVerifier`. Add a test through `composeRoutes`: an allow-listed installation is accepted, an unlisted one gets 422, and another workspace's installation gets 422.

### F2 [BLOCKING] A plan step that fails for good leaves its pending-link barrier for ever, so the object never syncs again
File: src/operations/outbox.ts:241
Spec: §7.3, §4, §5
Evidence: `if (marker) intents.at(-1)!.write._plan!.after.push({ kind: "clear_pending_link", key: marker.key });`. The marker is deleted only in the *applied* path of the plan's last write (`outbox.ts:425-436`). `failIntent` (`:272-301`) never touches `pending_sync_links`, and no other code deletes it (`grep -rn pending_sync_links src`).

`deferPendingMirror` (`src/sync/mirror.ts:76-95`) runs before the link lookup. It turns every later event on either side into a `mirror_pending` continuation whose predecessor is the last plan step. Once a step has failed, `resultOf` on that predecessor throws `QueuedWriteFailedError` (a 422, so permanent), and each deferred event fails as well.

Scenario: a GitHub issue is labelled `plane` during a Plane outage longer than the 20-minute block cap (`maxBlockMs`, `:127`). Alternatively, the cross-link comment step hits a permanent 403, such as a locked issue. Then:
- `create_issue` (or a later step) goes `failed`.
- Every later edit, comment or label on that issue is silently dropped, and there is no recovery.
- Re-registering the plan is a no-op (`ON CONFLICT (id) DO NOTHING`, `:249`).
- Pruning keeps marker-referenced rows (`src/db/ledgers.ts:84`), but once the create row ages out, `mirror.ts:85` throws "pending mirror has no create or continuation fence" and every later delivery for that object fails inbound.
Fix:
- When a plan intent fails terminally, in the same transaction:
  - fail its pending siblings (same `_plan.root`);
  - delete the group's `pending_sync_links` row;
  - write one `mirror_create_failed` audit.
- Make `deferPendingMirror` ignore a marker whose group has a `failed` row.
- Test: a create step that fails permanently, followed by an edit, is not deferred, and a re-opt-in registers a new create (see F4).

### F3 [BLOCKING] A failed outbound intent can never be re-run, so an outage longer than 20 minutes loses writes permanently and replay cannot recover them
File: src/operations/outbox.ts:199
Spec: §7.6, §4
Evidence:
- `const maxBlockMs = deps.maxTargetBlockDurationMs ?? 1_200_000;` (`:127`) marks the head `failed` after 20 minutes of retriable errors (`:276`). The next intent on the target then starts its own window.
- The inbound delivery was recorded `handled` at registration, so it never appears as a failed delivery.
- Replay (`src/operations/tooling.ts:99-101`) deliberately reuses `writeDeliveryId`, so it recomputes the same write ids. The insert is `ON CONFLICT (id) DO NOTHING`, then `if (row.status !== "pending") return { ok: true };` (`:199`). The failed row is returned as success and nothing executes.
- Plans keyed by object behave the same way (`:249`).
- No code sets a `failed` row back to `pending` (`grep "status = 'pending'"` finds only reads).

So during an hour-long Plane upgrade, roughly three writes per object are dropped, and §7.6's "Failed deliveries are replayable from the UI" cannot repair them.
Fix:
- When a registration hits an existing `failed` row (enqueue and plan root alike), reset it to `pending`, clearing `attempts`, `error` and `retry_at`, and wake it. Do this only for a replay, i.e. when the scope carries `writeDeliveryId` and the transport id differs.
- Add a "retry failed outbound write" operation alongside replay.
- Apply the time cap only to the head-of-line *blocking* decision. Do not use it to declare a retriable error terminal, or raise it to hours.
- Test: a replay after a terminal failure executes the write once.

### F4 [MAJOR] Re-opting an object in after its create failed or its partner was deleted creates nothing and drops the delivery's rules without an audit
File: src/sync/mirror.ts:287
Spec: §7.3, §1.3
Evidence: `const key = `create:gh:${slug}:${mapping.ghRepoId}#${issue.number}:${projectId}`;` is fixed for the object's lifetime, and so is the plan root id (`plan-sha256(key)`, `src/operations/outbox.ts:217`). Scenario:
1. The Plane partner is deleted, and reconcile correctly marks the link `orphaned` (pitfall 4).
2. The user re-labels the GitHub issue `plane`.
3. `findLinkByGithub` matches only `active` links, so `planPlaneCreate` runs again.
4. The root insert hits `ON CONFLICT DO NOTHING`, and `plan()` still returns `{ ok: true }`, so the mirror returns `{ action: "created" }` (`:323`).
5. `handleGithubIssue` then skips the inbound `runRules` (`src/app/issues.ts:136`, `resumeOwnsRules`), expecting a `mirror_created` resume that was never inserted.

No item is created, no rule runs and nothing is audited, until retention prunes the old plan (30 days). The Plane→GitHub key (`:476`) and the PR `-NEW` key (`src/app/pr.ts:75`) have the same defect.
Fix: Have `plan()` return `{ inserted: boolean }`. When the existing root's plan is finished (applied or failed), and there is no active link and no live marker, register under a new generation key (for example, append the finished root's sequence). Skip inbound rules only when this delivery's continuation was actually inserted. Test: orphan, then re-label, creates a new partner and runs the rule once.

### F5 [MAJOR] The allow-list governs only new mapping writes; existing and de-listed mappings keep syncing across workspaces
File: src/app/mappings.ts:29
Spec: §8, §9
Evidence: `return (await db.query("SELECT * FROM repo_mappings WHERE gh_repo_id = $1 ORDER BY id", [ghRepoId])).rows.map(toMapping);`. Runtime mapping lookups (`mappingsForRepo`, and `mappingsForProject` at `:35-36`) never consult `workspace_installations`. Migration 006 neither backfills nor flags existing rows, and PATCH re-verifies only when the repo changes. Therefore:
- The round-3 F4 attack mapping, made before the upgrade, keeps routing org A's issues into workspace B, and keeps writing B's `github`-labelled items into A's repository with A's installation token.
- Deleting or moving an allow-list entry (`DELETE /instance/installations/:id`) has no effect on mappings that already exist.
Fix: Filter runtime mapping lookups through `JOIN workspace_installations wi ON wi.installation_id = rm.installation_id AND wi.workspace_slug = rm.workspace_slug` (`repo_mappings.installation_id` exists since 003), and audit `installation_not_allowed` on a miss. Make the upgrade visible: in APPLY.md, list the existing mappings without an allow-list entry, or report them in `/instance/health`. Test that de-listing stops sync.

### F6 [MAJOR] A failed commit-status read counts as "no statuses", so readiness fires on a PR with red CI
File: src/github/pr-automation.ts:295
Spec: §7.1
Evidence:
- `} catch {` followed by `return { total_count: 0 };` (`:295-296`). `isReadyForMerge` checks statuses only `if (commitStatus && typeof commitStatus.state === "string")` (`:207`), so `{ total_count: 0 }` passes.
- The App permission list in `docs/research/findings-github.md` (lines 9-15) has no "Commit statuses: Read". On an App configured from that document, `GET /commits/{sha}/status` returns 403 every time and `status` webhooks are never delivered (GB's write-up flags this, but it was not done).
- Scenario: a repo uses only Jenkins or Vercel statuses, Jenkins is red, and a reviewer approves. Readiness evaluates as ready and the `ready_for_merge` rule moves the item. A transient 5xx gives the same false positive.
Fix: Do not swallow errors. A 5xx should fail the delivery so it retries. A 403/404 should evaluate as *not ready*, with a `readiness_unavailable` audit. Add "Commit statuses: Read-only" and the `status` event to `docs/research/findings-github.md` and to the App setup in `deploy/APPLY.md`. Test that a 403 from the status endpoint is not ready.

### F7 [MAJOR] An item created by `{ID}-NEW` never receives the PR's later lifecycle transitions or rollup updates
File: src/app/pr.ts:149
Spec: §6, §7.1
Evidence:
- `const items: LinkedItem[] = [];` is filled only from references parsed in the PR text (`:150-157`), plus the `createRequested` result, which is added only for `opened`/`edited`/`reopened`.
- On the plan path, `createRequested` returns `[]`, and `handleCreatedPr` (`:217-235`) processes the new item once.
- A `{ID}-NEW` token is a create request, not a reference, so on `closed`/`review_submitted` deliveries the created item is in neither list.
- The stored `pr` sync link (tier `closing`) is consulted only by `fireReadyForMerge`.

Scenario: the PR body says `QLL-NEW`, the item is created In Progress, and the PR merges into `main`. The item never moves to Done, and its rollup never shows "merged".
Fix: In `handleForMapping`, add the PR's active `sync_links` (`gh_kind = 'pr'`, `created_by = 'magic_word'`, or all active PR links) to `items`, de-duplicated against the parsed references. Test `-NEW`, then merge, moves the created item to the merged state.

### F8 [MAJOR] Any 403 from the installation lookup becomes installation 0, which is persisted in durable plans and fails for good
File: src/app/issues.ts:153
Spec: §9, §7.3
Evidence: `if (status === 404 || status === 403) return 0;`. A GitHub secondary rate limit is a 403 with `retry-after`, and `isPermanentWriteError` itself treats that as retriable (`src/queue/workers.ts:195`). Scenario: a Plane item gets the `github` label while the lookup is rate-limited. The create plan is registered with `installationId: 0` and fails on every attempt (`invalid GitHub installationId: 0`, `src/sync/github.ts:78`). Combined with F2, the item is then wedged for ever.
Fix: Return 0 only for a 404, or for a 403 with no `retry-after` and no `x-ratelimit-remaining: 0`. Rethrow everything else so the delivery retries. Never register GitHub writes or plans with installation 0; audit `github_not_installed` instead. Test both 403 kinds.

### F9 [MAJOR] Non-idempotent Plane POSTs are retried after an ambiguous failure, creating duplicate items and comments
File: src/sync/plane.ts:150
Spec: §5, §7.3
Evidence:
- `const retriable = res.status === 429 || res.status >= 500;`, and the network-error branch (`:139-144`), retry every method inside `PlaneClient.request`, POSTs included. A proxy 502/504, or a dropped connection on a slow `POST /issues/`, that Plane actually committed is replayed, creating a second work item.
- In `PlaneWritePath.apply`, `const created = await req…("POST", …/issues/…)` is followed by `await this.#recordCreated(created.id);` and the `finally` marker cleanup (`:298-302`). If either throws a database error after a successful POST, `apply` throws, the outbox retries, and the item is created again. Comments behave the same way (`:309`).

The ordered outbox records the result only after `apply` returns, so it cannot deduplicate either case.
Fix: Never retry POST in `request` on a 5xx or network error. Throw, and let the outbox decide. Before re-issuing a create, look up an item carrying the intent id: put the intent id in `external_id`/`external_source`, which Plane v1.4.2 issues support. Once the POST has succeeded, return its result even if the bookkeeping fails, and log that failure.

### F10 [MAJOR] An actor PAT that Plane rejects (revoked inside Plane) drops the write instead of falling back to the service identity
File: src/operations/outbox.ts:347
Spec: §9
Evidence: `actor = await deps.loadActorToken(head.actor_user_id) ?? undefined;`. The service fallback is taken only when the vault has no token. A token the user revoked inside Plane is still in the vault, so every attempt gets a 401. `isPermanentWriteError` makes a 401 permanent after 5 attempts (`src/queue/workers.ts:191-193`), so the user's transition or comment is dropped after a few minutes. That is the outcome round-3 F6 asked to remove, and it contradicts §9 and HANDOFF's "fall back to the service identity, audited".
Fix: On a 401 (or a 403 that is not a rate limit) from a write made with an actor token, mark the vault entry invalid, audit `identity_fallback` with `reason: "token_rejected"`, and retry the same intent as the service identity. Test: a 401 with the actor token, then a service-identity write and one audit.

### F11 [MAJOR] Unlinking a GitHub account is undone by the next event (no tombstone)
File: src/ui/api.ts:333
Spec: §9
Evidence: `DELETE /user-links` runs only `DELETE FROM user_map WHERE workspace_slug = $1 AND plane_user_id = $2 RETURNING id`. On the user's next push, PR or comment, `ensureLinkedByEmail` (`src/app/identity.ts:32`) re-inserts the row (`INSERT INTO user_map … ON CONFLICT DO NOTHING`, `:57`), and attribution, assignee mapping and Smart Commit resolution treat them as linked again. This was required in round 3 (F5), and SA reports it as not done ("needs a table").
Fix: Add `user_link_tombstones(workspace_slug, gh_id, created_at)` (migration 007). DELETE writes it, `ensureLinkedByEmail` skips a tombstoned `(workspace, gh_id)`, and a manual `PUT /user-links` clears it. Test unlink, then a push: no re-link, and service attribution is audited.
