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

