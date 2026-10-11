# Implementation review — round 2

VERDICT: BLOCKING

Reviewed the working tree (uncommitted) after the six round-1 fix passes, against the spec, the plan parts,
HANDOFF.md's four pitfalls, the leaf briefs and `.unlazy/impl/evidence/plane-webhook-probe.md`. Every
round-1 finding was adjudicated against the code, not against the `fixes-r1-*.md` answers. Three of the
round-1 fixes are not wired into the running service: F2's config half, F18, and in practice F14. The F9
queue rework and the F7 push-rule rework each introduced data-corrupting regressions. Five of these were
reproduced with scratch tests that drive the real harness (`tests/a8/harness.ts`) and `processInbound`; the
repository was not modified. The full suite passes (`sh scripts/heavy.sh node scripts/run-tests.mjs 1 tests` → `tests passed (498 tests in 39 files)`); oracles run through `sh scripts/heavy.sh` and my ledger
records the results.

## Task verdicts
- A1: PASS — deploy surface unchanged since round 1; override, Caddy stanza and APPLY.md still match §3 (verify-a1-deploy passes).
- A2: PASS — ingress still verify-then-enqueue. The GitHub secret now comes per delivery from `credentials.webhookSecret()` and fails closed when the stored row cannot be decrypted.
- A3: PASS — migration 004 safely replaces `processed_commits_pkey` with `(sha, workspace_slug)`; existing rows get `''`, and retention columns and indexes were added.
- A4: FINDINGS — F2, F3, F6, F13
- A5: PASS — `resolveReferences` and `issueResolver` treat 403 like 404 and audit the status; 5xx still throws (prev F1 closed).
- A6: PASS — engine unchanged; dry-run now goes through the shared `ruleEventsFor` translator, so live and dry-run see the same triggers.
- A7: PASS — `prune-ledgers` reads retention per run; ingress op TTL is read per event through a 15 s cache (prev F17 closed).
- A8: FINDINGS — F9, F17
- B1: FINDINGS — F15
- B2: PASS — page renders `LogoSpinner` while `workspaceUserInfo` is undefined, then `NotAuthorizedView` or the iframe; fork patch regenerated (verify-fork-patch all passes).
- B3: FINDINGS — F1, F11, F12
- B4: FINDINGS — F2, F14, F16
- B5: FINDINGS — F4, F5, F7, F10
- B6: FINDINGS — F3, F6, F17
- B7: PASS — rollup links unchanged; `add_link`/`update_link` still run inline, so their ids and the 404 re-add path survive the queue rework.
- B8: FINDINGS — F13
- B9: FINDINGS — F12

### Driver adjudication items (re-checked this round)
- **B6 labels as UUIDs:** fixed. `labels`/`label_ids` id arrays are diffed and resolved through the expanded `data.labels` or the project label list (prev F4 closed). However, the queued writes now lose label updates: F3.
- **B4 at-most-once:** the claim-after-success design is fixed (prev F8 closed). Its retry interacts with the positional queued-job ids and silently loses commands that the ledger records as applied: F2. The ~30 s inbound retry budget: F9.
- **B6 duplicate-create race and assignee removal:** fixed. The empty mapped set is sent, and the writer diffs only over mapped logins (prev F5 closed). Initial-label echo ops are recorded on GitHub creates (prev F13 closed). The new in-flight marker defers human creations and can drop them: F9.
- **B2 iframe while permissions load:** fixed (prev F15 closed).
- **A5 403:** fixed (prev F1 closed).
- **A8/B6 echo tolerance:** fixed. The tests use UUID-array fixtures and assert exactly zero extra writes (prev F10 closed).
- **`#time` as a comment:** PASS, unchanged since round 1.

