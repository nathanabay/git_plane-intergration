# Security audit: web
SUMMARY: 0 Critical, 1 High, 4 Medium, 2 Low

This file summarises the web side for the brief. The full audit, run with Cloudflare's security-audit skill in full audit mode, is at `~/security-audit-skill/git_plane-intergration/run-1-web/`. It contains `REPORT.md`, `NEEDS-VALIDATION.md`, `findings.json` (validated) and `coverage-ledger.json` (validated, 21 units).

How to read the severities:

- The source is commit `325519c` plus the uncommitted work in the tree, as it stood during the run. Other agents were editing `src/ui/*`, and line numbers are from the final re-read.
- The run was source-only, because executing target code was not permitted. Under the skill's evidence bar, every finding below is therefore a `needs_validation` lead with an exact local test plan, not a confirmed vulnerability.
- The severities below follow this brief's rubric and give priority if the lead validates. Anything not proven end to end is marked **Unconfirmed**.
- Each lead was hunted, then checked against the source by two independent verifiers, Phase 3 and Phase 5.

### S1 [High] Rule `create_issue` project string becomes a Plane URL path under the service PAT (cross-workspace write) — Fixed (G4)
File: src/github/pr-automation.ts:506 (with src/rules/engine.ts:145, src/app/mappings.ts:193, src/sync/plane.ts:70)
Attacker: an admin of any workspace that has a repo mapping. With Plane's default `DISABLE_WORKSPACE_CREATION=0`, any registered user can create such a workspace. The attacker controls the rule YAML and the issues in their own mapped project.
Exploit:
1. `PUT /git-sync/api/workspaces/ws-a/mappings/<id>/rules` with a rule whose action is `create_issue: {project: "../../victim-ws/projects/<victim-project-uuid>", title: "x"}`.
2. Edit an issue in the mapped ws-a project to fire the Plane webhook. Plane-sourced rules run with no actor token (`src/app/issues.ts:292`), so the write uses the service PAT.
3. `planeItemsPath` interpolates projectId unencoded. The WHATWG URL parser in Node 24 turns `/workspaces/ws-a/projects/../../victim-ws/...` into `/workspaces/victim-ws/...`. A verifier observed this with standalone `new URL()`, not repository code.
Impact: a work item with attacker-chosen content is created in another tenant's project, wherever the service bot is a project member there. Plane v1.4.2 `ProjectEntityPermission` authorises on the bot's membership, and API tokens are not bound to a workspace. Within the attacker's own workspace, the same gap writes to projects other than the mapping's.
Evidence:
- `parseRules` accepts any string for `create_issue.project`.
- The executor uses `projectId: action.project` directly.
- `createOutboundAuthoriser` checks only `w.slug === workspaceSlug` for Plane writes.
- `planeItemsPath` does no `encodeURIComponent`, unlike `readPlaneIssueFields` in `src/app/main.ts:173`.
- Context7 `/websites/nodejs_latest-v24_x_api` covers WHATWG URL parsing for fetch.
Fix: when a rule is saved, reject a `create_issue.project` that is not a literal Plane UUID (`isValidPlaneId`) and forbid templates in it. In the executor and in `createOutboundAuthoriser`, require `projectId === mapping.planeProjectId`, or a project of the same workspace that an explicit allow-list names. `encodeURIComponent` every segment in `planeItemsPath` and `PlaneWritePath.apply`.

### S2 [Medium] A reused or renamed Plane workspace slug inherits the old workspace's installation, mappings and private-repo audit payloads — Confirmed (source; see Validation)
File: src/ui/plane-auth.ts:82 (grants keyed by slug: src/db/migrations/006-workspace-installations.sql:5, 001-init.sql:52)
Attacker: any registered Plane user, once a git-sync workspace has been deleted or renamed without disconnecting git-sync first.
Exploit:
1. Plane v1.4.2 `Workspace.delete` renames the slug to `slug__<epoch>`, which frees it. The slug can also be PATCHed.
2. The attacker creates a workspace with the freed slug `acme` and becomes its admin.
3. The attacker calls `GET /git-sync/api/workspaces/acme/audit`, `/mappings`, `/user-links` and `/github/connection`.
Impact: full stored GitHub webhook payloads (issue and PR bodies, comments, commits) from the victim's mapped private repos. That covers 90 days of history and every new delivery, because `workspaceOf` attributes deliveries through `repo_mappings.workspace_slug`. The attacker can also read and delete the mappings, user links and installation.
Evidence:
- Every grant table stores only `workspace_slug` and never Plane's workspace UUID.
- `authenticateWorkspaceAdmin` checks only the role on `/api/workspaces/{slug}/workspace-members/me/`.
- `auditPage` (src/ui/api.ts:654) returns `detail.payload` verbatim.
- Plane's slug freeing was confirmed by a read-only grep of `plane/db/models/workspace.py`.
Fix: store Plane's workspace UUID with each grant (from `/api/workspaces/{slug}/` at claim and map time) and compare it on every request. Refuse the request, or purge the grants, when the UUID differs.

