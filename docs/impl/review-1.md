# Implementation review — round 1

VERDICT: BLOCKING

Reviewed the working tree (uncommitted) against the spec, the plan parts, HANDOFF.md's four pitfalls,
the leaf briefs and `.unlazy/impl/evidence/plane-webhook-probe.md`. Every driver oracle passes and the
full suite passes (`node scripts/run-tests.mjs 1 tests` → `tests passed (420 tests in 36 files)`).
Plane payload claims below were checked against the source of the running v1.4.2 test instance
(`docker exec plane-test-api-1 …/code/plane`), not inferred.

## Task verdicts
- A1: PASS — `docker-compose.override.yaml` joins `default` + external `gateway` with alias `git-sync`, healthcheck hits `/git-sync/healthz` on :3100; Caddy stanza and `deploy/APPLY.md` match §3.
- A2: PASS — Plane HMAC is hex SHA-256 over the raw body compared with `timingSafeEqual`; Plane signs `json.dumps(payload)` and posts with `requests` `json=` (same serialisation, checked in `utils/url_security.py` / `bgtasks/webhook_task.py`), GitHub uses `@octokit/webhooks-methods`; handler only verifies, enqueues with `jobId = source-deliveryId`, returns 200.
- A3: PASS — `sync_links` (tier, created_by, status/orphaned_at), field-granular `applied_ops`, `webhook_deliveries`, `processed_commits`, `audit_log`, config tables all present; migrations apply (verify-a3-schema).
- A4: FINDINGS — F9, F13
- A5: FINDINGS — F1
- A6: PASS — first-match-wins, full §7.5 action vocabulary, `run(..., {dryRun:true})` never calls the executor (dry-run uses a throwing executor); the runtime-wiring gap for non-PR triggers is filed against B5 (F7).
- A7: FINDINGS — F17
- A8: FINDINGS — F10
- B1: FINDINGS — F6
- B2: FINDINGS — F15
- B3: FINDINGS — F2, F11
- B4: FINDINGS — F8, F16, F18
- B5: FINDINGS — F7, F14
- B6: FINDINGS — F4, F5, F13
- B7: PASS — one Plane link per rollup key held in `dev_info_links`, edited in place via `update_link`, re-added on 404, duplicate-URL 400 recovered through `findLinkId`; Jira vocabulary (OPEN/MERGED/DECLINED, REVIEW/APPROVAL/REJECTED, build pass/fail); providers Vercel/Netlify/Cloudflare Pages/Amplify + "…Preview" markdown links.
- B8: FINDINGS — F3
- B9: FINDINGS — F12

### Driver adjudication items
- **B6 Plane→GitHub labels carry UUIDs** — confirmed broken, worse than stated: the reducer also ignores the web app's `label_ids` / `assignee_ids` fields. F4.
- **B4 claim-before-write (at-most-once)** — not compatible with §5 "processed exactly once": a transient Plane failure silently and permanently drops the command, and replay cannot recover it. F8.
- **B6 duplicate-create race and assignee removal** — the GitHub-side race is fixed (advisory lock `gh:{repo}#{n}` + partial unique index `uq_sync_links_label_sync`); a narrow cross-direction window remains because `create_issue` records only the `created` op (F13, MINOR). Assignee removal is only partly fixed: clearing all assignees is ignored and unmapped GitHub assignees are stripped. F5.
- **B2 iframe renders while permissions load** — real but not a security hole: every config-API call (GET included) re-authenticates against Plane, so the early iframe shows only a shell that then gets 403s. F15, MINOR.
- **A5 403 on unknown project key** — confirmed in two resolvers (`resolveReferences` and `issueResolver`); a PR or branch naming a project the service account cannot see fails the whole delivery. F1, BLOCKING.
- **A8/B6 echo-loop label tolerance** — the test feeds a Plane payload shape Plane never sends (`activity.new_value: "bug"`). Correct behaviour: our own label write echoes back as `field: "labels"` with exactly the id array we sent, so it must hash-match and cause **zero** extra writes; a human label edit arrives as `label_ids` (web app) or `labels` (API) id arrays and must be diffed and resolved to names. The `<= 1` tolerance must become `=== 0`. F10.
- **Smart Commit `#time` as a comment** — PASS. Plane CE v1.4.2 exposes no worklog endpoint, §7.2 says "comment attached automatically", and the rule engine's `log_time` uses the same rendering, so the two surfaces agree.

## Findings