## Previous findings
- prev F1: CLOSED — "if (err instanceof PlaneApiError && (err.status === 404 || err.status === 403)) {" (src/parse/references.ts:128; same in src/app/context.ts:105)
- prev F2: STILL OPEN — "if (!deps.verifyMapping) return;" (src/ui/api.ts:132). `src/app/main.ts` calls `createConfigRoutes({ db, planeInternalUrl, publicOrigin, tokenKey, operations })` without `verifyMapping`. The runtime half is closed (`payloadBelongsToMapping` in `handlePlaneIssue`); the config half never runs in production. See F1.
- prev F3: CLOSED — "WHERE plane_issue_id = $1 AND gh_repo_id = $2 AND gh_kind = 'issue' AND status = 'active' AND created_by = 'label_sync' LIMIT 1" (src/sync/mirror.ts:93; the GitHub-direction lookup at :85 is the same)
- prev F4: CLOSED — "case \"label_ids\": {" (src/sync/mirror.ts) diffs `idList(old_value)`/`idList(new_value)`; `assignee_ids` is handled alongside it
- prev F5: CLOSED — "const remove = current.filter((a) => mapped.has(a.toLowerCase()) && !wanted.has(a.toLowerCase()));" (src/app/issues.ts). The mirror sends `add_assignees` with `[]` when the mapped set empties.
- prev F6: CLOSED — "githubSecret: () => credentials.webhookSecret()," (src/app/main.ts:51). The App client is built from `createCredentialSource`. Residual health/source issues are in F15.
- prev F7: CLOSED — "await runPushRules(ctx, mapping, job);" (src/app/push.ts:31). Checks, deployments, issues and comments also call `runRules`. The rework regressed: F4, F5, F10.
- prev F8: CLOSED — "await claimCommit(deps.db, sha, repoId, slug);" (src/github/smart-commits.ts:363), reached only when no command is pending. Regression through the queued writer: F2.
- prev F9: CLOSED — "await queue.add(\"write\", write, id ? { jobId: id } : {});" (src/app/writers.ts). Outbound jobs get 30 attempts. Regressions: F2, F3, F6, F13.
- prev F10: CLOSED — "test(\"F10 API label UUID-array echo terminates with exactly zero extra writes\", async (t) => {" (tests/a8/echo-loop.test.ts:127)
- prev F11: CLOSED — ": compileLifecycleRules(QLL_DEFAULTS)" (src/ui/client/Workspace.tsx:279). The mapping table exists and prefills the defaults. Regressions: F5, F11.
- prev F12: CLOSED — "const match = matchPlaneUserByEmail(email, await members(ctx, mapping));" (src/app/identity.ts:51). Manual-link validation from the old Fix text was not done: F12.
- prev F13: CLOSED — "...(write.labels ?? []).map((l) => ({ opHash: opHash(\"github\", targetId, `label:${l}`, true), direction: \"to_github\" as const }))," (src/sync/github.ts)
- prev F14: STILL OPEN — "case \"auto_merge_enabled\": trigger = \"pull_request.ready_for_merge\"; break;" (src/github/pr-automation.ts:161). The point still cannot fire on real approval and check payloads, and the one live path is semantically wrong. See F7.
- prev F15: CLOSED — "if (!workspaceUserInfo) {" (apps/web/app/(all)/[workspaceSlug]/(settings)/settings/(workspace)/git-sync/page.tsx:17)
- prev F16: CLOSED — "await claimCommit(deps.db, sha, repoId, slug);" (src/github/smart-commits.ts:363). The check is `workspace_slug IN ($2, '')`, and the PK is `(sha, workspace_slug)`.
- prev F17: CLOSED — "if (job.name === \"prune-ledgers\") return pruneLedgers(opts.db, await readRetention(opts.db));" (src/queue/cron.ts:48)
- prev F18: STILL OPEN — "if (!deps.listCommitRange) {" (src/github/smart-commits.ts:201). `src/app/push.ts` never supplies `listCommitRange`, so every push of 20 or more commits is only audited as `smart_commit_truncated`. See F14.

## Findings

### F1 [BLOCKING] Mapping verification is never switched on in production; the cross-workspace / any-repo escalation is still open
File: src/ui/api.ts:132
Spec: §8, §9, §3
Evidence: `authoriseMapping` starts with `if (!deps.verifyMapping) return;`, and `verifyMapping?` is optional. Its doc comment says "The running service always supplies it", but `src/app/main.ts:54-68` builds the config routes without it, and `grep -rn createMappingVerifier src` hits only `src/ui/mapping-check.ts` itself (it is used only in `tests/ui/workspace.test.ts` and `tests/ui/harness.ts`). SB's answer says wiring it was outside its ownership, and no one else did it. So `POST /mappings` with any `ghRepoId`/`ghRepoFullName` the App is installed on is still accepted after format checks alone. Consequences:
- Inbound: GitHub events from that repo drive the admin's Plane project.
- Outbound: labelling a Plane item `github` creates issues and comments in that repo with the App installation token.
- Backfill: reads that repo's issues.
The Plane-side half is now guarded at runtime by `payloadBelongsToMapping`; the GitHub side is not guarded at all. Even when wired, `createMappingVerifier` (`src/ui/mapping-check.ts:41-43`) only checks that the App can see the repo (`installationIdFor` + `GET /repos/…`, id and name match). Nothing ties an installation or org to a workspace, so on a multi-workspace instance any workspace admin can map any repo the App reaches. That is exactly the escalation the file's header says it prevents.
Fix: Construct `createMappingVerifier({ planeClient, ghClient })` in `src/app/main.ts` and pass it as `verifyMapping`. Make the dependency required (or fail closed with 503 when absent) so a missing verifier can never mean "allow". Add an instance-admin allow-list of installation ids (or orgs) per workspace and check the repo's installation against it. Add a wiring test that drives `startService`'s routes (not a hand-built harness) and expects 422 for a project from another workspace.