### S3 [Medium] Forged hand-off callback squats another organization's installation after one click by its owner — Confirmed (source; see Validation)
File: src/ui/install-flow.ts:374 (hand-off branch), src/ui/oauth-flow.ts:155 (completeHandoff)
Attacker: any workspace admin, including of a self-created workspace. They need to know the victim org's installation id, which is visible to org members through `GET /github/claimable`.
Exploit:
1. `POST /git-sync/api/workspaces/attacker-ws/github/connect/handoff` with no body, which returns a 7-day state that has no org binding.
2. Call `/git-sync/install/github/callback?state=<nonce>&installation_id=<victim id>` directly. This returns a bearer GitHub authorize URL, with the PKCE verifier held on the server.
3. Send that URL to the victim org owner. GitHub skips the consent prompt for users who already authorized the App (Context7 `/websites/github_en`).
4. `completeHandoff` then claims the installation for `attacker-ws`.
Impact: the installation is squatted into the attacker's workspace, and the legitimate workspace's later claim gets 409 until someone intervenes. The attacker still cannot map repositories without their own triage-level access.
Evidence:
- The comment at install-flow.ts:370 says `installation_id` is "only carried forward".
- The state is deliberately session-less (oauth-flow.ts:134).
- The `accountId` binding (api.ts:181) is optional and chosen by the caller. The client sends it only for pending requests (Connect.tsx:107) and not from the general hand-off button (Connect.tsx:132).
Fix: bind every hand-off to an org `accountId` and refuse hand-offs without one. Before starting OAuth, check `installation_id` with `GET /app/installations/{id}` (App JWT) against that account. Require an explicit confirmation page that names the workspace and org, bound to the approver's browser, before calling `claimWithToken`. Also shorten the TTL.

### S4 [Medium] Instance admin can redirect the GitHub host while the stored secrets stay valid — Confirmed (source; see Validation)
File: src/ui/api.ts:823-842 (PUT /instance/github-app); consumers src/auth/github-user.ts:64,113 and src/app/github.ts:37
Attacker: a Plane instance admin who is not meant to hold the GitHub App or OAuth client secrets, or users' tokens. The spec (line 744) says the client secret is never returned to the browser.
Exploit: `PUT /git-sync/api/instance/github-app` with `{appId:<same>, edition:"ghes", gheBaseUrl:"https://attacker.example"}`. The stored private key, webhook secret and client secret are kept (COALESCE and skip-undefined), and user_tokens are left untouched.
Impact: the next refreshes POST `client_id`, `client_secret` and each user's `refresh_token` to the attacker's host. User access tokens are sent there as Bearer. App JWTs, valid for up to 10 minutes and able to mint installation tokens at GitHub, are sent to the new API base. If no client_id is stored, the environment `GITHUB_CLIENT_SECRET` leaks as well.
Evidence:
- `updateHost` (api.ts:826) forces no re-entry of secrets. Only a clientId change requires the secret again (api.ts:832).
- `private_key_v1 = COALESCE($5, existing)` (api.ts:840).
- `tokenRequest` sends `client_secret.reveal()` (github-user.ts:116).
- `hosts.ts:78` rejects only GitHub Cloud hostnames for ghes.
Fix: on any edition or host change, require `privateKey` and `clientSecret` to be entered again in the same request, mark every `user_tokens` row `needs_reauth`, and bind each stored token to the host that issued it. Optionally, let the operator allowlist GHES hosts in the environment, and resolve and reject non-public addresses.