### F1 [BLOCKING] A 403 from the identifier endpoint fails the whole delivery
File: src/parse/references.ts:122
Spec: §6, §1.2, §7.2
Evidence: The evidence file's live smoke test measured `GET /api/v1/workspaces/gitsync-test/issues/ZZZZ-1/` → **403** `{"detail": "You do not have permission…"}` for a project that does not exist or the service account is not a member of. `resolveReferences` treats only 404 as unknown (`if (err instanceof PlaneApiError && err.status === 404) cache.set(r.identifier, null); else throw err;`), and `issueResolver` in `src/app/context.ts:97` does the same. Consequences, by reading the callers: `handleForMapping` (`src/app/pr.ts`) and `branchPushed` (`src/app/push.ts`) let the error escape, `processInbound` forgets the delivery and BullMQ retries 5 times, then the delivery is permanently failed. So any PR whose title/body/branch contains `Fixes JIRA-12`, `HOTFIX-2`, or a key from a project the least-privileged service account (§9) is not a member of loses **all** automation — linking, state rules, rollups, linkback — for every linked item, not just the unknown one. Backfill (`ops.resolveIssue`) answers 500 for the same reason. `tests/smoke/live-smoke.test.ts:58` still asserts `strictEqual(missing, 404)` and would fail live.
Fix: Treat 403 (and 404) from `GET /workspaces/{slug}/issues/{KEY}/` as "unknown or inaccessible" in both `resolveReferences` and `issueResolver`, record it in the `reference_unresolved` audit row with the status, keep 5xx/network errors throwing; change the smoke test to expect 403 for an unknown project and 404 for an unknown sequence; add an offline test where one of two refs answers 403 and the other still links.

### F2 [BLOCKING] Mapping writes are not authorised against the workspace or the GitHub installation
File: src/ui/api.ts:148
Spec: §8, §9, §3
Evidence: `POST /mappings` and `PATCH /mappings/:id` accept any `ghRepoId`, `ghRepoFullName` and `planeProjectId` that pass a format check (`parseMappingInput` in `src/ui/validate.ts`); nothing checks that the project belongs to the workspace in the path or that the repository is one this workspace is entitled to. At runtime `mappingsForProject` (`src/app/mappings.ts:33`) selects by `plane_project_id` alone and `handlePlaneIssue` never compares the payload's `workspace_slug` with `mapping.workspaceSlug`. Therefore an admin of workspace A can (a) map workspace B's project UUID to a repo A controls and receive B's `github`-labelled items and every B comment as GitHub issues/comments (cross-workspace data exfiltration), and (b) map any repository the App is installed on and then, by labelling a Plane item `github`, create issues and comments in that repository with the App's installation token — escalation from "Plane workspace admin" to "write access to every repo the App can reach". §8's role check is necessary but not sufficient.
Fix: On create/update, verify the project via Plane (`GET /api/v1/workspaces/{slug}/projects/{pid}/` with the service PAT, 404 → 422) and verify the repo through the App (`GET /repos/{owner}/{repo}` via `installationIdFor`, require `data.id === ghRepoId` and full name match; optionally restrict to installations an instance admin has allow-listed for that workspace). At runtime also filter `mappingsForProject` by the payload's `workspace_slug`. Add tests for both refusals.

### F3 [BLOCKING] Backfill creates issue links that the mirror then treats as opted-in, silently two-way syncing unrelated items
File: src/operations/tooling.ts:143
Spec: §7.3, §7.6, §6
Evidence: `backfill` calls `upsertSyncLink({ ..., ghKind: kind, createdBy: "magic_word" })` with `kind = "issue"` for every open GitHub issue whose title/body merely mentions a key (bare keys in bodies are `relation` tier). The mirror's `findLinkByGithub` (`src/sync/mirror.ts:77`) matches `gh_kind = 'issue' AND status = 'active' AND plane_project_id = $3` and ignores `created_by`/tier, so after a backfill every such GitHub issue is a mirror partner: an edit of its title/body overwrites the Plane item's name/description (default `source_of_truth:github`), closing it moves the Plane item to `completed` (`last_write_wins`), and its comments are copied into Plane — all without the `plane` opt-in label §7.3 requires. A GitHub bug report saying "see also WEB-12" would rename and close WEB-12. Silent corruption of Plane data.
Fix: Restrict mirroring to links with `created_by = 'label_sync'` (both `findLinkByGithub` and `findLinkByPlane`), or have backfill record issue references with a distinct kind that the mirror never reads. Add a test: backfill links issue #5 to WEB-12, then an `issues.edited`/`closed` delivery for #5 produces no Plane write.

