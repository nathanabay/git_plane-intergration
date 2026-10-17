# Appendix A · All routes

Every address the git-sync service answers lives under `/git-sync`, on the same origin as Plane. The reverse proxy that serves Plane forwards `/git-sync/*` to the git-sync container on port 3100. In this appendix, `<slug>` is the workspace slug (for example `acme`), and the IDs are Plane IDs.

**Who may call:**

- **Member**: any signed-in Plane member of that workspace (Plane web session cookie).
- **Workspace admin**: Plane workspace role Admin.
- **Instance admin**: a Plane God mode session.
- **Signed**: requests verified with an HMAC signature, no cookie.
- **Anyone**: no authentication.

Every call that changes something (POST, PUT, PATCH, DELETE) must also carry the service's own `Origin`, so cross-site requests are refused.

## Pages (browser)

| Address | Page | Who may open it |
|---|---|---|
| `/git-sync/ui/workspaces/<slug>` | **Git sync: &lt;slug&gt;**, **Repositories** tab (connection, mapped repositories, map a repository) | Workspace admin |
| `/git-sync/ui/workspaces/<slug>/mappings/<id>` | Mapping **Settings** | Workspace admin |
| `/git-sync/ui/workspaces/<slug>/mappings/<id>/policies` | Mapping **Conflict policies** | Workspace admin |
| `/git-sync/ui/workspaces/<slug>/mappings/<id>/rules` | Mapping **Rules** | Workspace admin |
| `/git-sync/ui/workspaces/<slug>/mappings/<id>/dry-run` | Mapping **Test rules** | Workspace admin |
| `/git-sync/ui/workspaces/<slug>/users` | **User links** | Workspace admin |
| `/git-sync/ui/workspaces/<slug>/audit` | **Audit log**; optional `?mappingId=<id>`, `?errors=1`, `?hours=<1–8760>` | Workspace admin |
| `/git-sync/ui/workspaces/<slug>/account` | **My GitHub account** | Member |
| `/git-sync/ui/workspaces/<slug>/projects/<projectId>/work-items/<issueId>/development` | The **Development** panel of one work item (Plane shows it in the work-item sidebar) | Member who can see the work item |
| `/git-sync/ui/admin` | **Git sync: instance settings** | Instance admin |
| `/git-sync/ui/admin/audit` | **Instance audit**; `?scope=all` adds every workspace's activity, and the same filters as above apply | Instance admin |

Inside Plane, the patched navigation opens these pages in a frame:

- **Workspace settings → GitHub Sync** (`/<slug>/settings/git-sync/`) for workspace admins.
- God mode's **GitHub Sync** (`/god-mode/git-sync/`) for instance admins.

Members do not see the **GitHub Sync** menu item, so they open `/git-sync/ui/workspaces/<slug>/account` directly.

## Webhooks, callbacks and health