### S5 [Medium] Backfill obtains an installation token without the calling workspace's allow-list check — Confirmed (source; see Validation)
File: src/app/main.ts:110-114 (operations.githubFor), src/ui/api.ts:785-811
Attacker: an admin of a workspace whose mapping's installation has been disconnected, removed or reassigned. The mapping row survives all of these by design.
Exploit: `POST /git-sync/api/workspaces/ws-a/mappings/<id>/backfill`. `githubFor` receives only the repository. It takes the first allowed mapping of that repo in any workspace, or falls back to the App-JWT `GET /repos/{owner}/{repo}/installation` with no allow-list check.
Impact: a workspace whose GitHub authority was revoked keeps a read path into the repo, possibly a private one. It sees counts of open PRs and issues and which of its work items they reference. It also keeps creating active `sync_links` rows.
Evidence:
- `OperationsDeps.githubFor` has the signature `{ghRepoId, owner, repo}` (api.ts:48).
- `installationFor` asserts the selected mapping's workspace, not the caller's (context.ts:138).
- The sibling dev panel correctly uses `mappingsForProject(projectId, slug)` (dev-panel.ts:211).
Fix: pass the loaded mapping, including its slug, to `githubFor` and resolve it with `installationFor(ctx, mapping)`, which asserts the caller's allow-list. Remove the unchecked `installationIdFor` fallback, and refuse backfill on disabled mappings with 403.

### S6 [Low] Workspace admin can revoke a current or former member's GitHub grant and tokens in every workspace — Confirmed (source; see Validation)
File: src/ui/api.ts:589-602 (DELETE /user-links), src/ui/mapping-check.ts:103
Attacker: an admin of an onboarded workspace W, meaning one where the service PAT is a member. The victim must be a current or former member of W.
Exploit:
1. `PUT /git-sync/api/workspaces/W/user-links/<victimId>` with any existing GitHub login. Plane's v1 members list includes inactive members, so a former member passes the check.
2. `DELETE` on the same path.
Impact: `DELETE /applications/{client_id}/grant` revokes all of the App's tokens for the victim, and `user_tokens` rows are deleted for every workspace. The victim loses attribution everywhere until they authorise again, and the attack can be repeated. Integrity and availability of attribution are affected; there is no disclosure.
Evidence:
- `PgTokenStore.delete` runs `DELETE FROM user_tokens WHERE plane_user_id = $1` (src/db/token-store.ts:25) with no workspace filter.
- The comment at api.ts:601 states the cross-workspace reach.
- The members endpoint has no `is_active` filter (Plane `plane/api/views/member.py`).
Fix: only the user's own disconnect should revoke at GitHub and delete tokens. An admin unlink should delete only W's `user_map` row and its tombstone. Filter `createPlaneMemberCheck` on `is_active`.

### S7 [Low] Admin-asserted self-link exposes other workspaces' pending App installation requests — Confirmed (source; see Validation)
File: src/ui/install-flow.ts:239-258 (pendingInstallationRequests), src/ui/api.ts:557-577
Attacker: an admin of an onboarded workspace.
Exploit:
1. `PUT /git-sync/api/workspaces/W/user-links/<own plane id>` with another person's public GitHub login and id. Ownership of the GitHub account is not proven.
2. `GET /git-sync/api/workspaces/W/github/connection`.
Impact: the response lists that person's pending installation requests across the instance: org id, login and avatar, requester, and time. This breaks the invariant stated at install-flow.ts:233-238. The information is mostly public metadata.
Evidence: `user_map` has no provenance column. The OAuth callback (oauth-flow.ts:112) and the admin PUT write identical rows.
Fix: record link provenance, `oauth` vs `admin`, and use only OAuth-proven links, or the viewer's own stored token through `GET /user`, for `pendingInstallationRequests`.

### Rejected during validation
- Read-only GitHub users claiming an org installation through `GET /user/installations`: fixed by code that landed during the run. `claimWithToken` now calls `assertOwnsInstallationAccount` (install-flow.ts:167; org admin or the same user id), and repository picking needs triage or higher.