### F2 [BLOCKING] Positional outbound job ids make retried deliveries drop writes silently; a retried Smart Commit is lost but recorded as applied
File: src/app/writers.ts:25
Spec: §5, §7.2, §4
Evidence: Queued writes get `` `${deliveryId}-w${++scope.seq}` ``. `seq` restarts at 0 on every attempt (`src/app/reducers.ts:30`), and completed jobs are retained for 24 h (`removeOnComplete: { age: 24 * 3600 …}`). BullMQ silently ignores an `add` whose id it already holds. So dedup is correct only if a retry issues exactly the same writes in the same order, and the F8 fix guarantees the opposite: `step()` skips already-recorded steps (`src/github/smart-commits.ts:289`, `if (await recorded(id)) return;`), so every later write moves down one sequence number onto an id from attempt 1. Scratch test (`seq.test.ts`, real `processPush` + `queuedPlaneWriter`): a commit `WEB-1 WEB-2 #in-review` where WEB-2's preflight `#guardState` fails once with 503.
- Attempt 1 enqueues `github-d1-w1` for WEB-1, then throws `SmartCommitRetry`.
- Attempt 2 skips WEB-1. WEB-2 is given `github-d1-w1`, which BullMQ discards.
- The audit still records `sc:…:0:WEB-2:t0 applied`, and the commit is claimed.
The command is lost and the ledger says it was done. The same shift affects any reducer whose number of queued writes depends on live state. Examples: rule `add_label` that skips when the label is present, `mayChangeState`, the assignee diff. Rules over items A and B: attempt 1 queues A's write as `-w2` and fails reading B; on retry A needs nothing, B gets `-w2`, and B is never written.
Fix: Derive the job id from the write's identity, not its position. For example: hash of (delivery id, reducer, target object, write kind, fields), or for Smart Commits the step id `sc:<sha>:<step>`. Never reuse an id for a different write. Add a test: retry after a partial failure enqueues the missing write.

### F3 [BLOCKING] Read-modify-write of Plane label and assignee lists against a queue loses updates
File: src/github/pr-automation.ts:309
Spec: §7.3, §7.5, §5
Evidence: The rule executor reads the item's current labels from Plane, then writes back the whole array:
- `add_label`: `const cur = await needFields(issue, "add_label"); if (!cur.labels.includes(label.id)) await write({ kind: "update_issue", …, fields: { labels: [...cur.labels, label.id] } })`
- `remove_label` (`:315`) and `assign` (`:322-323`) do the same.
Since F9, that `update_issue` is queued (`writers.ts:35-39`), so a later read cannot see an earlier write still waiting in Redis. Before F9 each write was applied before the next read. Lost-update cases:
- **(a) Two label actions in one rule.** A rule with two `add_label` actions on one item: both read `[]`, and the item ends with only the second label. Plane-source rules always take the queued path (`actor: async () => undefined`).
- **(b) Mirror plus rule.** A GitHub `issues.labeled` delivery: the mirror queues `{labels: <GitHub set>}` (`src/sync/mirror.ts:166`), then `runRules` `add_label` reads the pre-mirror labels and queues `{labels: [...old, x]}`. The mirror's change is overwritten.
- **(c) GitHub assignees.** `assigneeSyncWriter` (`src/app/issues.ts:28-38`) diffs against a live `GET` of GitHub assignees and queues the result. Plane "assign Alice", then "switch to Bob" while the queue is behind: the second diff still sees `[]`, so GitHub ends with Alice and Bob.
`withObjectLock` no longer protects any of this, because the writes run after the lock is released. This silently corrupts Plane and GitHub data.
Fix: Do not queue read-modify-write operations. Either:
- Express them as operations the worker resolves at execution time: `add_label_id` / `remove_label_id` / `set_assignees`, where the worker reads current state immediately before the PATCH under the object lock.
- Or run them inline (as `create_issue` is).
For GitHub, use the additive endpoints (`POST /issues/{n}/assignees`, `DELETE …/assignees`) computed in the worker. Add tests for (a)–(c).

