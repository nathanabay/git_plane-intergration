# Appendix B · Settings and environment variables

git-sync keeps its configuration in three places:

1. **Environment variables** in `git-sync.env`. The installer writes this file next to Plane's own `plane.env`, and it is read when the container starts.
2. **Instance settings** that an instance admin edits in God mode.
3. **Mapping settings** that a workspace admin edits per repository.

## Environment variables (`src/config/env.ts`)

Changing an environment variable takes effect only after the git-sync container restarts.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `DATABASE_URL` | yes | — | PostgreSQL connection for git-sync's own schema (the installer reuses Plane's Postgres server) |
| `REDIS_URL` | yes | — | Valkey/Redis for the job queues (Plane's Valkey) |
| `QUEUE_PREFIX` | no | `gitsync` | Prefix of the queue keys |
| `PORT` / `HOST` | no | `3100` / `0.0.0.0` | Where the service listens |
| `PLANE_BASE_URL` | yes | — | Plane's API as seen from the container (internal address) |
| `PLANE_SERVICE_PAT` | yes | — | API key of the bot service account in Plane |
| `PLANE_SERVICE_USER_ID` | yes | — | Plane user ID of that bot; its own changes are recognized and not echoed back |
| `PLANE_WEBHOOK_SECRET` | yes | — | Secret of the Plane workspace webhook |
| `PLANE_WEBHOOK_SECRET_PREVIOUS` | no | — | Old Plane webhook secret, still accepted while you rotate it |
| `PLANE_SESSION_COOKIE_NAME` | no | `session-id` | Must match Plane's `SESSION_COOKIE_NAME` |
| `PLANE_API_RATE_PER_MINUTE` | no | `60` | Requests per minute git-sync may send to Plane; must equal Plane's `API_KEY_RATE_LIMIT` |
| `GITSYNC_TOKEN_KEY` | yes | — | 32-byte key that encrypts stored secrets and tokens. **Never change it** on a running install, or stored App credentials and member tokens can no longer be decrypted. |
| `PUBLIC_ORIGIN` | no | `https://tasks.qelal.et` | The public URL of Plane (used in links, callbacks and the CSRF origin check). The installer always sets it. |
| `GITHUB_APP_ID` | no¹ | empty | GitHub App ID (bootstrap) |
| `GITHUB_PRIVATE_KEY_PATH` | no¹ | empty | Path of the App's `.pem` file inside the container |
| `GITHUB_WEBHOOK_SECRET` | no¹ | empty | The App's webhook secret |
| `GITHUB_CREDENTIAL_MARKER_PATH` | no | `/var/lib/gitsync/credentials/bootstrap-retired` | Records that bootstrap credentials were replaced in the UI |
| `GITHUB_EDITION` | no | `github` | `github`, `ghe_cloud` or `ghes` |
| `GITHUB_GHE_SUBDOMAIN` | with `ghe_cloud` | — | Enterprise name before `.ghe.com` |
| `GITHUB_GHES_BASE_URL` | with `ghes` | — | Enterprise Server URL |
| `GITHUB_API_BASE_URL` | no | derived | Legacy way to set the API host |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | no² | — | OAuth client of the App, for **Connect personal account** |
| `GITHUB_APP_SLUG` | no | — | App slug, for the **Connect GitHub** install link |
| `REQUIRE_VERIFIED_COMMITS` | no | `false` | `1`, `true` or `yes`: Smart Commit commands run only for commits GitHub marks as verified. **This is the switch that is enforced** (see Appendix E). |

¹ The three App variables are set together or left empty together. When they are empty, the App is configured in God mode and stored encrypted in the database. App credentials saved in God mode take priority over the environment.

² Both are set together. They can also be entered in God mode.

### Installer-only variables

| Variable | Used by | Meaning |
|---|---|---|
| `GITSYNC_PLANE_PAT` | `install.sh -y` | The bot's Plane API key, for a non-interactive install |
| `GITSYNC_PLANE_WEBHOOK_SECRET` | `install.sh -y` | Plane webhook secret |
| `GITSYNC_GITHUB_WEBHOOK_SECRET` | `install.sh -y` with `--github-app-id` | GitHub webhook secret |

In Plane's own `plane.env`, the installer relies on two variables:

- `WEBHOOK_ALLOWED_HOSTS` must include `git-sync.internal`, so that Plane may call `http://git-sync.internal:3100/git-sync/webhooks/plane`.
- `API_KEY_RATE_LIMIT` must match `PLANE_API_RATE_PER_MINUTE`.

## Instance settings (God mode → GitHub Sync)

| Section | Field | Default | Notes |
|---|---|---|---|
| **GitHub App** | **App ID**, **Private key (PEM)**, **Webhook secret**, **App slug**, **OAuth client ID**, **OAuth client secret**, **GitHub edition** (plus **Enterprise Cloud subdomain** or **Enterprise Server URL**) | — | Secrets are encrypted and never shown again; leave a secret empty to keep the stored one |
| **Defaults** | **Enable Smart Commits for newly mapped repositories** | on | Pre-ticks **Smart Commits** in the mapping form |
| **Defaults** | **Require signed commits for Smart Commits** | the value of `REQUIRE_VERIFIED_COMMITS` | Stored and shown, but **not applied** by this release; use the environment variable |
| **Defaults** | **Reconciliation interval (minutes)** | 60 | How often missed webhooks are reconciled (1–10080) |
| **Defaults** | **Echo-suppression TTL (minutes)** | 10 | How long an applied change is remembered so it is not synced back (1–10080) |
| **Magic words** | closing, non-closing and relation lists | see Appendix C | Lowercase letters and spaces, up to 40 characters, 1–100 per tier, one tier per word |
| **Workspace GitHub App installations** | **Installation ID**, **Workspace**, **Account / Org (optional)** | — | One installation belongs to one workspace |

Database-only retention settings, with no UI:

- Webhook deliveries are kept 30 days.
- Processed commits are kept 180 days.
- Audit payloads are kept 90 days.
- Finished outbound writes are kept 30 days.

## Mapping settings (Workspace settings → GitHub Sync)

| Field | Values | Default |
|---|---|---|
| **GitHub repository** / **Plane project** | one repository ↔ one project | — |
| **Sync direction** | **Two-way**, **GitHub to Plane only** | Two-way |
| **Open state** / **Closed state** | a project state or **Project default** | Project default |
| **Smart Commits** | on / off | the instance default |
| **Post link-back comments on GitHub** | on / off | on |
| **Report problems as comments on GitHub and Plane** | on / off | off |
| **GitHub autolink references (unavailable)** | disabled | — |
| Branch name template | `{key}`, `{title-slug}`, `{username}` | `{key}-{title-slug}` (no UI to change it) |
| **Conflict policies** (title, description, state, assignees, labels, comments) | **Last write wins**, **GitHub is the source of truth**, **Plane is the source of truth** | title and description: GitHub is the source of truth; the rest: last write wins |
| **Rules** | lifecycle table, branch-aware rules or YAML | the shipped defaults (Appendix D) |

## Source files

- `src/config/env.ts`
- `src/install/env-file.ts`, `install.sh`
- `src/ui/validate.ts`
- `src/ui/client/Admin.tsx`, `src/ui/client/Workspace.tsx`
- `src/db/migrations/*.sql`
