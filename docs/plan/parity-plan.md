# Plan: close the gaps with Plane's official GitHub integration

Status: proposed (2026-10-12). Builds on branch `seal` after the documentation-audit fixes.
Scope: the eight gaps found by comparing our service with Plane's Pro GitHub integration.
API facts below were fetched through Context7 (`/websites/github_en`, `/websites/github_en_rest`,
`/websites/developers_plane_so`) and, where Plane's current docs describe a newer API than our
v1.4.2 target, checked against the v1.4.2 source. Each task names its source.

**The spec is the source of truth.** Tasks C1, C2, C3 and C8 change behavior the spec describes
(§9 identity, §8 UI, §3 deployment), so the first step is a spec amendment the user approves.

## The gaps

| # | Gap | Task |
|---|---|---|
| 1 | No "Connect" button that installs the App and returns to Plane | C1 |
| 2 | No personal GitHub account linking (OAuth) | C2 |
| 3 | Users are not limited to repositories they can access | C3 |
| 4 | Open/closed state is fixed to the project's default states | C4 |
| 5 | No cross-link comment or link on mirrored issues | C5 |
| 6 | Mentions are not synced | C6 |
| 7 | GitHub issue references are not shown in Plane | C7 |
| 8 | GitHub Enterprise has no separate Cloud (ghe.com) and Server handling | C8 |

## Phase 0: prerequisites

**C0. Spec amendment and App settings.** Add to the spec: App-installation connect flow, per-user
OAuth linking, user-scoped repository picker, per-mapping state choice, cross-links, mentions,
issue references, ghe.com. The App gains a **Client ID** and **Client secret** (needed for user
tokens) and two URLs:
- `callback_urls[]` = `<PUBLIC_ORIGIN>/git-sync/oauth/github/callback`
- `setup_url` = `<PUBLIC_ORIGIN>/git-sync/install/github/callback`, with `setup_on_update=true`

Source: GitHub "Registering a GitHub App using URL parameters": `callback_urls` "used if your app
needs to generate a user access token"; `setup_url` "to redirect to after someone installs the
GitHub App"; `request_oauth_on_install` makes setup_url unavailable and redirects to the callback
instead (we keep it **off**, so install and user authorization stay separate steps).

Files: spec, `deploy/APPLY.md` (App settings), `src/config/env.ts` (optional env bootstrap for client
id/secret), migration 010 (`github_app_config` gains `client_id`, `client_secret_v1` encrypted,
`app_slug`).

## Phase 1: connect and identity

**C1. Connect flow (install → return to Plane).**
- Workspace page shows **Connect GitHub** → `https://github.com/apps/<app_slug>/installations/new?state=<signed nonce>`.
  The nonce binds workspace slug, Plane user and expiry, and is stored server-side (single use).
- `GET /git-sync/install/github/callback?installation_id=…&setup_action=…&state=…`:
  1. verify and consume the state;
  2. **never trust `installation_id` from the URL.** GitHub's best-practices guide says to verify
     access with a user access token: `GET /user/installations` (Context7: "Verify which
     organizations a user access token has access to"). So the callback first runs C2's user
     authorization if this admin has no GitHub token, then confirms the installation id is in
     that user's `/user/installations`;
  3. fetch the installation account (`GET /app/installations/{id}` with the App JWT) and allow-list
     it for the workspace. The existing rule that one installation belongs to one workspace makes a
     second workspace's attempt fail with a clear error (as Plane's does).
- The page shows the connected org's name and avatar, and a **Disconnect** button (removes the
  allow-list row; the mappings become disabled, as today).
- `setup_action=update` (repositories added or removed) re-runs mapping verification (A14 path).

Files: `src/ui/api.ts` (routes), new `src/ui/install-flow.ts`, `src/ui/client/Workspace.tsx`,
`src/db` (state nonces table, migration 010). Tests: forged installation id refused; state replay
refused; expired state refused; org already connected elsewhere refused; happy path allow-lists.

**C2. Personal GitHub account linking (OAuth for the GitHub App).**
- **Connect personal account** → `https://github.com/login/oauth/authorize?client_id=…&redirect_uri=…&state=…&code_challenge=…&code_challenge_method=S256`.
  Context7 (GitHub, web application flow): `state` "an unguessable random string … against
  cross-site request forgery"; PKCE `code_challenge` "strongly recommended", method `S256`.
- Callback exchanges the code: `POST https://github.com/login/oauth/access_token` with client id,
  secret, code and `code_verifier`. Store `access_token`, `refresh_token`, both expiries, encrypted,
  in the existing token vault (`user_tokens` kind `github_oauth`, which already exists but is unused).
- Identify the user with `GET /user` and write `user_map` (Plane user ↔ GitHub id and login),
  clearing any unlink tombstone for this user (review-4 F11 semantics stay).
- **Refresh**: Context7 (GitHub, "Refreshing user access tokens"): `POST /login/oauth/access_token`
  with `grant_type=refresh_token`, `client_id`, `client_secret`, `refresh_token`; it "returns a new
  access token and a new refresh token". Refresh ahead of expiry, under a per-user lock; on
  refresh failure mark the link "needs re-authorization" and fall back to the service identity
  (never drop the write; same rule as review-4 F10 for Plane tokens).
- **Attribution**: GitHub writes for a linked user use their user token, so comments appear as them.
  The App's installation must still cover the repository; otherwise use the installation token and
  attribute in the text, as today.