### F4 [BLOCKING] Cutting any new branch from main moves the last merged PR's work items from Done back to In Progress
File: src/app/rules.ts:123
Spec: §7.1, §7.5
Evidence: `runPushRules` keeps the `push` trigger for a first push (`created === true`). Its targets include the linked items of every PR that contains `p.after` or `p.head_commit.id`:
- `const shas = new Set<string>([...commits.map((c) => c?.id), p?.after, p?.head_commit?.id]…)`
- then `GET /repos/{o}/{r}/commits/{sha}/pulls`.
For a branch created from main with no new commits, GitHub sends `commits: []`, with `after`/`head_commit` equal to main's HEAD, which belongs to the PR just merged. Scratch test (`newbranch.test.ts`, no saved rules, item linked to merged PR #12, push of `refs/heads/someone/unrelated-work` with `created: true`) → `PATCH …/issues/iss-1/ {"state":"s-prog"}` from the shipping default "branch pushed → In Progress". §7.1's "branch first pushed" applies to the items the branch references, not to items of PRs reachable from its base commit. With the shipping defaults, every `git push -u origin new-branch` reopens finished work.
Fix: Collect PR-association targets only from the commits this push introduced (`p.commits`, or the compare range). Never use `after`/`head_commit` when `commits` is empty or the push created a branch. Apply the first-push lifecycle only to items referenced by the branch name or by the introduced commits. Add a regression test with the payload above.

### F5 [BLOCKING] Saving the lifecycle mapping table makes "branch pushed" fire on every push, including merges to main
File: src/app/rules.ts:108
Spec: §7.1, §7.5, §8
Evidence: The first-push restriction is `if (ruleSet.defaults && !firstPush) events = events.filter((event) => event.trigger !== "push");`, so it holds only while no rule set is saved. `compileLifecycleRules` compiles `branch_pushed` to a plain `when: push` rule, and the F11 table's "Save" stores exactly that. From then on every push targets the referenced items plus the linked items of PRs containing the pushed SHAs. Scratch test (`revert.test.ts`): rules = `compileLifecycleRules(QLL_DEFAULTS)`, item linked to PR #12, push of the merge commit to `refs/heads/main` (`created: false`) → `rule_match "default: branch_pushed"`, `PATCH {"state":"s-prog"}`. The same push with nothing saved produces no write. Effects:
- A merged item ends Done or In Progress depending on whether the `pull_request.closed` or the `push` delivery is processed last.
- A fixup pushed during review moves In Review back to In Progress.
Saving the defaults unchanged changes behaviour, which is a second evaluator in disguise; §7.1 says the table "compiles down to ordered rules".
Fix: Give the lifecycle point its own trigger (e.g. `branch.created`, emitted only for a first push of a non-default branch) or a condition the compiled rule carries (`if: { first_push: true }`). Compile `branch_pushed` to it, and drop the `ruleSet.defaults` special case. Test that the saved defaults and the unsaved defaults produce identical writes for the payloads in F4 and F5.

### F6 [MAJOR] Outbound writes can be applied out of order: a delayed retry or an inline actor-token write overtakes a newer write
File: src/app/writers.ts:35
Spec: §9, §5, §7.3
Evidence:
- **(a) Delayed retry wins.** A failed outbound job sits in BullMQ's delayed set for up to 10 min per attempt over about 3.8 h (`outboundBackoff`), while later jobs for the same object run. Plane Done, then quickly In Progress, produces GitHub `update_issue {state:"closed"}` then `{state:"open"}`. If the first gets a 502, the second applies, then the first is retried and closes the issue. GitHub ends closed while Plane says In Progress, and nothing corrects it. Before F9 this window was the inbound job's ~30 s. With more than one replica (which the advisory locks assume), each replica's concurrency-1 worker reorders even without failures.
- **(b) Actor-token writes skip the queue.** `if (PLANE_INLINE.has(write.kind) || opts.actorToken) return inline.apply(write, opts);` sends per-user-token writes around the queue. A mapped user with a PAT closes a GitHub issue under the rule `issue.closed → set_state Released`:
  - The mirror queues `{state: <first completed state>}`.
  - The rule writes `Released` inline at once.
  - The queued mirror write then lands last.
  So the final state depends on whether the sender has a stored PAT. §9: "Keep the queue for ordering".
