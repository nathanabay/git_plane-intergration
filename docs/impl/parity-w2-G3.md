# Parity wave 2 — G3 report (C1, C2, C3 server side)

## 1. Handler contract for G5 (relay first)

All handlers are plain async functions. They take a deps object and an input object, and they
return JSON-able values or a redirect. Errors are thrown as `HttpError` from `src/ui/http.ts`
(status + message), so G5's existing `add()` wrapper maps them unchanged. **G5 owns routing,
authentication and CSRF**: G5 authenticates the viewer before calling a handler and passes the
`Viewer` in. The two GitHub callbacks are the exception: they get an `authenticate` callback,
because the workspace is known only after the state is read.

### Shared deps (`ConnectDeps`, exported from `src/ui/install-flow.ts`)

```ts
interface ConnectDeps {
  db: Db;
  tokenKey: Buffer;
  publicOrigin: string;                   // config.PUBLIC_ORIGIN
  config: OAuthAppEnv;                    // the GITHUB_* env (client id/secret/app slug/edition bootstrap)
  appRequest(route: string, params: Record<string, unknown>): Promise<{ data: any }>; // GithubClient.appRequest (App JWT)
  refreshInstallation?(installationId: number): Promise<void>; // existing api.ts dep; re-runs mapping verification
  fetch?: typeof fetch;                   // tests
  now?: () => number;                     // tests
  settingsUrl?(slug: string): string;     // admin page;  default `${origin}/${slug}/settings/git-sync`
  accountUrl?(slug: string): string;      // member page; default `${origin}/${slug}/settings/git-sync-account`
}
type Viewer = { id: string; email: string | null }   // from plane-auth.ts
type Authenticate = (slug: string, level: "admin" | "member") => Promise<Viewer>;
```

`authenticateWorkspaceMember(authDeps, req, slug)` is exported from `src/ui/oauth-flow.ts`. It works
like `authenticateWorkspaceAdmin`, but any Plane workspace member (role ≥ 15) passes and guests
(role 5) are refused. Plane v1.4.2 `ROLE_CHOICES = ((20, "Admin"), (15, "Member"), (5, "Guest"))`.

### C1: connect the organization (workspace admin)

| Suggested route | Handler | Input | Response |
|---|---|---|---|
| `GET  /git-sync/api/workspaces/:slug/github/connection` | `getConnection` | `{ slug, viewer }` | `ConnectionView` |
| `POST /git-sync/api/workspaces/:slug/github/connect` | `startInstall` | `{ slug, viewer }` | `{ installUrl: string, expiresAt: string }`: send the browser there (top-level navigation, not the iframe) |
| `POST /git-sync/api/workspaces/:slug/github/connect/handoff` | `createOwnerHandoff` | `{ slug, viewer }` | `{ link: string, expiresAt: string }`: a copyable install link for an org owner, valid 7 days |
| `GET  /git-sync/api/workspaces/:slug/github/claimable` | `listClaimableInstallations` | `{ slug, viewer }` | `{ needsGithubAccount: boolean, needsReauth: boolean, installations: ClaimableInstallation[] }` |
| `POST /git-sync/api/workspaces/:slug/github/installations/:installationId/claim` | `claimInstallation` | `{ slug, viewer, installationId: number }` | `ConnectedInstallation` (200). 409 if another workspace has it; 403 if it is not among the viewer's GitHub installations; 409 `{error}` if no personal account is linked |
| `DELETE /git-sync/api/workspaces/:slug/github/installations/:installationId` | `disconnectInstallation` | `{ slug, installationId }` | nothing (204); 404 if it is not this workspace's |
| `GET  /git-sync/install/github/callback` (no `/api`, GET, browser navigation) | `handleInstallCallback` | `{ query: URLSearchParams, authenticate }` | `{ location: string }`: answer **302** to it |

```ts
interface ConnectionView {
  appConfigured: boolean;          // client id + secret + app slug present (DB row, else env)
  installations: ConnectedInstallation[];   // this workspace's allow-listed installations
  pendingRequests: PendingRequest[];         // GET /app/installation-requests (all pages), only those whose requester is the viewer's linked GitHub account; [] if unlinked or the App JWT call fails
  personal: PersonalLink;                    // the viewer's own link (same shape as GET …/github/account)
}
interface ConnectedInstallation { installationId: number; accountLogin: string | null; accountType: string | null; avatarUrl: string | null; htmlUrl: string | null }
interface PendingRequest { id: number; accountId: number | null; accountLogin: string | null; accountAvatarUrl: string | null; requesterLogin: string | null; createdAt: string | null }
interface ClaimableInstallation { installationId: number; accountLogin: string | null; avatarUrl: string | null; canClaim: boolean; allowedForWorkspace: string | null /* null = free; this slug = already here; "another workspace" = taken (the other slug is not disclosed) */ }
```

What the callback does:
- It reads `state`, `installation_id` and `setup_action`, and consumes the state (purpose `install`).
- If the state is missing, expired or replayed, it redirects to `settingsUrl` with
  `?connect=error&reason=state`. Without a valid state it can't tell the workspace, so the redirect
  goes to `${origin}/` with the same query.
- If the viewer is not the admin who started it (the owner-handoff case), it redirects to
  `settingsUrl(slug)?connect=handoff`. The admin then finishes with **claimable → claim**.
- If the admin's GitHub account is not linked, or needs re-authorization, it chains into C2: it
  redirects to GitHub's authorize URL with an OAuth state that carries `installation_id`, and the
  OAuth callback finishes the claim.
- Otherwise it verifies `installation_id` against the admin's `GET /user/installations`, fetches
  `GET /app/installations/{id}` with the App JWT, and allow-lists it. It redirects to
  `settingsUrl(slug)?connect=ok`, or `?connect=error&reason=<code>` with code `not_yours`,
  `taken`, `github`, `not_configured` or `installation` (missing or invalid `installation_id`).
- With `setup_action=update` and an installation this workspace already has, it calls
  `refreshInstallation` and redirects with `?connect=updated`.

### C2: personal GitHub account (any workspace member, for themselves)

| Suggested route | Handler | Input | Response |
|---|---|---|---|
| `GET    /git-sync/api/workspaces/:slug/github/account` | `getPersonalLink` | `{ slug, viewer }` | `PersonalLink` |
| `POST   /git-sync/api/workspaces/:slug/github/account/connect` | `startGithubAuthorization` | `{ slug, viewer }` | `{ authorizeUrl: string, expiresAt: string }`: top-level navigation. Also serves **Reconnect** |
| `DELETE /git-sync/api/workspaces/:slug/github/account` | `disconnectPersonalAccount` | `{ slug, viewer }` | nothing (204); 404 when nothing was linked. Revokes the grant on GitHub first, best effort |
| `GET    /git-sync/oauth/github/callback` (no `/api`) | `handleOAuthCallback` | `{ query: URLSearchParams, authenticate }` | `{ location: string }`: answer **302** |