- **Disconnect** deletes the tokens and the user_map row, and writes the tombstone.
- Workspace members (not only admins) may link **their own** account; admins keep manual linking.

Files: `src/ui/api.ts`, new `src/ui/oauth-flow.ts`, `src/auth/identity.ts`, `src/db/ledgers.ts`,
`src/sync/github.ts` (user-token client), `src/ui/client/Workspace.tsx`. Tests: state and PKCE checks,
code exchange, refresh rotation, refresh failure falls back to the service identity, disconnect.

**C3. User-scoped repository picker.**
- The mapping dialog lists repositories with the admin's user token:
  `GET /user/installations/{installation_id}/repositories` (Context7 REST: "repositories that the
  authenticated user has explicit permission … to access for an installation", paginated, max 100
  per page). Follow every page (audit contract 3).
- The server re-checks on save that the chosen repository is in that list for this user (the UI
  list is not trusted), then runs the existing mapping verifier.
- Without a linked account, the picker explains that linking is required (manual id entry stays for
  instance admins).

Files: `src/ui/api.ts`, `src/ui/mapping-check.ts`, `src/ui/client/Workspace.tsx`. Tests: repo outside
the user's list refused even with a forged request; pagination; unlinked user.

## Phase 2: sync behavior

**C4. Per-mapping open/closed states.**
- Mapping gains `open_state_id` and `closed_state_id` (migration 010), chosen from the project's
  states in the mapping dialog (the existing states list; triage states excluded).
- Mirror (`src/sync/mirror.ts` closed/reopened branch) uses them, falling back to today's default
  *completed* / *unstarted* states when unset or no longer present.
- Plane → GitHub direction: any state in the **completed** or **cancelled** group closes the GitHub
  issue (`state_reason` `completed` or `not_planned`); other groups reopen it.

Tests: chosen states applied; deleted state falls back; cancelled → `not_planned`.

**C5. Cross-links on mirrored issues.**
- When a mirror pair is created: add a **Plane link** to the GitHub issue URL (v1.4.2 links
  endpoint, the same `links/` path the PR rollup already uses; Plane's current API docs show the
  same shape: `url` required, `title` optional), and post **one GitHub comment** linking the Plane
  work item.
- Both are durable outbox intents with stable keys, so replays never duplicate them; gated by the
  mapping's linkback toggle.

Tests: one link and one comment per pair, including after a replay; linkback off posts nothing.

**C6. Mentions.**
- GitHub → Plane: `@login` for a mapped user becomes
  `<mention-component entity_identifier="<plane user id>" entity_name="user_mention"></mention-component>`
  (verified in Plane v1.4.2's `bgtasks/notification_task.py`, which parses exactly these attributes;
  Plane's sanitizer allows `mention-component` with `id`, `entity_identifier`, `entity_name`).
  Unmapped users become a link to their GitHub profile.
- Plane → GitHub: a mention of a mapped Plane user becomes `@login`; otherwise their display name.
- Only inside mirrored descriptions and comments; code spans and code blocks are left alone.
- Echo safety: the converted text is part of what the echo ledger hashes.

Tests: mapped and unmapped both ways; code blocks untouched; a round trip does not loop.

**C7. GitHub issue references in Plane.**
- In GitHub → Plane descriptions and comments, `#123`, `owner/repo#123` and full issue URLs become
  links to `https://<web origin>/owner/repo/issues/123`, labelled `owner/repo#123`.
- The web origin comes from the configured GitHub host (C8), never hardcoded github.com.

Tests: all three forms; inside code untouched; GHES origin used.

## Phase 3: GitHub Enterprise

**C8. GitHub Enterprise Cloud (ghe.com) and Server.**
- Admin page gets an edition toggle: **GitHub.com**, **GitHub Enterprise Cloud (ghe.com)** with an
  enterprise subdomain, or **GitHub Enterprise Server** with a base URL.
- Derived hosts: github.com uses `api.github.com` / `github.com`; ghe.com uses `api.<sub>.ghe.com` /
  `<sub>.ghe.com`; GHES uses `<base>/api/v3` / `<base>`. The OAuth endpoints (C2) and install URL
  (C1) use the web origin of the chosen edition.
- One App per Plane install stays (ours is per instance, Plane's is per workspace). A per-workspace
  App would need a credentials table keyed by workspace; recorded as a later option, not in scope.

Tests: host derivation for all three; OAuth and install URLs per edition.

## Order and parallelism

1. C0 (spec + migration 010 + App settings) first; everything depends on it.
2. Then in parallel, with disjoint files: **C1 + C2 + C3** (one owner: they share the OAuth and
   install plumbing), **C4 + C5** (mirror owner), **C6 + C7** (a new `src/sync/text.ts` converter
   used by the mirror), **C8** (config and admin UI).
3. After coding: full typecheck, all oracles, whole suite once; then an end-to-end run against
   the real test App and test Plane: connect, link a personal account, map through the picker,
   label-sync both ways with mentions, references and cross-links, close and reopen with chosen
   states.

## Risks

- **Client secret handling**: stored encrypted like the private key; never sent to the browser.
- **Token refresh races**: two workers refreshing the same user token invalidate each other; the
  per-user lock and single-flight refresh prevent it.
- **Callback spoofing**: both callbacks require a signed, single-use state; installation ids are
  confirmed through `/user/installations`, never trusted from the URL.
- **Test environment**: the test App's webhook already goes through smee.io; the two callback URLs
  point at the Tailscale address, which only the user's browser needs to reach.