Fix: Order writes per target object. Options: a BullMQ group or a per-object queue key with `concurrency: 1` across replicas; or a version/sequence column per (object, field) checked in the worker so an older write is discarded once a newer one has applied. Route actor-token writes through the same ordering (keep the token out of Redis by storing only the Plane user id and loading the token in the worker).

### F7 [MAJOR] `ready_for_merge` cannot fire on real GitHub payloads, and its one live path is wrong
File: src/github/pr-automation.ts:161
Spec: §7.1
Evidence: Detection depends on fields GitHub does not send:
- `isPrApproved` reads `pr.approved`, `pr.review_state` and `pr.reviews`, none of which exist on PR objects.
- `allCheckSuitesPassed` relies on `mergeable_state` (absent from the `pull_request` in `pull_request_review` and `check_suite` payloads), `checks_passed` (invented) or `check_suites` (invented).
- `case "ready_for_merge"` is not a GitHub `pull_request` action.
Scratch evaluation of realistic payloads:
- An approved review gives `pull_request.approved`.
- A successful check suite (whose `pull_requests` entries carry only id, number, url, head and base) gives `check_suite.success` only.
The only firing path is `case "auto_merge_enabled": trigger = "pull_request.ready_for_merge"`. Enabling auto-merge means "merge when ready" and is normally done before approval or green checks; it fires even on a draft PR. A rule on this point (offered in the F11 table) therefore moves items at the wrong moment. GB's "payload documentation" in `fixes-r1-GB.md` is not accurate.
Fix: Compute readiness from GitHub, not from the payload. On `pull_request_review.submitted`, `check_suite.completed` and `status`, for each associated open PR, fetch the reviews (`GET /pulls/{n}/reviews`, latest per reviewer approved and none requesting changes) and the combined checks for the head SHA (`GET /commits/{sha}/check-suites`, all completed success or neutral). Emit `ready_for_merge` once both hold. Remove the `auto_merge_enabled` and `ready_for_merge` action cases. Base the tests on recorded webhook payloads.

### F8 [MINOR] Pre-F16 commits can be re-applied after retention prunes their claim
File: src/db/ledgers.ts:67
Spec: §5, §7.2
Evidence: Commits processed after F8 are protected by the `sc:<sha>` audit marker, and audit rows are never deleted. Commits processed before the fix have only a `processed_commits` row, which `pruneLedgers` deletes after `commit_retention_days` (180). A later re-delivery of such a SHA (e.g. a new branch pushed from an old commit with >0 new commits listing it, or a fork sync) re-applies its `#done`/`#comment`.
Fix: In migration 004 (or a new one), backfill a `smart_commit` done marker for every existing `processed_commits` row. Or exclude rows with `workspace_slug = ''` from pruning.

### F9 [MAJOR] Inbound retries exhaust in ~30 s and the final failure is silent: human creations deferred by the in-flight marker and pending Smart Commits are lost
File: src/queue/workers.ts:135
Spec: §5, §4, §7.6
Evidence: Inbound jobs have `attempts: 5`, exponential from 2 s (≈ 2+4+8+16 = 30 s). Two round-1 fixes now rely on that budget.
- **(a) The in-flight marker defers human creations.** `if (await createInFlight(job, deps.db)) throw new CreateInFlightError();` defers every Plane `issue` create in a project, every Plane comment create on an item, and every GitHub `issues.opened/labeled/assigned` in a repo, while *any* of our creates there is pending (marker TTL 30 s, re-armed by each create). A bulk opt-in keeps the marker continuously fresh for longer than 30 s: e.g. 30 GitHub issues labelled `plane`, creates run inline without the 50/min limiter, and Plane answers 429 with Retry-After. Meanwhile a human's new Plane item labelled `github`, or a comment on a linked item, exhausts all 5 attempts. The `CreateInFlightError` branch forgets the delivery and rethrows *without* `auditDelivery(…"failed")`, and the worker's `failed` handler audits only outbound queues. So the event is gone with no audit row and nothing to replay.
- **(b) Smart Commits only get the inbound budget.** A `SmartCommitRetry` (Plane outage > 30 s while writing with a user token, or `#guardState` failing) fails the delivery for good. It is replayable only by a person who notices.
- **(c) Retries re-run other reducers.** Because `handlePush` loops `smartCommits → branchPushed → runPushRules` per mapping, a retry re-runs the earlier mappings' rule actions and inline writes (duplicate comments).
Fix: Do not defer by throwing on the inbound budget. Wait (bounded, e.g. poll the marker for ≤ 60 s) or re-enqueue with a delay and its own counter. Always audit the final inbound failure (handle `failed` for the inbound queues when `attemptsMade >= attempts`, and audit `CreateInFlightError` like any other failure). Scope the marker narrowly: GitHub creates by title+body hash, Plane creates by name, not the whole repo or project. Give `SmartCommitRetry` its own longer retry, e.g. re-enqueue the push to a dedicated queue with outbound-style backoff, and make per-mapping work independent so a retry does not re-run completed mappings.