| Method | Address | Who calls it | Purpose |
|---|---|---|---|
| POST | `/git-sync/webhooks/github` | GitHub (Signed: `X-Hub-Signature-256` with the App's webhook secret) | GitHub App events |
| POST | `/git-sync/webhooks/plane` | Plane (Signed: `X-Plane-Signature` with the Plane webhook secret; the previous secret is also accepted during rotation) | Plane workspace events |
| GET | `/git-sync/oauth/github/callback` | GitHub, redirecting the browser | Finishes **Connect personal account** (the App's *Callback URL*) |
| GET | `/git-sync/install/github/callback` | GitHub, redirecting the browser | Finishes an App installation (the App's *Setup URL*) |
| GET | `/git-sync/healthz` | Anyone | Liveness check used by the container health check |

## Configuration API (`/git-sync/api`)

### Personal account (Member)

| Method | Path | Purpose |
|---|---|---|
| GET | `/workspaces/<slug>/github/account` | The viewer's link state |
| POST | `/workspaces/<slug>/github/account/connect` | Start GitHub authorization (returns the authorize URL) |
| DELETE | `/workspaces/<slug>/github/account` | Disconnect personal account |

### Workspace (Workspace admin)

| Method | Path | Purpose |
|---|---|---|
| GET | `/workspaces/<slug>/github/connection` | Connected installations and pending approvals |
| POST | `/workspaces/<slug>/github/connect` | Start an App installation (**Connect GitHub**) |
| POST | `/workspaces/<slug>/github/connect/handoff` | Create a link for an organization owner |
| GET | `/workspaces/<slug>/github/claimable` | Installations the admin may claim |
| POST | `/workspaces/<slug>/github/installations/<installationId>/claim` | Claim an installation for this workspace |
| DELETE | `/workspaces/<slug>/github/installations/<installationId>` | **Disconnect** an installation |
| GET | `/workspaces/<slug>/github/repositories` | Repositories for the picker (through the admin's own GitHub link) |
| GET | `/workspaces/<slug>/github/user?login=<login>` | **Look up id** of a GitHub login |
| GET | `/workspaces/<slug>/github/repository?name=<owner/repo>` | Look up one repository |
| GET | `/workspaces/<slug>/defaults` | Instance defaults for new mappings |
| GET | `/workspaces/<slug>/projects` | Plane projects |
| GET | `/workspaces/<slug>/members` | Plane members |
| GET | `/workspaces/<slug>/projects/<projectId>/states` | A project's states |
| GET / POST | `/workspaces/<slug>/mappings` | List / add mappings |
| PATCH / DELETE | `/workspaces/<slug>/mappings/<id>` | Edit / remove a mapping |
| POST | `/workspaces/<slug>/mappings/<id>/backfill` | Backfill an existing repository |
| GET / PUT | `/workspaces/<slug>/mappings/<id>/rules` | Current rules / save a new version |
| GET | `/workspaces/<slug>/mappings/<id>/rules/versions` | **Rule versions** |
| POST | `/workspaces/<slug>/mappings/<id>/rules/versions/<version>/restore` | **Restore** a version |
| GET / PUT | `/workspaces/<slug>/mappings/<id>/conflict-policies` | Conflict policies |
| POST | `/workspaces/<slug>/dry-run` | **Run dry-run** (changes nothing) |
| GET | `/workspaces/<slug>/user-links` | Linked GitHub accounts |
| PUT / DELETE | `/workspaces/<slug>/user-links/<planeUserId>` | **Link account** / **Unlink** |
| GET | `/workspaces/<slug>/health` | Sync health |
| GET | `/workspaces/<slug>/audit` | Audit log entries |
| POST | `/workspaces/<slug>/audit/<id>/replay` | **Replay** a stored delivery |
| POST | `/workspaces/<slug>/outbound-writes/<id>/retry` | Retry a failed write |

### Development panel (Member)

| Method | Path | Purpose |
|---|---|---|
| GET | `/workspaces/<slug>/projects/<projectId>/work-items/<issueId>/development` | Panel data |
| POST | `/workspaces/<slug>/projects/<projectId>/work-items/<issueId>/branches` | **Create branch** (project members only) |

### Instance (Instance admin)

| Method | Path | Purpose |
|---|---|---|
| GET | `/instance/setup-check` | **Setup checks** |
| GET | `/instance/health` | **Connection health** |
| GET / PUT | `/instance/github-app` | **GitHub App** (secrets never returned; blank keeps the stored one) |
| GET / PUT | `/instance/magic-words` | **Magic words** |
| GET / PUT | `/instance/settings` | **Defaults** |
| GET | `/instance/installations` | **Workspace GitHub App installations** |
| PUT / DELETE | `/instance/installations/<installationId>` | Allow-list / remove an installation |
| GET | `/instance/workspaces` | Workspaces (from Plane) |
| GET | `/instance/workspaces/<slug>/projects` | A workspace's projects (for manual recovery) |
| POST | `/instance/workspaces/<slug>/mappings` | **Add manual mapping** |
| PATCH | `/instance/workspaces/<slug>/mappings/<id>` | Edit a mapping as instance admin |
| DELETE | `/instance/workspaces/<slug>/stale-data` | Remove the data of a deleted workspace whose slug was reused |
| GET | `/instance/disabled-mappings` | **Disabled repository mappings** |
| GET | `/instance/audit` | Instance audit |

## Source files

- `src/ui/client/router.ts` (pages)
- `src/ui/api.ts` (configuration API)
- `src/ui/dev-panel.ts` (Development panel)
- `src/api/handler.ts` (webhooks)
- `src/ui/oauth-flow.ts`, `src/ui/install-flow.ts` (callbacks)
- `src/index.ts` (`/git-sync/healthz`)
- `src/app/main.ts` (disabled mappings)