## Checked and sound
- Workspace auth (`src/ui/plane-auth.ts`): every `workspace()` route forwards only a validated session cookie to Plane `/api/users/me/` and `/workspace-members/me/` and requires active role ≥ 20 on every request. A non-member gets role 0 and 403.
- Instance auth: `admin-session-id` is checked against `/api/instances/admins/me/`, which requires Plane `InstanceAdminPermission` (role ≥ 15). The composition-level `/instance/disabled-mappings` route authenticates as well.
- IDOR: `loadMapping`, `loadAudit`, the rules, policies, user-links, retry and backfill lookups, and the UPDATE and DELETE statements all bind id and workspace slug. Audit attribution fallbacks use only internal detail keys.
- CSRF: `guardWrite` requires an exact Origin match with PUBLIC_ORIGIN and a JSON content type before authentication on every non-GET route. The dev-panel branch POST does the same. There is no method override or form parser, and the API serves no CORS headers.
- OAuth/install state: a 32-byte nonce, stored as a SHA-256 hash, consumed atomically with purpose binding and expiry. PKCE S256 is used. `redirect_uri` is fixed from PUBLIC_ORIGIN, and callback redirects are built from the configured origin, not the request (no open redirect). Callbacks log only error messages, and their redirect responses send `referrer-policy: no-referrer`.
- Session-bound callbacks require `viewer.id === state.planeUserId`. The URL's `installation_id` is never trusted on that path.
- Token refresh against revocation: the refresh holds a pg row lock, so a revoked token cannot be brought back. Revocation deletes every App token for the user at GitHub.
- XSS: no `dangerouslySetInnerHTML`, `innerHTML`, `eval` or `document.write` in `src/ui/client/**` or the fork patches. Dev-panel links pass `safeUrl` (http and https only). There are no postMessage handlers.
- Headers: the HTML shell has `default-src 'self'; script-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'`, plus nosniff and `referrer-policy: same-origin`. The build emits no inline script.
- Static serving: the containment check `resolve(join(dist, rel))` plus `startsWith(dist+sep)` holds after the router's per-segment decoding, and NUL is rejected.
- Secrets: AES-256-GCM with a random IV and the tag verified. `SecretString` redacts `toString`, `toJSON` and `inspect`. `GET /github-app` returns only `clientSecretConfigured`. Error paths return fixed messages.
- Dev panel: Plane checks item visibility with the viewer's own cookie. Branch creation requires project role ≥ 15, and only allowed mappings of the same project and workspace can be used.
- Service-PAT directory reads stay within an admin's own Plane authority, because workspace admins can see and join every project in v1.4.2.
- Instance-admin installation writes refuse silent moves with 409. Stale mappings are dropped by `allowedMappings`, and queued writes are re-authorised at run and retry time.

## Validation

Validated on 2026-10-12 against the current `seal` tree, read-only. S1 is fixed (see the G4 S1 change and `tests/sync/security-s1.test.ts`) and is not repeated here.

**How each was checked.** Every hop of each trace was re-read in the current source. Plane v1.4.2 behaviour came from read-only reads of the local `plane-test-api-1` image. GitHub behaviour came from Context7 (`/websites/github_en`, `/websites/github_en_rest`). No target code was run: the full suite was running and execution stayed forbidden. So "Confirmed" below means **source-confirmed**: the complete path exists, and nothing in the current code, Plane's code or GitHub's documented behaviour blocks it. It does not meet the security-audit skill's stricter `confirmed` bar, which requires a local reproduction. Each fix lists the regression test that would serve as that reproduction.

**Result: 6 confirmed, 0 refuted, 0 still unconfirmed.**

### V-S2 Confirmed: a re-registered workspace slug inherits the old workspace's grants and audit payloads
- **Path.**
  - Plane frees a deleted workspace's slug: `plane/db/models/workspace.py:170-174` renames a soft-deleted workspace to `<slug>__<epoch>`, and the `slug` column is `unique=True` (`:136`).
  - Git-sync stores nothing but the slug. No table holds Plane's workspace id, so nothing tells the new `acme` apart from the old one.
  - `authenticateWorkspaceAdmin` (`src/ui/plane-auth.ts:82-87`) only checks the caller's role in *whatever workspace now has that slug*. The tables are keyed by slug alone: `workspace_installations`, `repo_mappings` (`loadMapping`, `src/ui/api.ts:265-267`), `user_map` and `audit_log`. `GET /workspaces/:slug/audit` (`src/ui/api.ts:631-660`) returns `detail`, which holds the stored webhook payloads.