```ts
interface PersonalLink { appConfigured: boolean; linked: boolean; githubLogin: string | null; githubId: number | null; needsReauth: boolean; tokenStored: boolean }
```

OAuth callback redirect: `accountUrl(slug)?github=linked`, or `?github=error&reason=<code>` with
code `state`, `denied` (GitHub returned `error=access_denied`), `exchange`, `already_linked` (that
GitHub account is linked to another Plane user in this workspace), `github` or `not_configured`.
A chained install goes to `settingsUrl(slug)?connect=ok|error&reason=…` instead.

### C3: repository picker and the save-time re-check (workspace admin)

| Suggested route | Handler | Input | Response |
|---|---|---|---|
| `GET /git-sync/api/workspaces/:slug/github/repositories[?installationId=N]` | `listPickableRepositories` | `{ slug, viewer, installationId?: number }` | `{ needsGithubAccount: boolean, needsReauth: boolean, repositories: PickableRepo[] }` |
| (inside G5's mapping create/update, before `authoriseMapping`) | `assertRepositoryPickable` | `{ db…deps, slug, viewer, ghRepoId: number }` | resolves `PickableRepo`, or throws `HttpError` 403 (not in the viewer's list), 409 (no linked account, or it needs re-authorization) or 502 (GitHub error) |

```ts
interface PickableRepo { id: number; fullName: string; private: boolean; installationId: number; permissions: Record<string, boolean> | null }
```

Repositories come from every installation allow-listed for the workspace (or only `installationId`),
through `GET /user/installations/{id}/repositories` with the admin's user token, following every
page. The re-check reads the same list again on save; the browser's list is never trusted.
**Instance admins' manual id entry** stays G5's call: skip `assertRepositoryPickable` on that path only.

### Attribution (C2) — `src/sync/github.ts`

`GithubWrite` targets gain an optional `asUser?: string` (a Plane user id). `GithubWritePath` gains
an optional dep, `userClient(planeUserId, installationId) => Promise<octokit | null>`. Build it
with `createUserClientFactory(tokens, hostsLoader)` from `src/auth/github-user.ts`.
- With `asUser` and a usable token, the write goes out under the user's token, so GitHub shows
  the user as the author.
- With no token (unlinked, needs re-auth, or a failed refresh), the write uses the installation
  token, as today.
- If the user token is refused (401, 403 or 404), the write is retried once on the installation
  token. A 401 also marks the link `needs_reauth`. A write is never dropped.
- Echo suppression is unchanged: it is keyed on the op hash, not the sender.
Wiring callers to set `asUser` (mirror comments, rule comments) is outside this row.

## 2. Status

Done. Typecheck only (`node scripts/typecheck.mjs src/sync/github.ts src/auth/github-user.ts
src/ui/install-flow.ts src/ui/oauth-flow.ts tests/ui/parity2-g3.test.ts tests/mirror/parity-g3.test.ts`
→ passed, 53 project files). **No tests were run.** Nothing staged, committed or pushed. The handlers
match §1 exactly; the only addition is the `installation` reason code on the install callback.

## 3. Files

| File | What |
|---|---|
| `src/auth/github-user.ts` (new) | `loadGithubOAuthApp` / `loadGithubHosts`: the stored `github_app_config` row wins, the `GITHUB_*` env is the bootstrap, and a stored client id never pairs with the env secret. `createPkcePair` (43-char verifier, S256). `newStateNonce`. `exchangeGithubCode` / `refreshGithubToken` with `GithubOAuthError { code, transient }`. `githubUserApi` (`getUser`, `listInstallations`, `listInstallationRepositories`, all pages). `GithubUserTokens` (`store`, `status`, `markRejected`, `accessToken` with refresh under `withGithubOAuthRefreshLock`). `createUserClientFactory` for attribution. |
| `src/ui/install-flow.ts` (new) | `ConnectDeps`, C1 handlers (`getConnection`, `startInstall`, `createOwnerHandoff`, `listClaimableInstallations`, `claimInstallation`, `disconnectInstallation`, `handleInstallCallback`), the shared `beginGithubAuthorization` and `claimWithToken`, C3 (`listPickableRepositories`, `assertRepositoryPickable`). |
| `src/ui/oauth-flow.ts` (new) | `authenticateWorkspaceMember`, `startGithubAuthorization`, `handleOAuthCallback`, `getPersonalLink` (re-export), `disconnectPersonalAccount`. |
| `src/sync/github.ts` | `asUser?` on every write, `userClient` / `onUserTokenRejected` deps, and `#send`, which falls back to the installation token on 401/403/404 (401 also marks the link for re-authorization). |
| `tests/ui/parity2-g3.test.ts` (new) | 22 regression tests (below). |

All of the state, token and settings data goes through G4's `src/db/parity.ts` helpers; none of it is
re-implemented.

## 4. Behavior notes

- **State.** Every state is single use: the nonce is random, only its hash is stored, and it is
  consumed atomically. Lifetimes: install 30 min, owner handoff 7 days, OAuth 10 min. The OAuth
  state holds the encrypted PKCE verifier.
- **Callbacks.** Both callbacks re-authenticate the browser's Plane session and require the same
  Plane user who started the flow. The chained OAuth step requires workspace **admin**.
- **Installation ids** from the URL are never trusted. An installation is allow-listed only after
  it appears in the admin's own `GET /user/installations` (Context7 `/websites/github_en`, "About
  the setup URL").
- **One installation per workspace** is enforced the same way as the instance allow-list (409).
- **Owner handoff without relying on GitHub passing `state` through the install.** Context7 did not
  confirm that GitHub passes `state` through to the setup URL. If the owner does return with it,
  they get `?connect=handoff`. Either way, the admin finishes with **claimable → claim**, which
  proves the installation through the admin's own token. Nothing is allow-listed on an owner's
  return alone.
- **Refresh.** The token is refreshed 5 minutes before expiry under the per-user row lock. A waiter
  that finds a token another caller just refreshed uses it and does not refresh again (GitHub
  rotates the refresh token).
  - `bad_refresh_token` or any other refused refresh, an expired refresh token, or an undecryptable
    blob → `needs_reauth`.
  - Network errors, 5xx or 429 → fall back without marking.
  - Null always means "use the service identity"; no write is dropped.
- **Linking** is keyed by GitHub account id under `withUserLinkTransaction`. It lifts the
  tombstone and stores the tokens in the same transaction, so `already_linked` (unique
  `(workspace_slug, gh_id)`) stores nothing.
- **Disconnect** deletes `user_map` (writing the tombstone) and the `github_oauth` token. The
  Plane PAT stays.
- **C3** lists only installations allow-listed for the workspace. One the user cannot access
  (403/404) contributes nothing. The re-check runs the same query at save time.

## 5. Context7 / source citations

