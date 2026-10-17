# Plane UI Forks

This directory contains patches and build scripts for the Plane UI forks needed to integrate GitHub Sync.

## Fork Surface

The fork surface is intentionally minimal to make upgrading to newer Plane versions easier. We only modify the following files:

### Admin App
- `apps/admin/app/(all)/(dashboard)/sidebar-menu.tsx` (nav entry)
- `apps/admin/app/routes.ts` (route registration)
- `apps/admin/app/(all)/(dashboard)/git-sync/page.tsx` (route component rendering the iframe)

### Web App
- `apps/web/core/components/settings/workspace/sidebar/item-categories.tsx` (nav entry for admins and members; members get only their own GitHub account page)
- `apps/web/app/routes/extended.ts` (route registration)
- `apps/web/app/(all)/[workspaceSlug]/(settings)/settings/(workspace)/git-sync/page.tsx` (route component rendering the iframe)
- `packages/constants/src/settings/workspace.ts` (`WORKSPACE_SETTINGS_ACCESS` entry for `/settings/git-sync`, admins and members, never guests; the settings layout refuses unlisted paths)
- `apps/web/core/components/issues/issue-detail/sidebar.tsx` (the work-item Development panel: an iframe at the end of `IssueDetailsSidebar`)

Eight files in total: admin 3, web 5. `scripts/verify-fork-patch.mjs all` enforces these limits, applies the patches to a pristine v1.4.2 checkout, compares the mirrored files, and checks the settings routes and the Development panel iframe.

The new routes and the work-item sidebar render `<iframe>` elements pointing to the synchronization service.

## Upgrading Plane

To rebuild the fork for a newer Plane version:

1. Update the `v1.4.2` tags in `build-fork-image.sh` for both `apps/admin` and `apps/web`.
2. Generate new patches: clone the new Plane version, apply the changes manually following the fork surface above, and generate the patches using `git diff`.
3. Run the build scripts to build and tag the new Docker images.
4. Replace the old patches and build scripts in this repository.

Note that `apps/web` moves faster than `apps/admin` — expect the nav array to be the recurring conflict.

## GitHub App Permissions

Configure the App on the GitHub host selected for this service instance. The required set is:

| Scope | Permission | Access |
| --- | --- | --- |
| Repository | Pull requests | Read & write |
| Repository | Issues | Read & write |
| Repository | Contents | Read & write |
| Repository | Checks | Read |
| Repository | **Commit statuses** | **Read** |
| Repository | Deployments | Read |
| Repository | Metadata | Read |
| Organization | Members | Read |
| Repository, only when autolinks are enabled | Administration | Read & write |

These match [GitHub's App permission reference](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps) (Context7 `/websites/github_en_rest`). Checks and commit statuses are separate permissions; readiness reads both. Administration is conditional on autolink management. Existing installations must accept newly requested permissions before they take effect; enterprise-owned registrations can have automatic acceptance rules. See [changing App permissions](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration) (Context7 `/github/docs`).

## GitHub App Webhook Events

Enable the App webhook at `<PUBLIC_ORIGIN>/git-sync/webhooks/github` with `GITHUB_WEBHOOK_SECRET`, and select these nine subscriptions used by the reducers:

| GitHub settings label | Event name |
| --- | --- |
| Pull request | `pull_request` |
| Pull request review | `pull_request_review` |
| Push | `push` |
| Issues | `issues` |
| Issue comment | `issue_comment` |
| Check suite | `check_suite` |
| Check run | `check_run` |
| Status | `status` |
| Deployment status | `deployment_status` |

GitHub also sends `installation` and `installation_repositories` automatically; they are not manual subscriptions. Checks stays Read: suite completion is sufficient; suite `requested`/`rerequested` actions require Write and are not required here. [Webhook events and permission requirements](https://docs.github.com/en/webhooks/webhook-events-and-payloads) (Context7 `/websites/github_en`).

## App Callbacks and Host Configuration

The parity C0 callback contract is:

- **Callback URL** (`callback_urls[]`): `<PUBLIC_ORIGIN>/git-sync/oauth/github/callback`.
- **Setup URL** (`setup_url`): `<PUBLIC_ORIGIN>/git-sync/install/github/callback`.
- **Redirect on update** (`setup_on_update`): enabled.
- **Request user authorization during installation** (`request_oauth_on_install`): disabled, so the setup redirect remains available.

These service callback handlers are wave 2 work; activate the redirects once those handlers are deployed. GitHub's OAuth and setup callbacks have different purposes. [App registration settings](https://docs.github.com/en/apps/creating-github-apps/setting-up-a-github-app/creating-a-github-app-using-url-parameters) (Context7 `/websites/github_en`).

Optional bootstrap variables are `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` (supply both together), and `GITHUB_APP_SLUG`. The Client ID is distinct from `GITHUB_APP_ID`; wave 2 will consume the bootstrap into encrypted App settings. Host selection uses `GITHUB_EDITION=github|ghe_cloud|ghes`, `GITHUB_GHE_SUBDOMAIN` for Cloud, or `GITHUB_GHES_BASE_URL` for Server. `GITHUB_API_BASE_URL` remains the legacy API-only bootstrap and must agree with any explicit edition/host. `GITHUB_WEB_ORIGIN` is derived, not an environment override.

| Edition | Host input | REST API base | Web/OAuth/install origin |
| --- | --- | --- | --- |
| `github` | None | `https://api.github.com` | `https://github.com` |
| `ghe_cloud` | Subdomain `octocorp` | `https://api.octocorp.ghe.com` | `https://octocorp.ghe.com` |
| `ghes` | `https://ghe.example` | `https://ghe.example/api/v3` | `https://ghe.example` |

OAuth paths are `/login/oauth/authorize` and `/login/oauth/access_token` on the selected web origin; the installation path is `/apps/<app-slug>/installations/new`. Host and URL builders land in wave 1; stored credential/UI wiring follows in wave 2. Sources: [ghe.com hosts](https://docs.github.com/en/get-started/learning-about-github/about-versions-of-github-docs), [GHES App URLs and registration](https://docs.github.com/en/apps/creating-github-apps/setting-up-a-github-app/making-your-github-app-available-for-github-enterprise-server), [installation links](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/migrating-oauth-apps-to-github-apps) (Context7 `/websites/github_en`). Full setup and verification: [deployment runbook](../deploy/APPLY.md#github-app-registration).

## AGPL-3.0 Note

Internal use of a fork is fine, but publishing source becomes required if offered to third parties under the AGPL-3.0 license.