- **Exploit.**
  1. Workspace `acme` is deleted in Plane.
  2. Any Plane user who may create workspaces (Plane's default) creates a new workspace `acme` and becomes its admin.
  3. `GET /git-sync/api/workspaces/acme/audit` returns the old workspace's audit rows, including private-repo webhook payloads still within retention.
  4. `/mappings` and `/github/connection` show the inherited installation. The new admin can disconnect it or add mappings on it, for repos where their own GitHub token has triage access.
- **Fix (not applied).**
  - Bind every grant to Plane's immutable workspace id.
  - Add migration `src/db/migrations/0NN-workspace-identity.sql` with a new table `workspace_identity (workspace_slug TEXT PRIMARY KEY, plane_workspace_id UUID NOT NULL, first_seen TIMESTAMPTZ DEFAULT now())`.
  - `authenticateWorkspaceAdmin` already fetches `workspace-members/me/`, which in v1.4.2 serialises every field of the member row (`WorkspaceMemberMeSerializer`, `fields = "__all__"`) and so includes `workspace`. Return that id on the `Viewer`.
  - In the `workspace()` wrapper (`src/ui/api.ts:157-170`), insert the identity row on first sight. If the stored id differs, answer 409 ("this slug belonged to a deleted Plane workspace; an instance admin must purge it first").
  - Add an instance-admin purge route that deletes the old slug's rows.
  - Apply the same check to the hand-off and OAuth callbacks, which carry the slug in their state.
- **Test.** `tests/ui/security-s2.test.ts`: a fake Plane answers `workspace-members/me/` with workspace `W1`. Seed an audit row and an installation for `acme`, then switch the fake to `W2` for the same slug. Expect 409 from `/audit`, `/mappings` and `/github/connection`, and no payload in any response body. Positive control: `W1` still gets 200.

### V-S3 Confirmed: a forged hand-off callback lets one click by an org owner claim their installation into the attacker's workspace
- **Path.**
  1. An admin of `evil-ws` calls `POST /workspaces/evil-ws/github/connect/handoff` with no `accountId`. `createOwnerHandoff` (`src/ui/install-flow.ts:311-316`) creates install state `handoff:<admin>` with no organization binding.
  2. The admin calls `GET /git-sync/install/github/callback?state=<nonce>&installation_id=<victim installation>` themselves. GitHub never needs to redirect. The hand-off branch (`src/ui/install-flow.ts:368-374`) passes the forged `installation_id` straight into `beginGithubAuthorization` and returns a GitHub authorize URL.
  3. The admin sends that `github.com/login/oauth/authorize?client_id=<this App>…` link to the victim org's owner.
  4. GitHub documents that a user who has already authorized the App "will bypass the authorization prompt and be sent directly to the callback URL" (Context7 `/websites/github_en`, "building a Login with GitHub button"). So for a prior authorizer the click is silent.
  5. `completeHandoff` (`src/ui/oauth-flow.ts:155`) calls `claimWithToken(…, state.installationId, { expectAccountId: null })`. Both checks pass for the real owner: the installation is in their `/user/installations` (`install-flow.ts:162`) and they own its account (`:167`).
  6. The row `(victim installation, evil-ws)` is inserted (`:175-179`). The legitimate workspace later gets 409 (`:168-169`).
- **Impact, bounded.** The attacker's workspace can then map only repos where the attacker's own GitHub token has triage or higher (`assertRepositoryPickable`, `install-flow.ts:438-444`). The certain harm is squatting: the real workspace cannot connect its own organization until an instance admin removes the row. A secondary harm is that the attacker's mappings run with the installation's App permissions.
- **Fix (not applied).**
  - Make the organization binding mandatory, and stop letting a GitHub-supplied query value pick the installation.
    1. `src/ui/install-flow.ts` `handleInstallCallback` hand-off branch: when the state carries an `accountId`, keep it. When it does not, mark the authorize state so the OAuth callback claims only an installation whose account was created or changed by this install (compare against `GET /app/installations/{id}` `account.id`).
    2. Simpler and stronger: in `completeHandoff` (`src/ui/oauth-flow.ts`), require `accountId !== null`. In `createOwnerHandoff`, require an `accountId` and reject a body without one (`src/ui/validate.ts` `parseOwnerHandoff`).
    3. Make the general hand-off button (`src/ui/client/Connect.tsx:132`) ask for the organization login, resolve it to an id, and send it.
  - Also show the owner a confirmation page naming the destination workspace before claiming, instead of a silent redirect.
- **Test.** `tests/ui/security-s3.test.ts`, with fake ConnectDeps:
  - hand-off without `accountId` → 422;
  - hand-off for org `A` (id 1) plus a forged callback with org `B`'s installation, then a fake OAuth callback where `/user/installations` contains B and the user owns B → `wrong_account`, with no `workspace_installations` row;
  - positive control: hand-off for org B → claimed.

### V-S4 Confirmed: an instance admin can move the GitHub host while every stored secret stays live
- **Path.**
  - `PUT /instance/github-app`: `updateHost` is true whenever `gheBaseUrl` or `edition` is sent (`src/ui/api.ts:826`). Only a `clientId` change forces the secret to be re-entered (`:832`).
  - The private key and webhook secret are kept by `COALESCE` (`:840`). `saveGithubAppClient` skips undefined fields, so `client_secret_v1` is kept too (`src/db/parity.ts:47-50`). Every `user_tokens` row survives.
  - Every consumer reads the host at use time:
    - token refresh POSTs `client_secret` and `refresh_token` to the stored `oauthAccessTokenUrl` (`src/auth/github-user.ts:113-116`);
    - grant revocation sends the client id and secret as Basic auth to the stored API host (`:241`);
    - user Octokit uses the stored `apiBaseUrl` (`:371`);
    - App JWTs go to the stored host (`src/app/github.ts:26,37`).
  - For `ghes`, `deriveGithubHosts` accepts any plain-https origin that is not GitHub Cloud (`src/github/hosts.ts:49,73-78`).
- **Exploit.** A Plane instance admin sends `PUT {appId:<same>, edition:"ghes", gheBaseUrl:"https://collector.example"}` with no key and no secret. On each user's next token refresh, their GitHub refresh token and the App's client secret are POSTed to the collector. App-JWT calls go there too, and each signed JWT lets whoever holds it mint installation tokens on real GitHub for its roughly 10-minute life.
- **Control defeated.** Spec §12.10 says the client secret is "never returned to the browser". The secret, and users' personal GitHub tokens, are deliberately unreadable through the admin UI, and this path hands them out anyway.
- **Severity.** Medium, given the privileged attacker (an instance admin).
- **Fix (not applied).**
  - In `src/ui/api.ts` `PUT /github-app`: when the host changes (the resolved `apiBaseUrl` differs from the stored one), require `privateKey` and `clientSecret` in the same request. Otherwise answer 422 "changing the GitHub host requires re-entering the private key and client secret".
  - In the same transaction, delete every `user_tokens` row of kind `github_oauth` (they were issued by the old host) and write an audit row.
  - Optional hardening: resolve the GHES host and refuse private or loopback addresses unless an operator allow-list permits them.
- **Test.** `tests/ui/security-s4.test.ts`:
  - seed a config and one user token, then PUT a new `gheBaseUrl` without secrets → 422, with the stored host unchanged and the token row still present;
  - PUT with both secrets → 200, and `user_tokens` is empty;
  - a recording fetch confirms no request ever reached the new host carrying the old client secret.

### V-S5 Confirmed: backfill uses an installation token without the calling workspace's allow-list
- **Path.**
  - `POST /workspaces/:slug/mappings/:id/backfill` (`src/ui/api.ts:785-809`) loads the mapping by id and slug only (`loadMapping`, `:265-267`, which does not check the allow-list). It then calls `ops.githubFor({ ghRepoId, owner, repo })` (`:802`), which carries no workspace and no installation.
  - Production `githubFor` (`src/app/main.ts:110-113`) takes `mappingsForRepo(db, ghRepoId)[0]`, an allowed mapping from *any* workspace, or otherwise falls back to `ghClient.installationIdFor(owner, repo)`, which has no allow-list check at all. It then mints that installation's token.
  - `backfill` lists the repo's open PRs and issues with it and inserts `sync_links` for the caller's workspace (`src/operations/tooling.ts:230-244`).
- **Exploit.** Workspace `ws-a` had mapping 1 on `o/r` with installation 7. Installation 7 is then disconnected from `ws-a` (`disconnectInstallation`, `install-flow.ts:353-357`), removed by an instance admin, or claimed by `ws-b`. The mapping row stays. `ws-a`'s admin calls `POST /workspaces/ws-a/mappings/1/backfill`, and the service fetches `o/r`'s open PRs and issues with installation 7's token and writes `ws-a` links for every `WSA-n` reference it finds. That defeats the per-workspace allow-list that `allowedMappings` and `assertInstallationAllowed` (`src/app/mappings.ts`) enforce everywhere else.
- **Fix (not applied).**
  - `src/ui/api.ts` backfill route: after `loadMapping`, require `m.installation_id`, then `await assertInstallationAllowed(db, Number(m.installation_id), slug)` (403 otherwise).
  - Change `OperationsDeps.githubFor` (`src/ui/api.ts:48`) to take `{ installationId, ghRepoId, owner, repo }`.
  - In `src/app/main.ts`, implement it as `ghClient.installationOctokit(installationId)` after confirming `await ghClient.installationIdFor(owner, repo) === installationId`, and drop the any-workspace `mappingsForRepo(...)[0]` lookup.
- **Test.** `tests/ui/security-s5.test.ts`:
  - insert mapping (`ws-a`, repo 42, installation 7) and allow-list row (7, `ws-b`) only;
  - backfill as an admin of `ws-a` → 403, no `installationOctokit` call recorded and no `sync_links` row;
  - positive control: allow-list (7, `ws-a`) → 200.

### V-S6 Confirmed: a workspace admin can revoke a current or former member's GitHub grant everywhere
- **Path.**
  - `PUT /workspaces/W/user-links/:victim` (`src/ui/api.ts:557-587`) checks only two things: that the GitHub login's public id matches (any public account works), and `isWorkspaceMember(W, victim)` (`:564`).
  - `isWorkspaceMember` is `createPlaneMemberCheck` (`src/app/main.ts:105`, `src/ui/mapping-check.ts:100-105`), which accepts any row of Plane's `GET /api/v1/workspaces/W/members/`. In v1.4.2 that endpoint returns every `WorkspaceMember` with no `is_active` filter (`plane/api/views/member.py:89`). Removing or leaving a member only sets `is_active = False` (`plane/app/views/workspace/member.py:146-149`, `:200`), and `deleted_at` stays null, so the soft-delete manager still returns the row. Former members therefore pass.
  - `DELETE /workspaces/W/user-links/:victim` (`src/ui/api.ts:589-605`) then needs only that `user_map` row. It calls `revokePersonalGrant` (`:596`), which issues GitHub `DELETE /applications/{client_id}/grant` and deletes every token GitHub issued to this App for that user (Context7 `/websites/github_en_rest`). It then deletes all of the victim's `user_tokens` with no workspace filter (`:602`, `src/db/token-store.ts:24`).
- **Exploit.** An admin of W picks a user who once belonged to W and now works in V. They PUT a link for that user (any GitHub login with its matching id), then DELETE it. The victim's GitHub authorization for the App is revoked and their stored token deleted. In V their writes silently fall back to the service identity until they reconnect. For a current member who already has a link, the DELETE alone is enough.
- **Severity.** Low: denial of another principal's credential, with no disclosure.
- **Fix (not applied).**
  - In `src/ui/api.ts` `DELETE /user-links/:planeUserId`: keep removing the `user_map` row and tombstone for W, but call `revokePersonalGrant` and `PgTokenStore.delete` only when the victim has no `user_map` row in any other workspace, *or* when the caller is the victim themself. The self-service path, `disconnectPersonalAccount`, keeps full revocation.
  - In `src/ui/mapping-check.ts` `createPlaneMemberCheck`: also require `m.is_active !== false` when the field is present. Plane's v1 list does not serialise it, so instead read `GET /api/workspaces/{slug}/members/` with an `is_active` filter, or check the user against the workspace's active member list from `members-lite`.
- **Test.** `tests/ui/security-s6.test.ts`:
  - seed a `user_tokens` row for U and `user_map` rows (V, U) and (W, U);
  - an admin of W DELETEs U's link → the W row is gone, U's token remains, and no GitHub `DELETE …/grant` is recorded;
  - positive control: U disconnecting themself still revokes.

### V-S7 Confirmed: an admin-asserted self-link exposes other workspaces' pending installation requests
- **Path.**
  - An admin of W PUTs `/workspaces/W/user-links/<own Plane id>` with `{githubLogin: X, githubId: idX}`. X is any public GitHub user, and the only check is that the login's public id matches (`src/ui/api.ts:571-573`).
  - The route writes the same `user_map` row the OAuth callback writes (`:577-580`), so nothing records that this link was asserted rather than proven.
  - `GET /workspaces/W/github/connection` (`src/ui/api.ts:178`) → `getPersonalLink` reads that row as the viewer's `githubId` (`src/ui/install-flow.ts:218-229`). `pendingInstallationRequests` then lists the App's instance-wide `GET /app/installation-requests` and returns every request whose `requester.id === idX` (`:239-258`), with organization login, avatar, requester login and timestamp.
- **Exploit.** The admin of W links themself to colleague X's GitHub account and opens the Connect page. Every pending App installation request X made, for organizations used by *other* workspaces, appears under "Pending organization approval". Precondition: the service PAT can read W's member list (true for any onboarded workspace).
- **Severity.** Low: it discloses organization names and request metadata.
- **Fix (not applied).**
  - Record how each link was proven. Add `user_map.link_source TEXT NOT NULL DEFAULT 'admin' CHECK (link_source IN ('admin','oauth','email'))`, set to `'oauth'` in `src/ui/oauth-flow.ts:112`.
  - In `src/ui/install-flow.ts` `getConnection`, pass the viewer's `githubId` to `pendingInstallationRequests` only when the link was made through OAuth. Better still, take the id from the viewer's own stored token (`GET /user` with `userTokens(deps).accessToken(viewer.id)`), so an asserted link is never trusted as identity.
- **Test.** `tests/ui/security-s7.test.ts`:
  - stub installation requests from requester 42 (org `org-w2`), then admin-PUT a self-link to login `alice`/42 and GET `/github/connection` → `pendingRequests` is `[]`;
  - positive control: an OAuth-made link for 42 → one request.

### Fixes applied (G4, 2026-10-12)
All six confirmed findings are fixed in the working tree. Nothing is staged or committed. Each fix has a regression test that fails without the fix and that runs a positive control.
- **S2:**
  - New migration `src/db/migrations/011-workspace-identity.sql`.
  - `Viewer.workspaceId` is read from Plane's membership row (`src/ui/plane-auth.ts`, `src/ui/oauth-flow.ts`).
  - `bindWorkspaceIdentity` in `src/ui/api.ts` covers every admin route, member route and GitHub callback. A reused slug gets 409.
  - Workspace health tolerates a database outage at the binding step only, and binds before it reads any data.
  - New instance route `DELETE /instance/workspaces/:slug/stale-data`. It refuses while the slug still belongs to the workspace that owns the data.
  - Tests: `tests/ui/security-s2.test.ts`.
  - Residual: a slug already reissued before this upgrade binds to whichever workspace uses it first after the upgrade.
- **S3:**
  - The hand-off must name its organization (`accountId` or `accountLogin`) in `src/ui/validate.ts`, `src/ui/api.ts` and `createOwnerHandoff`.
  - Unbound or legacy hand-off states are refused in both callbacks (`src/ui/install-flow.ts`, `src/ui/oauth-flow.ts`).
  - The client asks for the organization login and passes `accountId` from the claimable list (`src/ui/client/Connect.tsx`).
  - Test: `S3` in `tests/ui/parity2-g3.test.ts`.
- **S4:**
  - `PUT /instance/github-app` requires `privateKey` and, when a client secret exists, `clientSecret` whenever the host changes.
  - The same transaction deletes `github_oauth` user tokens and writes a `github_host_changed` audit row.
  - Test: `tests/ui/instance.test.ts` ("changing the host requires the private key again…").
- **S5:**
  - Backfill requires the mapping's own installation to be allow-listed for the calling workspace.
  - `githubFor` takes `installationId`, and `src/app/main.ts` checks that the installation still serves the repo.
  - Test: `tests/ui/security-s5.test.ts`.
- **S6:**
  - An admin unlink revokes the shared GitHub grant and deletes the token only for the admin themself or for a user no other workspace links.
  - Plane's v1 members list does not expose `is_active`, so the scoping lives in the unlink route.
  - Test: `S6` in `tests/ui/parity2-g5.test.ts`.
- **S7:**
  - Pending installation requests are matched against the GitHub id proven by the viewer's own OAuth token (`GET /user`). The admin-writable `user_map` row is no longer used.
  - Test: `S7` in `tests/ui/parity2-g3.test.ts`.