- `/websites/github_en` (resolved via `ctx7 library "GitHub Docs"` → `/github/docs`; the
  `/websites/github_en` id answers):
  - "Generating a user access token for a GitHub App": authorize parameters (`client_id`,
    `redirect_uri`, `state`, `code_challenge`, `code_challenge_method=S256`, `login`, `prompt`,
    `allow_signup`); `code` and `state` returned on redirect; the code exchange (`client_id`,
    `client_secret`, `code`, `redirect_uri`, `code_verifier`, header `Accept: application/json`);
    the response fields `access_token`, `expires_in` (28800), `refresh_token`,
    `refresh_token_expires_in`, the last omitted when expiration is disabled; the refresh
    (`grant_type=refresh_token`); error codes `bad_refresh_token`,
    `incorrect_client_credentials`, `redirect_uri_mismatch`, `unverified_user_email`.
  - "About the setup URL": `installation_id` may be spoofed; check it with the user token.
  - REST with a user token: `Authorization: Bearer USER_ACCESS_TOKEN`,
    `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`.
- `/websites/github_en_rest`:
  - `GET /user/installations`: `total_count`, `installations[]` with `id` and `account`;
    `per_page` max 100.
  - `GET /user/installations/{installation_id}/repositories`: `total_count`, `repositories[]`,
    `per_page` max 100.
  - `GET /app/installations/{installation_id}` (JWT): `account`, `html_url`.
  - `GET /app/installation-requests` (JWT): `id`, `account`, `requester`, `created_at`,
    `per_page` max 100.
- `/octokit/octokit.js`: the constructor takes `auth` (a token) and `baseUrl` (the API root for
  GHES). Used through `@octokit/core`, which the repo already uses the same way.
- Plane v1.4.2 source `apps/api/plane/db/models/workspace.py`: `ROLE_CHOICES = ((20, "Admin"),
  (15, "Member"), (5, "Guest"))`.

## 6. Wiring needed outside my row (for the driver to relay)

1. **G5, `src/ui/api.ts`:** register the §1 routes.
   - The two callbacks are GET browser navigations, not under `/git-sync/api`. Build `authenticate`
     from `authenticateWorkspaceAdmin` and `authenticateWorkspaceMember` on the same `req`, and
     answer `302 Location: result.location`.
   - Build `ConnectDeps` from the existing `ConfigApiDeps` plus `config` (the `GITHUB_*` env) and
     `appRequest` (`ctx.ghClient.appRequest`, which is optional on `GithubClient`; make it present
     in production).
   - Call `assertRepositoryPickable` in mapping create/update before `authoriseMapping`, except on
     the instance-admin manual-id path.
2. **G5, `src/app/main.ts`:** construct `GithubWritePath` with
   `userClient: createUserClientFactory(tokens, () => loadGithubHosts(db, config), db)` and
   `onUserTokenRejected: (id) => tokens.markRejected(id)`, where
   `tokens = new GithubUserTokens({ db, tokenKey, app: () => loadGithubOAuthApp(db, tokenKey, config) })`.
