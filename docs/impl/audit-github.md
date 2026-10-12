# Docs audit: GitHub

VERDICT: 0 BLOCKING, 15 MAJOR, 1 MINOR

Report-only audit against Context7 documentation fetched on 2026-10-12 with the brief's `npx ctx7@latest library` and `npx ctx7@latest docs` commands. Reviewed all requested files, then followed their GitHub calls into composition, routing, mirroring, queues, outbox execution, backfill, and UI lookup. The design spec defines intent; `docs/research/findings-github.md` was checked as a set of claims. No live GitHub mutation, source edit, test suite, oracle, staging, commit, or push was performed. App registration and installed permissions were not inspected remotely: the permissions comparison below concerns what this code needs and what the research recommends.

### A1 [MAJOR] Manual user linking uses an App client without installation authentication

File: src/app/github.ts:35; src/app/main.ts:66; src/ui/mapping-check.ts:86

Doc: `/octokit/auth-app.js` — "- **installationId** (number) - Required for type \"installation\" (unless default provided) - The ID of the installation." [Context7 source: auth-app README](https://github.com/octokit/auth-app.js/blob/main/README.md).

Code: `return (await load()).octokit.request(route, params) as Promise<{ data: any }>;`

Impact: The manually linked user's `GET /users/{username}` goes through this client, constructed with only App ID/private key. This route is an installation-token route, not a JWT route. The installed `@octokit/auth-app` hook selects installation authentication and throws `installationId option is required for installation authentication` before issuing HTTP. Manual user links therefore fail even with valid App credentials. The automatic email path uses an installation client and does not have this defect.

Fix: Resolve public profile IDs through an unauthenticated client where appropriate, or through a workspace-authorized installation client. Keep JWT requests for App endpoints such as repository-installation discovery. Preserve authenticated installation lookup for automatic public-email matching and Enterprise Managed Users.

### A2 [MAJOR] Headerless secondary limits become permanent permission failures

File: src/sync/github.ts:70; src/queue/workers.ts:195; src/app/issues.ts:193; src/github/pr-automation.ts:302

Doc: `/websites/github_en_rest` — "error message that indicates that you exceeded a secondary rate limit"; "Otherwise, wait for at least one minute before retrying." [Context7 source: rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

Code: `const limited = status === 429 || (status === 403 && (get("retry-after") !== undefined || get("x-ratelimit-remaining") === "0"));`

Impact: GitHub can signal a secondary limit with `403`, a nonzero remaining primary quota, and no `retry-after`. The response message identifies it, but every listed classifier ignores that message. Writes become terminal failures; installation discovery can report the App absent; combined-status readiness can quietly return unavailable. For headerless `429`, the write path does retry, but its fallback starts at one second instead of the documented minute.

Fix: Share a GitHub error classifier that recognizes the documented secondary-limit response message as well as status/headers, keeps permission errors distinct, and uses a minimum 60-second exponential fallback for secondary limits. Use it in writes, discovery, readiness, mapping validation, and worker/outbox classification.

### A3 [MAJOR] The header wait cap retries before GitHub permits another request

File: src/sync/backoff.ts:2; src/sync/backoff.ts:22; src/sync/backoff.ts:28

Doc: `/websites/github_en_rest` — "If the `retry-after` response header is present, you should not retry your request until after that many seconds has elapsed." [Context7 source: REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api).

Code: `if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_HEADER_WAIT_MS);`

Impact: `MAX_HEADER_WAIT_MS` is five minutes; the reset-header branch has the same cap. A `retry-after: 900`, or exhausted primary quota resetting in 45 minutes, causes another request after five minutes. Repeated premature requests consume attempts and prolong throttling; GitHub documents that continued requests during a limit can lead to a ban.

Fix: Honor the entire server deadline. Persist a delayed job/outbox retry time instead of sleeping while holding execution resources. If a local retry window cannot accommodate the deadline, surface that limitation without sending another request early.

### A4 [MAJOR] GitHub reads retry through queues without honoring response deadlines

File: src/app/checks.ts:95; src/github/pr-automation.ts:253; src/queue/index.ts:37; src/operations/outbox.ts:459

Doc: `/websites/github_en_rest` — `const secondsToWait = resetTimeEpochSeconds - currentTimeEpochSeconds;` [Context7 source: header-aware REST retry example](https://docs.github.com/en/rest/guides/scripting-with-the-rest-api-and-javascript).

Code: `backoff: { type: "exponential", delay: 2000 },`

Impact: Commit verification, compare, PR association, reviews, suites, and combined-status reads call `octokit.request` directly. Propagated primary-limit errors replay their inbound delivery after two seconds, then four, etc., even when reset is much later. Reads during outbox continuations/assignee diffing instead use the outbox's generic five-second-based schedule. Neither schedule carries GitHub's response deadline. The installed `@octokit/app` uses bare `@octokit/core`; these clients have no throttling plugin to compensate. Other read catches can also finish with incomplete rollups/readiness rather than retrying.

Fix: Wrap all GitHub requests, including JWT/token acquisition and UI/backfill reads, with the same header-aware policy. Carry the required retry time into the inbound queue and ordered outbox; coordinate it per installation so another job cannot continue hitting the exhausted quota.

### A5 [MAJOR] Build rollups inspect only the first 100 check runs

File: src/app/checks.ts:95

Doc: `/websites/github_en_rest` — "- **page** (integer) - Optional - The page number of the results to fetch. Default: `1`." [Context7 source: check runs](https://docs.github.com/en/rest/checks/runs).

Code: `const res = await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", { ...base, ref: sha, per_page: 100 });`

Impact: A CI matrix with more than 100 current runs can have its pending/failing run on page two. `buildStatus` can publish `Build · pass` because only page one is inspected. `per_page: 100` increases one page's size; it does not exhaust the collection.

Fix: Paginate `check_runs`, keeping the documented default `filter=latest`, before computing the aggregate. For references exceeding GitHub's separate 1,000-suite limit on this endpoint, enumerate suites and their runs, or explicitly report the aggregation incomplete.

### A6 [MAJOR] Review rollups retain old decisions after the first 100 reviews

File: src/app/pr.ts:49

Doc: `/websites/github_en_rest` — "The list of reviews returns in chronological order." [Context7 source: PR reviews](https://docs.github.com/en/rest/pulls/reviews).

Code: `const res = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews", { owner: mapping.owner, repo: mapping.repo, pull_number: number, per_page: 100 });`

Impact: `reviewsOf` returns only the earliest 100 reviews. A later approval, change request, or dismissal never reaches `reviewStatus`; the Plane PR link can show APPROVAL while a reviewer now requests changes, or REJECTED after approval. The separately paginated readiness reader does not repair this display path.

Fix: Share a complete chronological review reader between rollups and readiness, with an explicit incomplete/error result rather than silently treating the first page as all reviews.

### A7 [MAJOR] Commit association discovery is incomplete for readiness and deployments

File: src/app/checks.ts:81; src/app/checks.ts:115

Doc: `/websites/github_en_rest` — the association endpoint's `per_page` has "Default: `30`." It "Lists the merged pull request that introduced the commit to the repository." [Context7 source: commits and associated PRs](https://docs.github.com/en/rest/commits/commits).

Code: `const res = await octokit.request("GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls", { ...base, commit_sha: sha });`

Impact: Both callers take a single default page, silently missing associated PRs beyond 30. Independently, the endpoint returns the introducing merged PR when a SHA is already in the default branch; it is not a universal list of open PRs headed by that SHA. An open PR to another base branch sharing an already-merged head can miss its readiness transition. Deployment association should also be understood as this documented introducing-PR lookup rather than all historical PRs containing a commit.

Fix: Paginate association results. For readiness, also enumerate the mapped repository's locally linked open PRs and fetch their current head SHAs; require an exact SHA match. Define deployment association deliberately, and query linked PR state when broader association is intended.

### A8 [MAJOR] Large Smart Commit comparisons stop silently at 3,000 commits

File: src/app/push.ts:67; src/github/smart-commits.ts:289

Doc: `/websites/github_en_rest` — compare pagination uses "The number of results per page (max 100)." [Context7 source: compare commits](https://docs.github.com/en/rest/commits/commits).

Code: `for (let page = 1; page <= 30; page++) { // compare returns at most 250 commits per page`

Impact: This requests 100 commits per page, so the adapter returns at most 3,000. The Smart Commit module's 10,000-commit bound never detects this earlier cap. A larger bulk push is processed as if the fetched range were complete; appending the webhook's bounded subset cannot guarantee recovery of omitted commits. Commands on missing commits are lost without the promised truncation audit. The comment confuses the unpaginated 250-commit limit with paginated results; nearby 20-commit comments are also stale.

Fix: Follow pagination to completion or a deliberate bound, and return completeness metadata. On hitting the bound, audit explicit truncation or fail retriably rather than returning an apparently complete array. Keep chronological ordering and de-duplication; correct the comments to the current 2,048 webhook limit and 100-per-page maximum.

### A9 [MAJOR] Fork PR checks are dropped when GitHub supplies no associated PRs

File: src/app/checks.ts:93; src/app/checks.ts:94

Doc: `/websites/github_en_rest` — fork pushes "return an empty pull\\_requests array." [Context7 source: check suites](https://docs.github.com/en/rest/checks/suites).

Code: `if (typeof sha !== "string" || prs.length === 0) return;`

Impact: For documented fork cases, the build handler returns before writing a CI rollup or running `check_suite.<conclusion>` rules on the fork PR's linked items. The later readiness lookup is a different path and does not recover these skipped build links or suite rules.

Fix: Resolve candidate PRs by SHA through paginated commit association and/or current heads of locally linked PRs when the payload array is empty. Use the base repository's installation authority and verify candidate head/repository identities before targeting items.

### A10 [MAJOR] GitHub snapshots can overwrite newer state when deliveries arrive out of order

File: src/app/issues.ts:165; src/sync/mirror.ts:240; src/sync/mirror.ts:262; src/app/pr.ts:234

Doc: `/websites/github_en` — "GitHub may deliver webhooks in a different order than the order in which the events took place." [Context7 source: troubleshooting webhook ordering](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks).

Code: `const r = await update("title", { name: String(issue.title ?? "") });`

Impact: The App reducer applies the delivered issue snapshot through `sync/mirror.ts`, without a source-version/timestamp comparison or current GitHub read. If edit B arrives before older edit A, A becomes the final Plane title/body. Labels and assignees similarly replace complete lists from the old payload. PR lifecycle rules/rollups can regress on delayed opened/reopened snapshots, and old deployment statuses can replace newer rollups. Object locks and the ordered outbox serialize arrival/registration order, not GitHub occurrence order.

Fix: Reconcile current GitHub state for snapshot-driven mirror fields, or persist field/object version checks using documented payload timestamps. Give historical comments/Smart Commit commands their own immutable identities. Apply a deployment-specific ordering policy using deployment/status identities and creation times, and distinguish historical lifecycle actions from current-state reconciliation.

### A11 [MAJOR] GHES API support still generates links to github.com

File: src/app/checks.ts:105; src/app/checks.ts:128; src/app/push.ts:91; src/ui/client/github.ts:20

Doc: `/websites/github_en` — "GitHub Enterprise Server utilizes different URLs compared to GitHub Free, GitHub Pro, GitHub Team, and GitHub Enterprise Cloud." [Context7 source: GHES App URLs](https://docs.github.com/en/apps/sharing-github-apps/making-your-github-app-available-for-github-enterprise-server).

Code: ``url: `https://github.com/${mapping.ghRepoFullName}/pull/${pr.number}/checks`,``

Impact: Credentials correctly configure a GHES REST base URL, but CI links, branch links, and fallback deployment PR links point to an unrelated github.com repository. Browser-side repository/user ID lookup also always queries api.github.com and can resolve the wrong host's account/repository. API support therefore does not provide working GHES navigation or lookup.

Fix: Use verified `repository.html_url`/PR `html_url` for web links and retain the configured server origin for synthetic paths. Route browser lookups through the service using its configured API host and appropriate authority.

### A12 [MAJOR] Enabling autolinks never calls GitHub's autolink endpoint

File: src/ui/client/Workspace.tsx:178; src/ui/api.ts:218; src/app/mappings.ts:42

Doc: `/websites/github_en_rest` — `POST /repos/{owner}/{repo}/autolinks`; "The URL must contain <num> for the reference number." [Context7 source: repository autolinks](https://docs.github.com/en/rest/repos/autolinks).

Code: `linkback_enabled: input.linkbackComments, autolinks_enabled: input.autolinks,`

Impact: The UI promises “Create GitHub autolink references,” but create/edit only stores a flag. Searching the entire `src/` tree finds no autolink request or executor consuming the enabled setting. Giving the App the research's Administration permission cannot make `WEB-344` clickable; no platform operation is performed.

Fix: Add an authorized, durable autolink reconciliation operation when enabled, supplying `key_prefix`, a resolvable `url_template` containing `<num>`, and the intended numeric matching mode. Handle existing references/validation failures explicitly and require Administration write only for this operation. Until implemented, remove or disable the offered toggle.

### A13 [MAJOR] Every label-removal 404 is reported as successful removal

File: src/sync/github.ts:152

Doc: `/websites/github_en_rest` — "GitHub uses a `404 Not Found` response instead of a `403 Forbidden` response to avoid confirming the existence of private repositories." [Context7 source: REST 404 troubleshooting](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api).

Code: `if (write.kind === "remove_label" && (err?.status ?? err?.response?.status) === 404) return { ok: true };`

Impact: Repository access removal, an inaccessible/missing issue, and an absent label can all produce 404. The code records the outbox write complete in all cases without proving the desired label absence. Losing access to a private repository can thus be reported as a successful sync, with no failure to repair.

Fix: On 404, read the issue through the same installation authority. Declare success only if an accessible issue demonstrably lacks the label; otherwise preserve the access/resource failure and audit it.

### A14 [MAJOR] Installation lifecycle events never invalidate the remembered installation

File: src/app/context.ts:117; src/app/reducers.ts:15

Doc: `/websites/github_en` — the installation action is "Value: `created` (for installation) or `deleted` (for uninstallation)." [Context7 source: installation payload](https://docs.github.com/en/webhooks-and-events/webhooks/webhook-events-and-payloads).

Code: `if (id === null || id === undefined) id = await ctx.ghClient.installationIdFor(mapping.owner, mapping.repo);`

Impact: A remembered installation is reused indefinitely for Plane-origin work. The router handles neither `installation` nor `installation_repositories`, although GitHub sends them to Apps automatically. After uninstall/reinstall, the new installation's lifecycle delivery cannot replace or invalidate the old mapping ID. Even after the new installation is allow-listed, Plane-only work keeps trying the deleted installation until another repository webhook or a manual mapping update refreshes it. Its token-request 404 becomes a permanent write failure.

Fix: Handle lifecycle payloads using `installation.id` and the repository lists, invalidating cached mapping IDs on deletion/removal and re-resolving access on creation/addition without bypassing workspace allow-list approval. Refresh affected clients on permission acceptance; re-resolve a stale installation on a confirmed token/install lookup failure before admitting a new write.

### A15 [MAJOR] Marking an already approved draft ready does not evaluate merge readiness

File: src/app/pr.ts:276; src/app/pr.ts:278; src/github/pr-automation.ts:344

Doc: `/websites/github_en` — "When you're ready to get feedback on your pull request, you can mark your draft pull request as ready for review." [Context7 source: changing PR stage](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/changing-the-stage-of-a-pull-request).

Code: `if (approval && !deferred.pending) await fireReadyForMerge(ctx, mapping, job, await ctx.ghClient.installationOctokit(await installationFor(ctx, mapping, p)), pr);`

Impact: `approval` is true only for a submitted approving review. A draft whose reviews and checks already satisfy the service's readiness policy is correctly rejected while draft, but its later `ready_for_review` delivery only runs the opened lifecycle rule. With no new approval/check completion/status transition, `ready_for_merge` never fires. Reopening an otherwise ready PR has the same missing reevaluation.

Fix: Reevaluate current readiness after relevant PR stage changes, including `ready_for_review` and `reopened`, after their own lifecycle rules. Fetch current PR state/head before evaluating, retain the open/non-draft guards and once-per-head guard, and give deferred continuations the same behavior.

### A16 [MINOR] Other pagination guards return partial collections as complete

File: src/github/pr-automation.ts:262; src/github/pr-automation.ts:282; src/operations/tooling.ts:203

Doc: `/websites/github_en_rest` — "The `link` header contains URLs that you can use to fetch additional pages of results." [Context7 source: REST pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api).

Code: `if (items.length < 100 || (typeof total === "number" && all.length >= total) || page >= 20) break;`

Impact: Readiness silently stops at 2,000 suites or reviews, even when `total_count`/another page proves more exist. A later blocking suite/review can be ignored. Backfill likewise stops at 5,000 list entries and records `outcome: "done"`. These larger collections are uncommon, but safety bounds must not masquerade as exhaustive reads. Push-rule PR association already throws at its bound and provides a useful pattern.

Fix: Detect remaining pages at every safety bound and return an explicit incomplete result, or fail the read. Readiness must fail closed on incomplete collections; backfill must report partial progress and a resumable cursor.

## Verified correct

- Webhook signature algorithm: raw UTF-8 text reaches the Octokit HMAC-SHA256 verifier before JSON parsing; `X-Hub-Signature-256`, the `sha256=` prefix, and constant-time comparison match docs — `/websites/github_en`, `/octokit/octokit.js` ([validation](https://docs.github.com/en/webhooks/using-webhooks/securing-your-webhooks), [verifier](https://github.com/octokit/octokit.js/blob/main/_autodocs/api-reference/webhooks.md)).
- Webhook transport identity: ingress reads `x-github-delivery` and `x-github-event`, queues by delivery ID, and acknowledges only after enqueue — `/octokit/octokit.js` ([manual webhook handling](https://github.com/octokit/octokit.js/blob/main/_autodocs/api-reference/middleware.md)).
- Failed webhook delivery: code/runbook correctly state that 503 does not trigger automatic GitHub redelivery; operator redelivery is necessary — `/websites/github_en` ([failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)).
- App repository discovery: `GET /repos/{owner}/{repo}/installation` uses the JWT-capable App client and reads `data.id` — `/websites/github_en_rest` ([Apps](https://docs.github.com/en/rest/apps/apps)).
- Installation authentication: both App factories pass App ID/private key and use `getInstallationOctokit(id)`; Octokit obtains/caches installation tokens and refreshes on demand at expiry — `/octokit/auth-app.js` ([authentication](https://github.com/octokit/auth-app.js/blob/main/README.md)).
- Installation token contract: delegated creation is `POST /app/installations/{installation_id}/access_tokens`, with a token and `expires_at`; one-hour caching is library-managed — `/websites/github_en_rest`, `/octokit/auth-app.js` ([token creation](https://docs.github.com/en/rest/apps/apps), [cache](https://github.com/octokit/auth-app.js/blob/main/README.md)).
- REST GHES base URL: both factories retain the configured custom Octokit base URL; `https://HOSTNAME/api/v3` is the documented API base — `/octokit/auth-app.js`, `/websites/github_en` ([auth request override](https://github.com/octokit/auth-app.js/blob/main/README.md), [GHES URLs](https://docs.github.com/en/apps/sharing-github-apps/making-your-github-app-available-for-github-enterprise-server)).
- Issue creation: POST issues supplies required title, optional body/labels, and reads the issue's `id` and `number` rather than a PR ID — `/websites/github_en_rest` ([issues](https://docs.github.com/en/rest/issues/issues)).
- Issue editing: PATCH issues uses `issue_number`, title/body, and `state: open|closed` — `/websites/github_en_rest` ([issue updates](https://docs.github.com/en/rest/issues/issues)).
- Labels: add uses POST issue labels with a `labels` array; removal uses DELETE issue labels by `name`, leaving URL encoding to Octokit's route expansion — `/websites/github_en_rest` ([installation-token routes](https://docs.github.com/en/rest/authentication/endpoints-available-for-github-app-installation-access-tokens)).
- Assignees: POST and DELETE issue assignees send usernames in an `assignees` body array; the current set is read from `issue.assignees[].login` — `/websites/github_en_rest` ([assignees](https://docs.github.com/en/rest/issues/assignees)).
- PR linkback comments: general PR discussion comments correctly use POST issue comments rather than inline-review-comment endpoints — `/websites/github_en_rest` ([working with comments](https://docs.github.com/en/rest/guides/working-with-comments)).
- Issue versus PR distinction: mirroring rejects `issue.pull_request`; backfill filters these entries from the issues response after separately listing PRs — `/websites/github_en_rest` ([issue/PR response distinction](https://docs.github.com/en/rest/issues/issues)).
- Push attribution: Smart Commits use the server-supplied `sender` account and workspace-scoped stable ID lookup, not Git author/committer or `pusher` metadata; signature verification remains a separate policy — `/websites/github_en` ([push payload](https://docs.github.com/en/webhooks/webhook-events-and-payloads)).
- Push fields and limit: actual admission uses 2,048 payload commits, branch refs use `refs/heads/`, and `created`, `deleted`, `before`, `after`, and zero SHAs are handled distinctly; several comments retain old limits — `/websites/github_en` ([push payload](https://docs.github.com/en/webhooks/webhook-events-and-payloads)).
- Commit verification: the REST commit reader checks `data.commit.verification.verified`, not author identity or an invented webhook verification field — `/websites/github_en_rest` ([commit resource](https://docs.github.com/en/rest/commits/commits)).
- Compare shape/order: GET compare uses `basehead: before...after`; `data.commits[].sha` and `commit.message` are adapted to Smart Commits in chronological page order — `/websites/github_en_rest` ([compare](https://docs.github.com/en/rest/commits/commits)).
- Readiness review ordering: latest actionable decision per reviewer is evaluated in the API's chronological order, including dismissal; the normal multi-page reader sends `page` and `per_page` correctly — `/websites/github_en_rest` ([reviews](https://docs.github.com/en/rest/pulls/reviews)).
- Combined status semantics: aggregate `failure`/`pending` block; `pending` with zero statuses is treated as absence of status checks; aggregate `state` covers contexts beyond the returned statuses page — `/websites/github_en_rest` ([combined status](https://docs.github.com/en/rest/commits/statuses)).
- Suite response shape: readiness reads `check_suites` and `total_count` from GET commit check-suites, and reads suite status/conclusion rather than check-run nesting — `/websites/github_en_rest` ([suites](https://docs.github.com/en/rest/checks/suites)).
- Deployment payload fields: deployment association uses `deployment.sha`; titles/state use `deployment_status`, preferring `environment_url` and then `target_url`; environment fallback is on `deployment` — `/websites/github_en` ([deployment status](https://docs.github.com/en/webhooks-and-events/webhooks/webhook-events-and-payloads)).
- HTML boundary: GitHub raw Markdown/text is escaped before embedding into Plane HTML; hrefs pass the absolute HTTP(S) URL filter and HTML escaping, while outgoing comments use the GitHub body field — `/websites/github_en_rest` ([raw body media type](https://docs.github.com/en/rest/issues/issues), [issue-comment schema](https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json)).

## REST endpoint inventory

`R` means Context7 `/websites/github_en_rest`; `O` means `/octokit/auth-app.js`. The links identify the fetched source within those libraries. Pagination observations refer to this implementation, not only endpoint capabilities.

| Method and path | Fields / result consumed | Pagination / assessment | Context7 source |
|---|---|---|---|
| GET `/repos/{owner}/{repo}/installation` | `owner`, `repo`; installation `id` | Single resource; JWT, correct route; lifecycle cache A14 | R — [Apps](https://docs.github.com/en/rest/apps/apps) |
| POST `/app/installations/{installation_id}/access_tokens` | Library-managed token, `expires_at`, permissions; optional repository/permission narrowing is not requested | Single resource; delegated to Octokit | R/O — [Apps](https://docs.github.com/en/rest/apps/apps), [auth](https://github.com/octokit/auth-app.js/blob/main/README.md) |
| GET `/repos/{owner}/{repo}` | `id`, `full_name` for mapping/browser lookup | Single resource | R — [repositories](https://docs.github.com/en/rest/repos/repos) |
| GET `/users/{username}` | `id`, canonical `login`, nullable public `email` | Single resource; automatic lookup uses installation token, manual lookup A1 | R — [installation-token routes](https://docs.github.com/en/rest/authentication/endpoints-available-for-github-app-installation-access-tokens); Context7 OpenAPI — [user schema](https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json) |
| GET `/repos/{owner}/{repo}/issues/{issue_number}` | `assignees[].login`; reconciliation issue existence | Single resource | R — [issues](https://docs.github.com/en/rest/issues/issues) |
| POST `/repos/{owner}/{repo}/issues` | `title`, `body`, optional `labels`; result `id`, `number` | Single create | R — [issues](https://docs.github.com/en/rest/issues/issues) |
| PATCH `/repos/{owner}/{repo}/issues/{issue_number}` | `title`, `body`, `state` | Single update; accepted field vocabulary | R — [issues](https://docs.github.com/en/rest/issues/issues) |
| POST `/repos/{owner}/{repo}/issues/{issue_number}/labels` | `labels: string[]` | Mutating collection, no read-pagination requirement | R — [installation-token routes](https://docs.github.com/en/rest/authentication/endpoints-available-for-github-app-installation-access-tokens) |
| DELETE `/repos/{owner}/{repo}/issues/{issue_number}/labels/{name}` | Label `name` | Single removal; 404 handling A13 | R — [installation-token routes](https://docs.github.com/en/rest/authentication/endpoints-available-for-github-app-installation-access-tokens) |
| POST/DELETE `/repos/{owner}/{repo}/issues/{issue_number}/assignees` | `assignees: string[]` | Shared issue/PR endpoints; incremental diff preserves unmapped assignees | R — [assignees](https://docs.github.com/en/rest/issues/assignees) |
| POST `/repos/{owner}/{repo}/issues/{issue_number}/comments` | `body`; result `id` | General issue/PR discussion, not inline review comment | R — [comments](https://docs.github.com/en/rest/guides/working-with-comments) |
| GET `/repos/{owner}/{repo}/pulls/{pull_number}` | `state`, `merged` for other linked PRs | Single resource | R — [PRs](https://docs.github.com/en/rest/pulls/pulls) |
| GET `/repos/{owner}/{repo}/pulls/{pull_number}/reviews` | `user.id/login`, `state` | Chronological; readiness pages up to 20, rollup one page of 100: A6/A16 | R — [reviews](https://docs.github.com/en/rest/pulls/reviews) |
| GET `/repos/{owner}/{repo}/commits/{ref}` | `commit.verification.verified` | Commit identity/verification are on the first response; no file-diff enumeration needed | R — [commits](https://docs.github.com/en/rest/commits/commits) |
| GET `/repos/{owner}/{repo}/compare/{basehead}` | `before...after`, `per_page`, `page`; `commits[].sha/commit.message/html_url` | Max 100 per page, chronological; 30-page cap A8 | R — [compare](https://docs.github.com/en/rest/commits/commits) |
| GET `/repos/{owner}/{repo}/commits/{commit_sha}/pulls` | PR `number`, `head.sha/ref/repo`, `state` | Readiness/deployments default page A7; push rules paginate at 100 and throw at 50 pages | R — [associations](https://docs.github.com/en/rest/commits/commits) |
| GET `/repos/{owner}/{repo}/commits/{ref}/check-runs` | `check_runs[].conclusion` | First 100 only A5; endpoint also limits scope to latest 1,000 suites | R — [runs](https://docs.github.com/en/rest/checks/runs) |
| GET `/repos/{owner}/{repo}/commits/{ref}/check-suites` | `check_suites`, `total_count`, suite status/conclusion/count | 100 per page, silent 20-page bound A16 | R — [suites](https://docs.github.com/en/rest/checks/suites) |
| GET `/repos/{owner}/{repo}/commits/{ref}/status` | Aggregate `state`, `total_count`, `statuses` | Uses aggregate state, so individual-status pagination is unnecessary for this decision | R — [statuses](https://docs.github.com/en/rest/commits/statuses) |
| GET `/repos/{owner}/{repo}/pulls` and GET `/repos/{owner}/{repo}/issues` | Backfill `state=open`, PR head ref, title/body/number; excludes `pull_request` entries from issues | 100 per page, silent 50-page bound A16 | R — [PRs](https://docs.github.com/en/rest/pulls/pulls), [issues](https://docs.github.com/en/rest/issues/issues) |
| POST `/repos/{owner}/{repo}/autolinks` | Documented: `key_prefix`, `url_template` containing `<num>`, optional `is_alphanumeric`; 201 or validation 422 | **No call exists** despite toggle; A12 | R — [autolinks](https://docs.github.com/en/rest/repos/autolinks) |
| POST `/repos/{owner}/{repo}/git/refs` | Documented: fully qualified `ref` such as `refs/heads/feature`, commit `sha`; 201, 409, 422 | **No call exists**; branch-name links/push rules do not create refs. 422 is general validation/spam, not proof a branch already exists | R — [refs](https://docs.github.com/en/rest/git/refs) |
| Deployment REST endpoints | None | Deployment data comes from webhooks; no deployments or deployment-status REST listing/creation call exists | `/websites/github_en` — [deployment payload](https://docs.github.com/en/webhooks-and-events/webhooks/webhook-events-and-payloads) |

The optional API branch-creation capability in spec §7.1 is absent from the shipped routes and writers. Its method/fields/permission were checked, but there is no implemented refs call whose request can be certified. Likewise, no organization-member REST call or `GET /app/installations` call exists.

## Webhook payload and action inventory

All handled repository events use top-level `repository.id/full_name`, optional `installation.id`, and top-level `sender`. The table separates actions actually used from actions merely listed in research. Context7 sources: `/websites/github_en` [event catalog](https://docs.github.com/en/webhooks-and-events/webhooks/webhook-events-and-payloads) and `/octokit/webhooks` [payload examples](https://github.com/octokit/webhooks/blob/main/cache/api.github.com/webhook-events-and-payloads.html).

| Event | Fields/actions consumed and resulting behavior |
|---|---|
| `pull_request` | Full `pull_request.number/title/body/head.ref/head.sha/base.ref/user.login/labels/draft/state/merged/html_url`; opened/draft conversion, ready-for-review, review-requested, closed with merged distinction, reopened. Other actions still refresh references/rollups. Ready-for-merge is a local synthetic lifecycle, not a GitHub action. A10/A15 apply. |
| `pull_request_review` | Full `pull_request`, `review.state`, `action=submitted` for approved/changes_requested; edited/dismissed still refresh rollups through REST reviews. Actor is sender, author is PR user. |
| `push` | No action discriminator; branch ref, before/after, created/deleted, commits `id/message/url`, repository default branch, sender. Smart Commit author identity does not come from commit metadata; payload limit is 2,048. A8 applies. |
| `issues` | `issue.number/title/body/state/labels/assignees/html_url`; `changes` keys for edited, top-level `label.name` or `assignee.login` for echo classification. Opened/labeled can opt in; closed/reopened/edit/label/assignment mirror fields. Other actions can run generic rules but are not mirrored deletions/transfers. |
| `issue_comment` | `issue` plus `comment.body/user.login/html_url`; only created comments mirror, while generic comment rules can receive created/edited/deleted. PR comment rules use the issue's `pull_request` marker and PR links. |
| `check_suite` | `action=completed` supplies conclusion rules/readiness; `check_suite.head_sha/head_branch/pull_requests/conclusion`; build refresh also runs on other suite actions. Missing fork associations A9. |
| `check_run` | `check_run.head_sha/pull_requests`; refreshes builds; no check-run-specific rule trigger and no direct readiness evaluation. Checks read allows created/completed; rerequested/requested_action require Checks write and are not necessary for this service. |
| `status` | No action discriminator; top-level `sha`, `state`; success triggers current readiness evaluation. `branches` is not used. |
| `deployment_status` | `deployment.sha/ref/environment`, `deployment_status.state/environment/environment_url/target_url`; translates state into rules without depending on action. Current fetched docs describe `action=created`; inactive statuses do not emit this webhook. |
| `ping` | Verified first, then acknowledged/ignored. |
| `installation`, `installation_repositories` | Ingress queues them, router audits unhandled; it never consumes `repositories`, `repositories_added`, `repositories_removed`, or lifecycle actions. These events are automatically sent to Apps rather than manually selected; A14. |
| `pull_request_review_comment`, `create`, `delete` | Research lists them, but no reducers handle them. Inline review comments do not become issue comments. Branch lifecycle derives from push, not these events. |

## App permissions and research comparison

The configured App is external to this repository. The code cannot grant its own permissions or events. The research set covers the implemented route needs, but its “minimal” label includes permissions for capabilities with no executor.

| Permission | Shipped need compared with research | Context7 evidence |
|---|---|---|
| Issues read/write | Required for standalone issue mirroring, labels, assignees, issue comments and related events; research agrees | `/websites/github_en_rest` — [issues](https://docs.github.com/en/rest/issues/issues), [assignees](https://docs.github.com/en/rest/issues/assignees); `/websites/github_en` — [issue events](https://docs.github.com/en/webhooks-and-events/webhooks/webhook-events-and-payloads) |
| Pull requests | Read for PR state, reviews, associations and review events. Research requests write for PR comments, but general discussion uses issue-comment endpoints and the App already has Issues write; no merge/review/inline-comment write exists | `/websites/github_en_rest` — [PRs](https://docs.github.com/en/rest/pulls/pulls), [reviews](https://docs.github.com/en/rest/pulls/reviews), [discussion versus review comments](https://docs.github.com/en/rest/guides/working-with-comments) |
| Contents | Read for commits, compare and push subscription. Research's write is for the unimplemented git-ref creator; remove from the shipped minimal recipe until that capability exists | `/websites/github_en_rest` — [commits](https://docs.github.com/en/rest/commits/commits), [refs](https://docs.github.com/en/rest/git/refs) |
| Checks read | Required for suites/runs and created/completed events; research agrees. Research's enumeration of rerequested/requested_action does not mean read grants those actions | `/websites/github_en_rest` — [Checks permission](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps); `/websites/github_en` — [check event availability](https://docs.github.com/en/webhooks-and-events/webhooks/webhook-events-and-payloads) |
| Commit statuses read | Required for combined status and status events; present in current research. Permission failure correctly blocks readiness, except rate-limit misclassification A2 | `/websites/github_en_rest` — [statuses](https://docs.github.com/en/rest/commits/statuses); `/websites/github_en` — [status events](https://docs.github.com/en/webhooks-and-events/webhooks/webhook-events-and-payloads) |
| Deployments read | Required to subscribe to deployment_status, even though this code issues no deployment REST reads; research agrees | `/websites/github_en` — [deployment-status permission](https://docs.github.com/en/webhooks-and-events/webhooks/webhook-events-and-payloads) |
| Administration write | Needed for actual autolink creation, not a core sync permission. Research includes it, spec makes it optional/off, and shipped executor is missing (A12) | `/websites/github_en_rest` — [autolinks](https://docs.github.com/en/rest/repos/autolinks) |
| Organization Members read | Research says it reads organization members; no such GitHub call exists. Identity matching lists **Plane** workspace members and reads a GitHub public profile. This permission adds no implemented functionality | Context7 OpenAPI `/openapi/raw_githubusercontent_github_rest-api-description_main_descriptions_api_github_com_api_github_com_json` — [public user endpoint](https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json) |

The implemented subscriptions needed are `pull_request`, `pull_request_review`, `push`, `issues`, `issue_comment`, `check_suite`, `check_run`, `status`, and `deployment_status`. Research lists all of them. Its additional `pull_request_review_comment`, `create`, and `delete` events have no consumer. Installation lifecycle events arrive automatically and need handling for the cache behavior described in A14. [Context7 `/websites/github_en`: event availability and automatic installation events](https://docs.github.com/en/webhooks-and-events/webhooks/webhook-events-and-payloads).

Permission additions require installation-owner acceptance before taking effect; this research claim is correct. Installation tokens refresh **on demand** through the auth library, rather than through a background regeneration timer. Primary limits are installation-scoped: research omits the documented organization-user scaling alongside repository scaling. The implementation should consume `x-ratelimit-limit`, `remaining`, `used`, `resource`, and `reset` as observations rather than assume a fixed hourly budget; it currently makes retry decisions using only remaining/reset and retry-after. [Context7 `/websites/github_en`: permission acceptance](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app), [Context7 `/octokit/auth-app.js`: token cache](https://github.com/octokit/auth-app.js/blob/main/README.md), [Context7 `/websites/github_en_rest`: installation limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

## Evidence limits

This is a documentation/source audit, not a live installation test. Context7's `/octokit/webhooks` cache contains older push-limit wording; the current GitHub website documentation was fetched separately and used for the 2,048 limit. Where retrieval did not establish a guarantee, no finding was manufactured: POST retry ambiguity and a public email's verification/ownership guarantees were not certified by this audit. Sender-based attribution verifies the GitHub-assigned event identity, not ownership of every pushed commit. The audit did not change the service or the App configuration.