### F10 [MAJOR] Every completed check run is reported as a suite-level `check_suite.<conclusion>`
File: src/app/rule-events.ts:29
Spec: §7.5, §7.1
Evidence: For `check_run` the translator emits `` trigger: `check_suite.${conclusion}` `` from the *run's* conclusion. A suite with N runs therefore fires `check_suite.failure` rules up to N+1 times (each failing run plus the suite). It fires `check_suite.success` as soon as one run succeeds, while others are still running or have failed. A rule "check_suite.success → move to QA" moves the item while CI is red. §7.5 names `check_suite.*` events.
Fix: Emit `check_suite.*` only from `check_suite.completed`. If run-level automation is wanted, add a distinct `check_run.<conclusion>` trigger to the vocabulary and the editor.

### F11 [MAJOR] A stale embedded mapping comment silently discards hand-written rules
File: src/github/pr-automation.ts:91
Spec: §7.1, §8
Evidence: `parseLifecycleMappingFromYaml` matches `^#\s*gitsync-lifecycle-mapping:` anywhere in the file and never checks that the YAML body still corresponds to the comment. Scenario:
1. An admin switches to YAML mode and adds a custom rule, leaving the comment line in place.
2. "Validate and save YAML" succeeds.
3. On the next load, `Workspace.tsx:270-273` opens in table mode, restored from the stale comment. The custom rule is invisible.
4. "Save mapping table" (or switching back to YAML, which recompiles) overwrites it.
Separately, `switchToTable` resets to `QLL_DEFAULTS` when no comment is found, and the next table save replaces custom YAML with defaults without a warning. Admin automation is lost without notice.
Fix: Store the table's source of truth separately from the rule text (a `mapping_json` column on the rule-set version), or embed a hash of the compiled YAML in the comment and treat a mismatch as "custom YAML" (open in YAML mode, table disabled). Ask for confirmation before a table save replaces a non-table rule set.

### F12 [MINOR] Manual user links are unvalidated, and actors are resolved by login instead of GitHub id
File: src/app/context.ts:43
Spec: §9, §7.2
Evidence: `PUT /user-links/:planeUserId` (`src/ui/api.ts:301`) still inserts whatever `githubLogin`/`githubId` the admin sends. There is no `GET /users/{login}` id check and no membership check, even though both were in round 1's Fix. Lookups use `lower(gh_login) = lower($2)` although the table is unique on `(workspace_slug, gh_id)` and every event carries `sender.id`. Consequences:
- A user who renames on GitHub loses attribution.
- The email re-link then conflicts on `gh_id`.
- Someone who registers the freed old login is attributed as the Plane user.
Also, `DELETE /user-links` does not stick: the next event from that sender re-links by email after the 10-minute throttle.
Fix: Resolve actors by `sender.id` (`gh_id`) and refresh `gh_login` on match. Validate manual links against `GET /users/{login}` (id must match) and workspace membership. Record an "unlinked by admin" tombstone that suppresses email auto-linking for that pair.