### F4 [MAJOR] Plane→GitHub label and assignee sync never fires on real Plane payloads
File: src/sync/mirror.ts:292
Spec: §7.3, §1.3
Evidence: Plane's `model_activity` emits `field` = the request-body key and `new_value` = the requested value. The API sends `labels`/`assignees` as UUID arrays (probe evidence: `labels` `["95a4…"] → ["95a4…","1f10…"]`), and the web app's `IssueCreateSerializer` (`app/serializers/issue.py:90,95`) uses `label_ids`/`assignee_ids`/`state_id`. The reducer handles `case "labels"` only when `new_value` is a **string** and has no `label_ids`/`assignee_ids` case at all. Probe (scratch script calling `onPlaneIssue` with real shapes on a linked item):
`labels {"action":"ignored","reason":"no label change to mirror"}` / `label_ids … "field label_ids is not mirrored"` / `assignee_ids … "field assignee_ids is not mirrored"` / `github writes: 0`.
So every human label/assignee change in Plane's UI is dropped, contradicting §7.3's synced-field list.
Fix: Handle `labels` and `label_ids` as id arrays: diff `old_value`/`new_value`, resolve ids to names from `data.labels` (the webhook's `IssueExpandSerializer` is called with `expand: ["labels","assignees"]`, so names are already present) or `GET …/labels/`, then `add_labels`/`remove_label`, skipping the `github` gate label. Handle `assignee_ids` like `assignees`. Cover with fixtures copied from real deliveries.

### F5 [MAJOR] Assignee removal is incomplete and strips GitHub assignees Plane cannot represent
File: src/app/issues.ts:25
Spec: §7.3, §9
Evidence: `onPlaneIssue` returns `ignored("no assignee has a linked GitHub account")` when the mapped login list is empty (`src/sync/mirror.ts:309`), so unassigning the last person in Plane never reaches GitHub. Conversely `assigneeSyncWriter` computes `remove = current.filter((a) => !wanted.has(a))`, where `wanted` contains only *mapped* users; any GitHub assignee without a user-map row (by §7.3 Plane can never hold them) is removed from GitHub the next time anyone changes Plane's assignees.
Fix: Compute the GitHub diff only over logins that are in the workspace user map (leave unmapped GitHub assignees untouched), and when Plane's mapped set becomes empty, remove the mapped GitHub assignees instead of ignoring the event. Test both cases.

### F6 [MAJOR] GitHub App credentials saved in the instance-admin UI are never used
File: src/ui/api.ts:389
Spec: §8, §9
Evidence: `PUT /instance/github-app` encrypts and stores app id, private key, webhook secret and GHE URL in `github_app_config`, and `/instance/health` reports `githubAppConfigured: true` from that row. The running service never reads the table: `src/app/main.ts:34` builds the App client from `config.GITHUB_APP_ID` / `GITHUB_PRIVATE_KEY_PATH` / `GITHUB_API_BASE_URL`, and GitHub signatures are verified with `config.GITHUB_WEBHOOK_SECRET` (`grep github_app_config src` hits only `src/ui/api.ts`). An operator rotating the webhook secret or key in the admin UI (§8's "GitHub App credentials" surface) changes nothing, while health says it is configured.
Fix: Make one source authoritative: load App credentials from `github_app_config` (decrypting with the token key) with env as bootstrap fallback, and re-read on change (or require restart and say so in the UI); report health from the credentials actually in use.

### F7 [MAJOR] Only PR lifecycle and branch-create events ever reach the rule engine
File: src/app/rules.ts:30
Spec: §7.5, §7.1
Evidence: `runRules` has exactly two callers (`src/app/pr.ts`, `src/app/push.ts` → `branchPushed`, which returns unless the push created the branch). No code produces `commit.pushed_to_default`, `check_suite.*`, `deployment_status.*`, `issue.*` or `comment.*` rule events (`grep -rn "pushed_to_default\|runRules(" src`), although the engine accepts them and the rules editor invites them. A rule such as `when: deployment_status.success … set_state: Deployed` saves, dry-runs and then never fires in production.
Fix: Map `push` to the default branch → `commit.pushed_to_default`, `check_suite`/`check_run` → `check_suite.<conclusion>`, `deployment_status` → `deployment_status.<state>`, `issues`/`issue_comment` → `issue.<action>`/`comment.<action>`, resolving linked items from `sync_links`, and call `runRules` from `handleChecks`/`handleGithubIssue`/`handlePush`; extend `toRuleEvent` so dry-run sees the same mapping.

### F8 [MAJOR] Smart Commits are at-most-once: a transient failure loses the command forever
File: src/github/smart-commits.ts:180
Spec: §5, §7.2
Evidence: `claimCommit` inserts the SHA before any write; each write failure is only appended as `smart_commit_failed` (`attempt` swallows the error) and the delivery completes. A Plane 5xx/429 that outlasts `PlaneClient`'s retries, a network blip, or a crash after the claim means the `#done`/`#comment` is never applied, and B8 replay cannot help because the SHA is already claimed. §5 requires "processed exactly once"; the at-most-once design trades the Jira duplicate bug for silent loss.
Fix: Record success per command (e.g. `processed_commits` keyed `(sha, key, command_index)` or a status column `pending → done`), claim before and mark done after each write; on a retriable error (network, 5xx, 429) leave it pending and rethrow so the delivery retries, on a permanent error (unknown state, 4xx) mark it failed and audit. Retries then skip only the commands already done.

### F9 [MAJOR] The outbound queues are dead; writes run inline, so a short outage permanently fails deliveries
File: src/queue/workers.ts:129
Spec: §4, §9
Evidence: Nothing enqueues to `outbound-plane` / `outbound-github` (`grep -rn "outboundPlane\|outboundGithub" src` shows only the queue declarations and these two workers); every reducer calls `ctx.plane.apply` / `ctx.github.apply` directly inside the inbound job. The 50/minute limiter therefore never applies, and §4's isolation ("separated so one side's outage cannot stall the other") does not hold: during a Plane restart, every `inbound-github` job exhausts 5 attempts (2 s exponential backoff ≈ 30 s plus the client's own ~31 s retries per attempt) and lands in failed state; recovery is a manual per-delivery replay.
Fix: Have reducers enqueue `PlaneWrite`/`GithubWrite` jobs on the outbound queues (op recording stays inside `apply`, which already runs in those workers), give outbound jobs long-horizon retries, and keep inbound jobs short. If inline writes are kept deliberately, delete the outbound workers, raise inbound attempts/backoff to cover an outage, and amend the plan/spec.

### F10 [MAJOR] The echo-loop suite certifies payload shapes Plane never sends
File: tests/a8/echo-loop.test.ts:142
Spec: §10, §5, §1.3
Evidence: The "labels terminate" test feeds `planeUpdate("labels", "bug", …)` — a string `new_value` — and tolerates `after.length - before <= 1` with the comment "Plane reports the added label by name". The probe evidence shows Plane sends UUID arrays, and the web app sends `label_ids`. With real shapes the GitHub→Plane label write's echo (`field: "labels"`, `new_value` = the exact id array sent) hashes identically and must be dropped with **zero** writes, while the human-edit path is broken (F4) — the test passes on both counts for the wrong reason. Line 102 uses the same invented `new_value: "github"`.
Fix: Rebuild Plane fixtures from recorded deliveries (`activity.field` ∈ `labels`/`label_ids`/`assignee_ids`/`state_id`, array `new_value`, expanded `data.labels`), assert `=== 0` extra writes for the echo, and add a separate human-edit test that asserts the GitHub label is added/removed.

### F11 [MAJOR] The lifecycle→state mapping table UI does not exist; admins must write YAML
File: src/ui/client/Workspace.tsx:272
Spec: §7.1, §8
Evidence: §7.1: "the simple lifecycle→state mapping table is presentation sugar that compiles down to ordered rules, so an admin who only wants 'merged → Done' never sees rule syntax". The workspace UI offers only a `Rules (YAML)` textarea; `compileLifecycleRules` is used solely to produce the server-side default. When no rule set is saved the editor shows an empty YAML box even though `QLL_DEFAULTS` are active at runtime, so the admin cannot see what is in effect.
Fix: Add the mapping form (lifecycle point → state target, base-branch rules) that calls `compileLifecycleRules` and saves the result through the same `PUT …/rules`, and prefill the editor with the compiled defaults when no version exists.

### F12 [MAJOR] §9 email-based user matching is implemented but never called
File: src/auth/identity.ts:34
Spec: §9, §7.2
Evidence: `matchPlaneUserByEmail` has no caller outside `src/auth` (`grep -rn matchPlaneUserByEmail src`). The only way to populate `user_map` is `PUT /user-links/:planeUserId`, where a workspace admin types any `githubLogin`/`githubId` pair; nothing checks the GitHub account exists, matches the id, or that the Plane user is a workspace member. B9's acceptance ("resolves exact email matches") and §9's "match GitHub accounts to Plane users by email, requiring exactly one match … zero or several is a loud audit-log failure" are not delivered.
Fix: Add a "suggest/link by email" action: fetch the GitHub user's verified emails (OAuth or org member API) and the workspace members (`/workspaces/{slug}/members/`), call `matchPlaneUserByEmail`, link on exactly one match, and audit `none`/`multiple`. Validate manual links against `GET /users/{login}` (id must match).

### F13 [MINOR] Create-type writes record their echo op only after the response
File: src/sync/plane.ts:176
Spec: §5
Evidence: `create_issue` and `add_comment` (`src/sync/plane.ts:182`) call `#recordCreated` after the POST returns, and GitHub `create_issue` (`src/sync/github.ts:77`) records only `created` — not the `labeled` events GitHub fires for each initial label. If the echo is processed before the record (or for each initial label), it is handled as a human event; with no link row yet, a `labeled: plane` echo of an issue we just created from Plane passes the gate and creates a duplicate Plane item. The window is small (two DB round-trips) and closed entirely only when `PLANE_SERVICE_USER_ID` is set for Plane-side echoes.
Fix: For GitHub `create_issue`, record `label:<name>` ops for every initial label alongside `created`; take the `gh:{repo}#{n}` object lock (or upsert the link) before releasing control after a GitHub create; document `PLANE_SERVICE_USER_ID` as required in `deploy/git-sync.env.example`.

### F14 [MINOR] The `ready_for_merge` lifecycle point can be configured but never fires
File: src/github/pr-automation.ts:118
Spec: §7.1
Evidence: `LIFECYCLES` and `TRIGGER` include `ready_for_merge` → `pull_request.ready_for_merge`, but `prEventToRuleEvent` never returns it (no case derives it from approval + green checks / `mergeable_state: "clean"`), so a rule on it is dead.
Fix: Emit `pull_request.ready_for_merge` when a review approval or check completion leaves the PR approved with all checks passing (or remove the point from the vocabulary and the docs).

### F15 [MINOR] The workspace iframe renders before the workspace role is known
File: apps/web/app/(all)/[workspaceSlug]/(settings)/settings/(workspace)/git-sync/page.tsx:16
Spec: §8
Evidence: `if (workspaceUserInfo && !canPerformWorkspaceAdminActions)` lets the iframe mount while `workspaceUserInfo` is still undefined; a non-admin sees the config shell flash and then a page of 403 errors. Not a security hole — every config-API route, GET included, re-checks the role against Plane — but §8 and B2 say role is checked "before rendering".
Fix: Render a loader while `workspaceUserInfo` is undefined, then `NotAuthorizedView` or the iframe.

### F16 [MINOR] Smart Commit claim is global per SHA, so a repo mapped into two workspaces processes commands only once
File: src/github/smart-commits.ts:180
Spec: §5, §7.2
Evidence: `handlePush` loops over every mapping of the repo and calls `processPush` for each, but `processed_commits.sha` is the primary key, so the first mapping claims the SHA and the second mapping's keys (another workspace's project) are skipped as duplicates.
Fix: Claim on `(sha, workspace_slug)` (still one effect per workspace, still immune to fork/branch re-delivery).

### F17 [MINOR] Idempotency ledgers and audit payloads grow without bound; TTL changes need a restart
File: src/db/ledgers.ts:4
Spec: §5, §7.6, §1.3
Evidence: The maintenance queue prunes only `applied_ops`; `webhook_deliveries`, `processed_commits` and `audit_log` (which stores the full payload of every delivery) are never pruned. `opTtlMinutes` for ingress is read once at startup (`src/app/main.ts:86`), so changing `op_ttl_minutes` in the admin UI affects pruning but not echo matching until restart.
Fix: Add retention jobs (e.g. deliveries 30 days, audit payloads 90 days, processed commits ≥ the rebase horizon you want to guard) to `startMaintenance`, and read the TTL per job or on a short cache.

### F18 [MINOR] Pushes with more than 20 commits drop the Smart Commits beyond the payload
File: src/github/smart-commits.ts:158
Spec: §7.2
Evidence: GitHub's `push` payload lists at most 20 commits; `processPush` iterates `payload.commits` only, so commands in the 21st and later commits of a large push are never seen.
Fix: When `commits.length === 20` (or `compare` shows more), list the range with `GET /repos/{owner}/{repo}/compare/{before}...{after}` and process every commit.
