# Part B: GitHub UI and Sync

### B1 Plane UI fork for instance admin
**Files:** apps/admin/app/(all)/(dashboard)/components/nav.tsx, apps/admin/app/(all)/(dashboard)/routes/git-sync-iframe.tsx, apps/admin/app/routes.ts
**Depends:** none
**Acceptance:** Instance admin navigation includes a working iframe route.

Following §8, we fork the Plane `apps/admin` frontend to embed our sync UI. We modify exactly three files (nav entry, route component, and route registry), limiting the fork surface to six files total across both apps. This uses Plane's API for auth and role verification before managing global settings, including the GitHub App installation.

**GitHub App Permission Set:**
*   Repository permissions: Pull requests Read+Write, Issues Read+Write, Contents Read+Write, Checks Read-only, Deployments Read-only, Administration Write (only if autolinks are enabled).
*   Organization permission: Members Read-only.
*(Note: Adding a permission later forces re-consent on every existing installation.)*

### B2 Plane UI fork for workspace settings
**Files:** apps/web/app/(all)/(dashboard)/components/nav.tsx, apps/web/app/(all)/(dashboard)/routes/git-sync-iframe.tsx, apps/web/app/routes.ts
**Depends:** none
**Acceptance:** Workspace settings navigation includes a working iframe route.

Following §8, we fork the Plane `apps/web` frontend, maintaining the six-file fork limit across both apps. This uses three files to embed the route. It validates the viewer via Plane's API and checks workspace role (admin/owner) before rendering or accepting mapping writes.

### B3 Embedded React configuration app
**Files:** src/ui/app.tsx, src/ui/api.ts
**Depends:** none
**Acceptance:** Serves the config UI via two entry routes for admin and workspace settings.

Following §8, all real UI is one React app in this repo with two entry routes (instance-admin and workspace-settings) and a config API. It provides surfaces for repo to project mappings, state mappings and rule sets, sync direction, conflict policies, per-repo Smart Commits toggle, and per-user account linking. It also exposes the interfaces for section 7.6 operational features like dry-run, audit log with replay, and backfill UI.

### B4 Smart Commits parser and execution
**Files:** src/github/smart-commits.ts
**Depends:** A4
**Acceptance:** Extracts commands and applies them using the correct actor identity.

Implements the Jira grammar for Smart Commits, supporting `#comment`, `#time`, and `#<transition>`. Following section 7.2, it applies the per-repo toggle. Resolves `#<transition>` scoped by `(project, group)` with name as fallback (section 7.1), with a loud-failure rule for a nonexistent target state. A config option requires `verification.verified == true` before honouring commands. For attribution, it strictly trusts `sender`, never `pusher` or the commit author, gracefully falling back to the service account (and recording it in the audit log) when `sender` is `ghost`, a bot, or unmapped. All Plane writes are issued through A4's client, never directly.