3. ~~Callers set `asUser`~~: done in W2c for the mirror; `rules.ts` makes no GitHub writes (see §9).
4. ~~Cron~~: done in W2b (`prune-oauth-states`, hourly).
5. ~~Revoking the grant on Disconnect~~: done in W2b.
6. ~~Privacy~~: done in W2b (only the viewer's own requests).

## 7. Tests written (`tests/ui/parity2-g3.test.ts`, not run)

- **C2:**
  - The authorize URL has the right parameters; only the nonce hash is stored; the S256 challenge
    matches the stored verifier. PKCE pair shape.
  - The callback exchange sends the verifier, client secret and redirect URI; links by id with
    canonical login; stores tokens encrypted; uses `Bearer`; lifts the tombstone.
  - Replayed, unknown, expired and foreign states, and `access_denied`, are refused, and GitHub is
    never called for them.
  - A failed exchange stores nothing; `already_linked` rolls the token back.
  - Not configured → 409.
  - Fresh token unchanged; an expiring token is refreshed once for two concurrent callers, and the
    refresh token rotates.
  - Transient refresh failure keeps the link; `bad_refresh_token` and an expired refresh token mark
    re-authorization; Reconnect clears it.
  - Disconnect plus tombstone, then 404.
  - Member role 15 passes, guest 5 is refused, no session is 401.
- **C1:**
  - The install URL and state; the handoff link lasts days; no slug → 409.
  - A forged installation id is refused and the state cannot be replayed; the happy path
    allow-lists and refreshes.
  - Taken by another workspace → refused.
  - No token → chained OAuth that claims the installation; the chain requires admin.
  - The owner handoff allow-lists nothing until the admin claims; claimable/claim with 403 and 409
    cases.
  - `setup_action=update` → refresh.
  - The connection view, including pending requests and a failing requests call.
- **C3:**
  - 150 repositories across two pages; inaccessible installations skipped; another workspace's
    installation → 404; unlinked → 409.
  - The re-check accepts a real repository, refuses a forged one (403), and refuses one needing
    re-authorization (409).
- **Attribution:**
  - A user-token write goes out as the user; no `asUser` or no token → installation token.
  - 401/403/404 fall back (401 marks re-authorization); a 500 propagates for the outbox to retry.

## 8. Follow-up W2b (driver-assigned)

Typecheck only (`node scripts/typecheck.mjs src/auth/github-user.ts src/ui/install-flow.ts
src/ui/oauth-flow.ts src/queue/cron.ts tests/ui/parity2-g3.test.ts tests/queue/cron.test.ts` →
passed). No tests were run; nothing staged, committed or pushed.

1. **Revoke on Disconnect.**
   - New `revokeGithubGrant(app, token)` in `src/auth/github-user.ts`:
     `DELETE <api>/applications/{client_id}/grant` with body `{ access_token }`, HTTP Basic
     auth (client id as username, client secret as password), success = 204.
   - New `GithubUserTokens.tokenForRevocation`: a working (or just refreshed) token, else the
     stored access token as is, so a link that needs re-authorization is still revoked.
   - `disconnectPersonalAccount` checks there is something to remove (404 otherwise, with no
     GitHub call), revokes best effort, then deletes locally as before.
   - A failure (non-204, network, or the App not configured) is audited as
     `github_grant_revoke_failed` with the workspace, `outcome: failed`, a short error and
     `{ planeUserId }`. The token never reaches the audit log, and the failure never blocks the
     local delete.
   - Context7 `/websites/github_en_rest`: "Delete an app authorization" ("Deleting an
     application's grant will also delete all OAuth tokens associated with the application for
     the user"; body `access_token`; 204; 422 on validation failure). "Authenticating to the REST
     API › Using basic authentication": client ID as username, client secret as password.
2. **Cron.** `src/queue/cron.ts` has a new `prune-oauth-states` job scheduled hourly
   (`RETENTION_EVERY_MS`). It calls G4's `pruneOAuthStates(db)` (states an hour past expiry or
   consumption) and returns `{ removed }`. **`tests/queue/cron.test.ts` is updated to match:**
   the scheduler count it waits for goes from 3 to 4 in both tests, and the first test asserts
   the new scheduler's hourly interval. Without this change the waits would time out silently.
3. **Privacy.** `getConnection` shows only pending installation requests whose `requester.id`
   equals the viewer's linked GitHub id (`user_map.gh_id`), and none when the viewer has no
   linked account. Context7 `/websites/github_en_rest`, "List installation requests for the
   authenticated app": each Integration Installation Request has `id`, `node_id`, `account`
   (Simple User or Enterprise, "Account requesting installation"), `requester` (Simple User,
   "User who requested the installation") and `created_at`. The match uses the stable numeric id,
   not the login.
4. **Tests** in `tests/ui/parity2-g3.test.ts` (now 24):
   - Disconnect revokes with the exact Basic header and body; a second disconnect does not call
     GitHub.
   - A 422 revocation is audited without the token and the local delete still happens.
   - A needs-re-authorization link revokes with the stored token.
   - The connection view shows no requests when unlinked and only the viewer's own request when
     linked.

## 9. Follow-up W2c: who GitHub writes act as (driver-assigned)

Typecheck only (`node scripts/typecheck.mjs src/sync/mirror.ts tests/mirror/parity-g3.test.ts` →
passed). No tests were run; nothing staged, committed or pushed.

- **`src/sync/mirror.ts`**, edits kept to the write sites so G2's converter calls are untouched:
  - A new helper, `planeAuthor(deps, …candidates)`, takes the first Plane user id it finds. The
    write gets `{ asUser }` only when that user has a `user_map` row in this workspace.
  - **Mirrored Plane comments**: the author comes from the comment's `data.actor`, falling back to
    `activity.actor`. The "**who** commented in Plane" line stays, so a write that falls back to the
    service identity is still attributed in its text.
  - **Mirrored Plane field edits** (title, description, state, labels, assignees) carry the
    editor's `asUser` (`activity.actor`) through `ghTarget`.
  - Assignee changes still execute as the service identity: the ordered outbox rebuilds them as
    `set_assignees` without `asUser` (`src/app/issues.ts` and the outbox, not my files). Neither a
    bug nor a lost write.
  - **Automated writes keep the service identity**: Plane → GitHub creates, the C5 cross-link
    comments, and the linkback and orphan comments.
- **Fallback.** `asUser` only chooses the client. `GithubWritePath` uses the installation token
  when the user has no usable token: not linked, needs re-authorization, or the refresh failed.
  It also falls back when GitHub refuses the user's token; a 401 marks the link for
  re-authorization through `onUserTokenRejected`. `asUser` never reaches the request parameters,
  so echo suppression (keyed on op hashes) is unchanged.
- **`src/app/rules.ts`: no change needed.** It makes no GitHub writes. A rule's `comment` action
  is a Plane `add_comment` (`createRuleExecutor` in `src/github/pr-automation.ts`), and it already
  runs under the actor's Plane token (`actorTokenFor`). So rule comments are already attributed to
  the linked user on the side they are written to.
- **Context7 `/websites/github_en`:**
  - "Best practices for creating a GitHub App": user access tokens "attribute activity to both a
    user and your app"; installation tokens attribute it to the app.
  - "Authenticating … on behalf of a user": a user-to-server token "cannot grant additional
    access capabilities to a user", which is why a refused user write falls back to the
    installation token.
- **Tests** in `tests/mirror/parity-g3.test.ts` (3 new):
  - A linked author's Plane comment carries `asUser`; an unlinked author's comment does not.
    The attribution line stays.
  - A linked user's title and state edits carry `asUser`; an unlinked editor's does not.
  - A Plane → GitHub create and its cross-link comment carry no `asUser`, even when a linked
    user triggered them.

## 10. Security review of G5's wiring (read-only, 2026-10-12)

Scope: `src/ui/api.ts` and `src/app/main.ts`, against the section 1 contract. Read only; no code
changed. G5 may still be editing; items marked **(unfinished)** are gaps, not regressions.

### Verified correct

- **Roles.** These run under `workspace()` → `authenticateWorkspaceAdmin`
  (`src/ui/api.ts:174-186`): connection, connect, handoff, claimable, claim, installation
  disconnect, and the repository picker. The personal-account routes run under `member()` →
  `authenticateWorkspaceMember` (role ≥ 15; `src/ui/api.ts:163-168, 187-189`) and act only on
  `viewer.id`: no route lets a member touch another user's link.
- **CSRF.** Every state-changing route (POST/DELETE) goes through `add()` → `guardWrite`
  (exact `Origin` match; JSON content type when there is a body). The two callbacks are GET and
  rely on the single-use state, as designed.
- **Callbacks** (`src/ui/api.ts:190-198`). Only GET, and only through the handlers'
  `authenticate` callback, built from the same `req` (admin → `authenticateWorkspaceAdmin`,
  member → `authenticateWorkspaceMember`). Responses are 302 with `cache-control: no-store`.
- **`installation_id`** is passed only as query text to `handleInstallCallback`. The claim route
  parses the path parameter with `installationId()` and the handler verifies it through the
  admin's `/user/installations`. Nothing allow-lists from the URL.
- **Repository picker.** `assertRepositoryPickable` runs before `authoriseMapping` on the workspace
  create and update paths (`src/ui/api.ts:315, 339`). The repository's full name comes from
  GitHub's list, not the request body. Only the instance-admin manual paths skip it (`manual =
  true`, `src/ui/api.ts:330-333, 366-369`), as agreed.
- **Secrets.** No route returns the client secret or any token. The callbacks' error JSON carries
  only `HttpError` messages. The handlers log `e.message` only, and none of those messages
  include a token, secret, code or verifier.
- **`main.ts`.** `GithubWritePath` is built with
  `userClient: createUserClientFactory(githubTokens, () => loadGithubHosts(db, config), db)` and
  `onUserTokenRejected: (id) => githubTokens.markRejected(id)` (`src/app/main.ts:147-149`), and
  it is the only `GithubWritePath` the outbox uses. `createConfigRoutes` gets
  `githubOAuthConfig`, `appRequest` (503 when the client has no App JWT) and
  `refreshInstallation` (`src/app/main.ts:70-71, 92`). The cron prune is scheduled.

### Findings

1. `src/ui/api.ts:169-172` — **(unfinished)** — `connectDeps()` sets no `accountUrl`, so a
   member's OAuth callback redirects to the default `/<slug>/settings/git-sync-account`. No Plane
   route exists there: the fork registers only `/settings/git-sync`, admin-only in
   `WORKSPACE_SETTINGS_ACCESS` (`apps/web/git-sync.patch:73`, `apps/README.md:18`). Members land
   on a Plane 404 and have no entry point to start linking. — **Fix:** add the member-level page
   (the fork route plus an access entry open to role ≥ 15, or a `/git-sync/ui/…` member page) and
   pass `accountUrl` (and `settingsUrl`, explicitly) in `connectDeps()`.
2. `src/ui/api.ts:7` and `:705-729` — **(unfinished)** — The instance `/github-app` routes still
   only read and write `app_id`, the private key, the webhook secret and `ghe_base_url`.
   `readGithubAppClient` and `saveGithubAppClient` are imported but never called, so the client
   ID, client secret, app slug and edition can be set only through the environment. — **Fix:**
   - Extend the PUT to accept `clientId`, `clientSecret`, `appSlug`, `edition`, `gheSubdomain`.
     Encrypt the secret with `encryptSecret`, and keep a missing secret unchanged (the helper
     already does).
   - Have the GET return `clientSecretSet: boolean`, never the secret.
3. `src/ui/api.ts:498-508` — Admin unlink (`DELETE /user-links/:planeUserId`) deletes the user's
   `github_oauth` token locally (`PgTokenStore.delete` removes every kind) but never revokes the
   grant on GitHub. The token stays valid at GitHub until it expires or the refresh token lapses
   (about 6 months), unlike the self-service disconnect. — **Fix:** before the transaction, best
   effort, call `tokens.tokenForRevocation(userId)` and `revokeGithubGrant(app, token)`, and audit
   `github_grant_revoke_failed` on failure. Exporting a small `revokePersonalGrant(deps, slug,
   userId)` from `oauth-flow.ts` would let both paths share it; I can add it if assigned.
4. `src/ui/api.ts:196` — The callbacks' catch answers any non-`HttpError` with a bare 500 JSON
   page and logs nothing. The failure is invisible to operators, and the browser, mid-redirect,
   shows raw JSON. — **Fix:** log `err.message`, never `req.url`, which holds `code` and `state`.
   Redirect to `${origin}/?connect=error&reason=internal` (or the matching settings page) instead
   of sending JSON.
5. `src/ui/api.ts:195` — The 302 from both callbacks has no `Referrer-Policy`. The callback URL
   carries the one-time `code` and `state`. Both are single-use, PKCE-bound and consumed before
   the redirect, so this is hardening only. — **Fix:** add `"referrer-policy": "no-referrer"` to
   the 302 headers.
6. `src/ui/api.ts:339` — `updateMapping` re-checks the repository on every edit, even when
   `ghRepoId` is unchanged. An admin without a linked GitHub account (or one needing
   re-authorization) now gets 409 when only toggling linkback, direction or states on an existing
   mapping. Stricter than needed, not a hole. — **Fix:** run `assertRepositoryPickable` only when
   `input.ghRepoId` is present and differs from `current.gh_repo_id`.

## 11. Follow-up W2d: shared grant revocation (finding 3)

Typecheck only (`node scripts/typecheck.mjs src/ui/oauth-flow.ts tests/ui/parity2-g3.test.ts` →
passed). No tests were run; nothing staged, committed or pushed.

```ts
// src/ui/oauth-flow.ts
export async function revokePersonalGrant(
  deps: ConnectDeps, planeUserId: string, workspaceSlug: string,
): Promise<{ revoked: boolean; tokenDeleted: boolean }>
```

1. **Best effort, on GitHub.** `DELETE /applications/{client_id}/grant`, using a working token or
   else the stored one. A non-204 answer, a network error or an unconfigured App is audited as
   `github_grant_revoke_failed` under `workspaceSlug` with `{ planeUserId }`, never the token.
2. **Always, locally.** Deletes the stored `github_oauth` token (`deleteGithubOAuthToken`).
3. **Left to the caller.** It does not touch `user_map` or the tombstone.
4. **Result.** `revoked` is true only on GitHub's 204; `tokenDeleted` says whether a stored token
   existed. With no stored token it makes no GitHub call.

Users:
- `disconnectPersonalAccount` now calls it, then unlinks with the tombstone in the user-link
  transaction. Behavior is unchanged: 404 only when neither a link nor a token existed.
- **G5, the admin unlink route** (`src/ui/api.ts:498`): call
  `await revokePersonalGrant(connectDeps(), userId, slug)` **before** the existing
  `withUserLinkTransaction`. That transaction's `PgTokenStore.delete(userId)` still removes the
  user's Plane PAT, as before.

Tests (2 new, `tests/ui/parity2-g3.test.ts`, now 26):
- Revoke plus local delete, with the link left in place; a second call makes no GitHub call.
- A GitHub 500 is audited under the given workspace and the token is still deleted.

## 12. C6/C7 wiring in `src/sync/mirror.ts` (driver-assigned)

Typecheck only (`node scripts/typecheck.mjs src/sync/mirror.ts tests/mirror/parity-g3.test.ts` →
passed, 47 project files). No tests were run; nothing staged, committed or pushed. `src/sync/text.ts`
was read, not edited.

**Converter API used (G2, `src/sync/text.ts`, as of 18:16 today):**
`textToHtml(text, context?)` and `htmlToText(html, context?)`, **both async**, with `TextContext`
`{ webOrigin, owner, repo, planeUserForGithubLogin?(login) → { id, displayName? } | null,
githubUserForPlaneId?(id) → { login?, displayName? } | null }`. If G2 changes these signatures, the
one adapter (`proseContext`) and the six call sites below need the same change. G2's wave-1 report
records only acceptance gates, not signatures, so these were read from the source.

**Wiring:**
- `proseContext(deps)` builds the context from the mapping:
  - `webOrigin` is `deps.githubWebOrigin` (G1 wires it from `hosts.ts`), defaulting to
    `https://github.com`.
  - Mapped users resolve through `deps.users`, the workspace's `user_map`.
- New optional dep `planeUserDisplayName(id)` supplies the display name for a mention of an
  unlinked Plane user. Plane v1.4.2's `mention-component` carries only the id. **G1, in
  `src/app/issues.ts`:** wire it from the workspace members list. Until then such a mention
  reads "Unknown user" (text.ts's fallback).
- Converted call sites (all mirrored prose; nothing else):
  - GitHub → Plane: comments, description edits, and the description of a created Plane item
    (both the direct and the planned path).
  - Plane → GitHub: comments, description edits, and the body of a created GitHub issue.
  - The service's own wrapper text ("**who** commented in Plane", "Mirrored from …", footers,
    cross-links) is unchanged.
- **Echo and loops.** The writers hash the value they actually send, which is now the converted
  text, so the echo of a mirrored write matches its hash. Conversion reaches a fixpoint after one
  step:
  - `#7` comes back as the canonical `acme/web#7`, and that text maps to the same Plane HTML.
  - A GitHub → Plane → GitHub round trip therefore never produces a new value to mirror back.
- Existing pinned outputs: `tests/mirror/mirror.test.ts:79` (`"line one\n\nline <two>"`), `:164`
  (an escaped `<script>`) and `:223` (`"Hi there"`) are plain prose that the new converter renders
  the same way.

**Tests** (`tests/mirror/parity-g3.test.ts`, 5 new):
1. A GitHub comment turns a mapped `@Octo` into Plane's mention element and `@stranger` into a
   profile link. `#7`, `other/x#9` and a full issue URL become canonical links, and inline code
   is untouched.
2. On a GHES host, references and profile links use `https://git.example.com`, never github.com.
3. A created Plane item's description is converted.
4. Plane mentions become `@Octo`, or "Ana Bekele" through `planeUserDisplayName`, in comments and
   description edits; a code block is untouched.
5. The round-trip fixpoint: GitHub → Plane → GitHub gives the canonical text, and both directions
   repeat exactly from then on.

## 13. N2: unresolved PR keys reported on the PR (`src/app/pr.ts`, driver-assigned)

Typecheck only (`node scripts/typecheck.mjs src/app/pr.ts tests/mirror/parity-g3.test.ts` → passed,
48 project files). No tests were run; nothing staged, committed or pushed. `src/github/problems.ts`
(G2) was read, not edited.

**Helper used.** `reportGithubProblem(deps: { enabled, authority, plan }, { owner, repo, key, target,
messages })`, gated by `problemReportsEnabled(db, authority)`, from `src/github/problems.ts`.
G2's report (`docs/impl/parity-w1-G2.md`, "N2 producer/helper work") documents the behavior; the
signature was read from the source.

**Wiring** (new `reportUnresolvedKeys`, called from `handleForMapping` right after the existing
`reference_unresolved` audit):
- **What is reported.** Only keys Plane answered **404** for: the project exists but no such work
  item does. A 403 (unknown project, or one the service cannot see) is how stray tokens such as
  `UTF-8` or `JIRA-12` resolve (`src/parse/references.ts:111-116`), so those are never reported.
- **Authority.** The PR's frozen authority from the delivery scope, which `handlePullRequest` sets
  per mapping; `freezeMappingAuthority(mapping)` only as a fallback. The gate is
  `problemReportsEnabled` (the mapping's `report_problems` and the installation allow-list). The
  write goes through the durable GitHub outbox (`ctx.github.plan`); none is posted directly.
- **One comment per PR.**
  - The stable key is `pr-unresolved:<PR number>` with target `{ kind: "issue", number }`, so G2's
    marker identifies a single comment.
  - Each message is "`<KEY>` does not match a work item in the linked Plane workspace, so this
    pull request is not linked to it."
  - The same set on a replay or another delivery reuses its intent, so nothing new happens. A
    changed set registers one new content version under the same key, and G2's executor PATCHes
    that comment in place.

**Limitation (G2's helper, not changed here).** When every key later resolves, nothing updates the
comment: `reportGithubProblem` returns early for an empty message list, so a fixed PR keeps the old
notice. Clearing it needs a "resolved" variant in `src/github/problems.ts` (G2's file), for example
an `{ resolved: true }` input that PATCHes or deletes the marked comment. Relay to G2 if wanted.

**Tests** (`tests/mirror/parity-g3.test.ts`, 3 new; they check intent registration, since running
a `problem_report` intent is G2's executor):
1. An unknown `QLL-99` registers one report on PR #12 with G2's marker; an `edited` replay with
   the same set registers nothing new.
2. A changed set (`QLL-98`, `QLL-99`) registers a second content version under the same key, so
   the existing comment is edited.
3. `report_problems` off → nothing; a resolvable key (`QLL-2`) → nothing.

## 14. Security self-review (Cloudflare security-audit skill, guidance mode)

Skill: `/home/claudeuser/.claude/skills/security-audit` (`SKILL.md`, guidance mode; no audit
artifacts). Checklists applied to my own changes:
- `ATTACK-CLASSES.md`: Injection; Access control; Cryptography and secrets; Business logic;
  Feature abuse and data leakage; Chained vulnerabilities.
- `DATA-ISOLATION-AND-LIFECYCLE.md`: tenant and object isolation; derived data and disclosure;
  deletion and revocation.
- `WEB-PROTOCOL-AND-AUTH.md`, because C1/C2 are an OAuth flow: OAuth/OIDC callback binding;
  account linking.

Context7 for the GitHub facts used: `/websites/github_en` ("Mentioning people and teams": `@` plus a
user or team name notifies them; repository roles Read < Triage < Write < Maintain < Admin, where
Triage manages issues) and `/websites/github_en_rest` (the per-repository `permissions` hash in
`GET /user/installations/{id}/repositories`).

Typecheck only (`node scripts/typecheck.mjs src/sync/mirror.ts src/app/pr.ts src/ui/install-flow.ts
tests/ui/parity2-g3.test.ts tests/mirror/parity-g3.test.ts` → passed, 55 project files). No tests were
run; nothing staged, committed or pushed.

### Fixed

1. **Injection into GitHub Markdown through Plane display names** (ATTACK-CLASSES → Injection,
   "second-order use: … escaped text enters raw rendering"; "injection through … metadata").
   - Where: `src/sync/mirror.ts`. The comment author's display name ("**who** commented in Plane")
     and a mentioned unlinked user's display name (C6) went into GitHub Markdown raw.
   - Who and what: a Plane member who sets their name to `@org/security-team` or
     `[x](https://…)`/`![](…)` makes the bot (or a linked user) notify arbitrary GitHub users or
     teams, or embed a link or tracking image.
   - Fix: new `markdownLiteral()` turns `@` into `＠` (U+FF20), so no mention is possible without
     relying on an escape rule Context7 does not document. It also backslash-escapes Markdown
     punctuation, flattens line breaks and caps the length at 100. Applied at both sites.
   - Tests: `security C6` in `tests/mirror/parity-g3.test.ts`.
2. **Enumeration oracle in the N2 PR report** (ATTACK-CLASSES → Feature abuse and data leakage,
   "Enumeration through side effects"; DATA-ISOLATION → "Enumeration and aggregate oracles").
   - Where: `src/app/pr.ts`. Reports fire only on Plane 404 (project exists, item does not), so
     on a public repository anyone opening a PR could learn which Plane project keys and item
     numbers exist in a private workspace.
   - Fix: report only when the delivery's `sender.id` is a GitHub account linked in this workspace
     (`user_map.gh_id`).
   - Tests: `security N2`; the N2 fixtures now link the harness sender.
3. **Capability growth through the App's token** (ATTACK-CLASSES → Chained vulnerabilities, "scope
   and capability growth"; Access control, "a path to the same state change that checks a weaker
   permission").
   - Where: `src/ui/install-flow.ts`. The picker and claim accepted any repository the admin could
     merely read, but mirroring writes labels, assignees and state with the App's token, which
     normally needs Triage.
   - Fix: new `canManageIssues(permissions)`, true for triage, push, maintain or admin.
     - The picker and the save-time re-check list only such repositories.
     - Claiming an installation (setup callback, chained OAuth, claim route) requires at least one
       such repository in it. A read-only collaborator can therefore no longer claim an
       organization's installation and block its real workspace.
   - Tests: `security: a read-only collaborator …` in `tests/ui/parity2-g3.test.ts`; the fixtures
     now carry `permissions`.
4. **Another workspace's slug disclosed** (DATA-ISOLATION → "Enumeration and aggregate oracles").
   - Where: `listClaimableInstallations` returned the other workspace's slug in
     `allowedForWorkspace`.
   - Fix: it now returns `"another workspace"` (contract in §1 updated).
   - Test: `security: the claimable list …`.

### Reviewed, no finding

- **OAuth callback binding** (WEB-PROTOCOL → OAuth/OIDC request and callback binding):
  - State is random, single-use, stored as a hash, expiring, and bound to the initiating Plane
    user, who is re-authenticated at the callback.
  - PKCE S256 is used, `redirect_uri` is exact, and the chained step requires admin.
- **Account linking** (WEB-PROTOCOL → Account linking):
  - It needs a current session; GitHub ownership is proven by OAuth; the link is keyed by
    immutable account id.
  - `(workspace_slug, gh_id)` uniqueness stops linking someone else's account; unlink writes a
    tombstone.
- **Tenant binding** (DATA-ISOLATION → Missing tenant or owner enforcement): every query in my
  handlers binds `workspace_slug`, including claims, disconnect, repository lists, user_map
  lookups, `planeAuthor` and pending requests.
  - `asUser` is chosen only from a link in the mapping's own workspace.
  - The N2 report and C5 cross-links run under the mapping's frozen authority.
- **Revocation and stale authorization** (DATA-ISOLATION → Deletion, revocation, and lifecycle):
  - Disconnect revokes the grant at GitHub and deletes locally.
  - Queued writes resolve the user token at execution, so a write queued before disconnect or
    re-authorization goes out as the service identity.
  - A 401 marks the link for re-authorization.
- **Secrets** (ATTACK-CLASSES → Cryptography and secrets):
  - Tokens, the PKCE verifier and the client secret are stored AES-GCM encrypted, and the state
    nonce comes from `randomBytes(32)`.
  - Logs and audit rows carry only error codes or messages, never a token, code or secret
    (asserted in the revoke-failure test).
- **Injection into Plane HTML** (ATTACK-CLASSES → Injection):
  - The mirror's own HTML wrappers escape every interpolated value (`escapeHtml`, `safeUrl`).
  - Converted prose comes from G2's escaping converter.
  - The mention `entity_identifier` is a user_map id, escaped by text.ts.
- **Redirects** (ATTACK-CLASSES → Obvious things, "open redirects"): callback redirects are built
  only from `PUBLIC_ORIGIN`, the state's stored workspace slug, or the configured GitHub host.
  Nothing comes from the query.

### Residual risk (decision for the user, not fixed)

- **Claiming an organization's installation needs only Triage on one of its repositories, not
  organization ownership.** A stricter "organization owner only" check would break the owner
  handoff (C1), where a non-owner admin claims what an owner installed. Today, a workspace admin
  who can triage one repository of an organization can connect that organization's installation
  first; instance admins can remove the allow-list row.
  - Mapping is still limited to repositories that admin can triage, so this does not grant write
    abilities they lack.
  - If the user prefers ownership, the fix is to require an organization admin
    (`GET /user/memberships/orgs/{org}` → `role: admin`) and drop the non-owner handoff path.
    That endpoint has not been verified through Context7 yet.

### Contract changes for G5 (relay)

- `ClaimableInstallation.allowedForWorkspace` is `null`, this slug, or `"another workspace"`.
- Claiming answers 403 "needs triage access or higher …" for a read-only collaborator.
- The picker omits read-only repositories.

## 15. Claiming requires an organization owner (user decision, 2026-10-12)

Typecheck only (`node scripts/typecheck.mjs tests/ui/parity2-g3.test.ts src/ui/install-flow.ts
src/ui/oauth-flow.ts src/auth/github-user.ts` → passed; `src/ui/api.ts`, G5's file, also typechecks
against the changed exports and was not edited). No tests were run; nothing staged, committed or pushed.

**GitHub facts (Context7):**
- `/websites/github_en_rest`, "Get an organization membership for the authenticated user":
  `GET /user/memberships/orgs/{org}` returns the user's membership if they are active or pending,
  404 if they are not affiliated, and 403 if the organization blocks the GitHub App.
- GitHub's OpenAPI description
  (`/openapi/raw_githubusercontent_github_rest-api-description_main_descriptions_api_github_com_api_github_com_json`),
  `org-membership`: `state` is `active|pending`, `role` is `admin|member|billing_manager`, and
  `organization.id` identifies the organization. Organization owners have `role: admin`.

**Rule** (`claimWithToken` → `assertOwnsInstallationAccount`, used by every claim path: the admin's
own setup callback, the chained OAuth, `claimInstallation`, and the hand-off):
- The installation must be in the signed-in user's `GET /user/installations`, otherwise `not_yours`.
- **Organization:** membership `state === "active"` and `role === "admin"`, and
  `organization.id` must equal the installation account's id.
  - Any other answer is `not_owner`: member, billing manager, a pending invitation, 404, or 403
    (blocked App).
  - The 403 message: "Only an owner of the GitHub organization <org> can connect it. Ask an
    organization owner to connect it, or send them the hand-off link."
- **Personal account:** the account id must equal `GET /user`'s id, otherwise `not_owner`.
- **Any other account type** (for example Enterprise): `unsupported_account`.
- This replaces the wave-2 "Triage on one repository" claim rule. The repository picker still
  requires Triage or higher per repository (§14).

**Owner hand-off.** `createOwnerHandoff({ slug, viewer, accountId? })` creates a 7-day, single-use
install state whose `plane_user_id` is `handoff:<admin id>[:<org id>]`:
1. GitHub returns the approver to the install callback. The handler sends them on to GitHub's user
   authorization (state plus PKCE S256, carrying the installation id and the hand-off marker).
   **No Plane session is needed or used.**
2. The OAuth callback exchanges the code. It claims the installation for the link's workspace only
   if `claimWithToken` succeeds with the approver's own token: the installation is theirs, they
   are an active organization owner, and, when the link is bound, it is the same organization
   (`wrong_account` otherwise).
3. Nothing of the approver is kept: no `user_map` row, no stored token, no Plane identity.
4. The redirect is `settingsUrl(slug)?connect=ok|error&reason=…&via=handoff`.
5. An ordinary Connect state (not a hand-off) used by any session other than the admin who started
   it is now refused with `reason=state`. Before, it redirected to `?connect=handoff`.

**WEB-PROTOCOL-AND-AUTH checklist** (security-audit skill):
- **OAuth/OIDC request and callback binding.**
  - Both legs are single-use, expiring and stored as hashes.
  - PKCE S256 and the exact `redirect_uri` are used.
  - The installation id from the URL is only carried forward and is checked against the approver's
    own installations.
  - The hand-off is deliberately **not session-bound** (the approver may have no Plane account), so
    it is a capability. It grants nothing without GitHub-verified ownership, and binding it to
    `accountId` limits it to the intended organization.
  - **Residual:** an unbound link that leaks lets an owner of some other organization attach that
    organization's installation to this workspace. The harm is limited to their own organization
    appearing there: admins can still map only repositories they can triage.
  - **Recommendation for G5:** always pass `accountId` when the link is made from a pending
    request.
- **Account linking.** The hand-off links no account. The admin's own personal link is unchanged
  (§14).
- **API-key / credential exposure.** The approver's token never leaves memory and is not logged;
  logs carry only error codes.

**Fields and behavior G5's UI needs:**
- `PendingRequest.accountId: number | null` (the organization's id). Pass it to
  `createOwnerHandoff` as `accountId` (new optional request-body field on
  `POST …/github/connect/handoff`) to bind the link.
- `ClaimableInstallation.canClaim: boolean`, precomputed with the same ownership check. When false,
  show "ask an organization owner" and the hand-off button instead of Connect.
- Claim errors are a `ClaimRefused` (`HttpError` 403) with
  `reason: "not_yours" | "not_owner" | "wrong_account" | "unsupported_account"`. **G5's `add()`
  wrapper sends only `{ error }`; please add `reason` when `e instanceof ClaimRefused`.**
- Callback redirect reasons are now `not_yours`, `not_owner`, `wrong_account`,
  `unsupported_account`, `taken`, `github`, `not_configured`, `installation`, `state` and `denied`.
  Hand-off results also carry `via=handoff`.

**Tests** (`tests/ui/parity2-g3.test.ts`):
- The fake gains per-token users, organization memberships (including 403 and 404), and account
  ids.
- Rewritten:
  - The old hand-off test is now "owner admin claims from the claimable list; forged id →
    `not_yours`".
  - The read-only test now shows that even a Triage member gets `not_owner`, with `canClaim: false`.
- New:
  1. Member, billing manager, pending owner, not affiliated and App blocked each give `not_owner`
     with the owner/hand-off message, and nothing is stored.
  2. A personal account works for its owner, gives `not_owner` for another person, and an
     enterprise gives `unsupported_account`.
  3. A non-owner admin's own callback gives `reason=not_owner`; a foreign session gives
     `reason=state`.
  4. Full hand-off: the owner approves with no Plane session, the workspace is connected, nothing
     of theirs is stored, and the link cannot be replayed.
  5. Hand-off by a non-owner gives `not_owner`; a link bound to another organization gives
     `wrong_account`.

## 16. Triage, group A: the C3 save-time re-check in older fixtures

**Verdict: the tests, not the code.** C3 deliberately re-checks, on every mapping create and every repository change, that the repository is in the saving admin's own GitHub listing. An admin with no linked account gets 409 before any other check runs. The failing fixtures predate C3: they had no linked user, no OAuth client configured, and no listing. The oracle also had no `appRequest`, so `connectDeps()` answered 503 before the re-check ran.

No production code changed. Every original assertion is kept.

- **New helper `tests/ui/linked-github.ts`:**
  - `linkGithubUser` stores a non-expiring personal token the way the OAuth callback would;
  - `githubListingFetch` fakes `GET https://api.github.com/user/installations/{id}/repositories` (Triage permissions) and passes every other request through;
  - `withGithubListing` swaps the global fetch for `composeRoutes` tests, which have no fetch dependency;
  - `GITHUB_OAUTH_CONFIG` supplies the client id and secret.
- **`tests/app/fixes-r2.test.ts` F1:** the admin is linked and installation 123 is allow-listed for `acme`, with a listing containing acme/web. The 422 still comes from the foreign project.
- **New test in the same file:** an unlinked admin gets **409** "Connect your personal GitHub account to choose repositories". The App is never asked about the repository and nothing is written.
- **`tests/app/review-r4-sa.test.ts` F1:** the listing names all three repositories (555, 556, 557). The two 422s still come from the App-side installation allow-list this test is about.
- **`tests/app/review-r5-cd.test.ts`** (the composed mapping-writes subtest): the admin is linked and sees acme/web, and the create still returns 201 with installation 123.
- **`scripts/verify-b3-config-api.mjs`:**
  - routes now get the OAuth config, the listing fetch (which delegates to the Plane fake), and an `appRequest` stub that throws if it is ever called;
  - the admin is linked and installation 1 is allow-listed for `qelal`;
  - the listing includes 556 and 999 so the "no verifier → 503" and "verifier refusal → 422" checks still reach the verifier.

**Results:** fixes-r2 6/6, review-r4-sa 2/2, review-r5-cd 6/6, oracle 14/14.

**Note (not changed):** `createMapping` calls `connectDeps()`, which requires `appRequest` even though the re-check never uses the App JWT. In production `composeRoutes` always wires it, so the only effect is on bare route fixtures.

## 17. Test triage: mirror, audit-g3 and review-r5-cc

**Verdict: every failure is a test encoding behavior that a deliberate change replaced. No production code changed.**

- **`tests/mirror/mirror.test.ts`**, the `github`-label create and the source_of_truth:plane description:
  - Cause: the C6 converter (G2's `htmlToText`) now keeps formatting, so the fixture's `<b>there</b>` becomes `**there**`.
  - Fix: both now expect `Hi **there**`.
  - The cross-link (C5) assertion was never failing.
- **`tests/mirror/audit-g3.test.ts`**, G15:
  - Cause: `checkPrReadiness` now fails closed when the combined-status reply has no string `state`. HEAD treated that as "no statuses". The harness answered `/status` with its generic `{id, number}` body, so readiness was refused.
  - Context7 (`/websites/github_en_rest`, "Get the combined status for a specific reference") confirms that a commit with no statuses answers `state: "pending"`.
  - Fix: the fake now returns `{ state: "pending", total_count: 0, statuses: [] }`.
  - The sibling "late ready_for_review on a draft" test gets the same reply, so it still proves the draft is what blocks firing.
- **`tests/mirror/review-r5-cc.test.ts`**, the two F2 confirmed-orphan tests:
  - Cause: reconcile A2 means one unexplained 404 only marks a link missing ("awaiting_confirmation"). It becomes orphaned when the next sweep agrees, or at once when Plane's activities show a delete.
  - Fix: a `confirmOrphan` helper runs two sweeps through the harness's own Plane client. It asserts the first does not orphan and the second does, so "confirmed orphan" is still proven through the real path, with no stub.

**Security note (security-audit, guidance mode):** every fail-closed rule involved is kept as is: the readiness status check and the two-sweep orphan confirmation. Only the fixtures now model GitHub and Plane faithfully.

**Results:** audit-g3 18/18, mirror 26/26, review-r5-cc 9/9; typecheck passes.