### F13 [MINOR] Queued-write failures are misclassified and invisible to the delivery's audit and replay
File: src/sync/plane.ts:157
Spec: §7.6, §4
Evidence:
- **Permanent errors retried for hours.** `#guardState` throws a plain `Error("unknown Plane state id …")`, which `isPermanentWriteError` does not treat as permanent, so a state deleted after enqueue is retried 30 times over ~3.8 h.
- **Transient errors dropped.** Any 401 is treated as permanent, e.g. during an F6 credential rotation, so the write is dropped at once.
- **Bad installation id queued.** `handlePlaneIssue` builds deps with `installationFor(…).catch(() => 0)`, so GitHub writes are queued with `installationId: 0` while the delivery records `handled`.
- **Audit says applied.** `runRules` audits `rule_match … applied` once writes are *queued*. A later final failure is only an `outbound_write_failed` row without target, workspace or delivery id. Replay (`tooling.ts:89`) accepts only `inbound_delivery` rows, so §7.6 "failed deliveries are replayable" does not cover failed writes.
Fix: Throw a typed permanent error from `#guardState`. Treat 401 as retriable for a bounded number of attempts. Fail the delivery when the installation cannot be resolved. Carry `deliveryId`, workspace and target in the job data and in `outbound_write_failed`. Offer replay of a failed outbound job from the operations UI.

### F14 [MINOR] The >20-commit range lookup is not wired, so large pushes still drop Smart Commits
File: src/github/smart-commits.ts:201
Spec: §7.2
Evidence: `SmartCommitDeps.listCommitRange` is supplied only by tests. `src/app/push.ts:37-51` builds the deps without it, so every push of 20+ commits takes `if (!deps.listCommitRange) { await audit("smart_commit_truncated", …); return listed; }`. Commands in commits 21+ are now audited but still never applied (prev F18).
Fix: In `src/app/push.ts`, implement `listCommitRange` with the installation Octokit: `GET /repos/{owner}/{repo}/compare/{before}...{after}`, paginating over `commits`, mapped to `PushCommit`. Add a wiring test through `handlePush`.

### F15 [MINOR] App-credential source is not reported, and two fallbacks defeat a rotation
File: src/ui/api.ts:479
Spec: §8, §9
Evidence: `/instance/health` still reports `githubAppConfigured: app.rows.length > 0`: it does not say whether the stored row or the environment is in use, nor that the row fails to decrypt (in which case every GitHub webhook answers 500). `src/app/credentials.ts:40-43` falls back to the environment `GITHUB_WEBHOOK_SECRET` when the database is unreachable at cold start. If the secret was rotated in the UI because it leaked, the leaked secret is accepted during the outage. A `ghe_base_url` cleared in the UI falls back to the environment `GITHUB_API_BASE_URL`, so clearing it has no effect.
Fix: Report `{ source: "database" | "environment", decryptOk }` from the credential source actually used. Once a database row has ever been read, refuse verification (503) rather than fall back to the environment secret. Treat a null stored URL as "github.com" when a row exists.

### F16 [MINOR] The Smart Commit advisory lock has no timeout and can stall a replica's whole GitHub inbound queue
File: src/github/smart-commits.ts:181
Spec: §5, §4
Evidence: `SELECT pg_advisory_lock(hashtextextended($1, 0))` waits indefinitely. If another replica hangs inside the locked section (a Plane request that never returns), this replica's `inbound-github` worker blocks. It has `concurrency: 1`, so it processes no other GitHub delivery until the holder's connection dies.
Fix: Use `pg_try_advisory_lock` in a bounded loop, or `SET lock_timeout` on that connection, and throw a retriable error on timeout. Give Plane requests a hard per-request timeout.

### F17 [MINOR] Link writes record no echo op, so Plane-side rules can run on our own rollup writes
File: src/sync/plane.ts:208
Spec: §5, §7.5
Evidence: `add_link`/`update_link` record nothing in `applied_ops`. Writes made with a user's PAT carry that user as actor, so the `PLANE_SERVICE_USER_ID` check does not drop their echoes. That variable is optional (`src/config/env.ts`). If Plane emits an `issue` delivery for link activity, `planeRuleEvent` turns it into `issue.updated` and `handlePlaneIssue` runs rules on our own rollup write. This does not loop (re-adding a link is deduplicated), but it causes spurious rule runs. Unconfirmed against Plane: the probe did not exercise link activity.
Fix: Probe link activity on v1.4.2. If it is emitted, record an op for link writes, keyed on the field Plane reports. Make `PLANE_SERVICE_USER_ID` required in `deploy/git-sync.env.example` and in config validation.
