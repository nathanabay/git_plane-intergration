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

### B5 PR and branch automation rules
**Files:** src/github/pr-automation.ts
**Depends:** A6, A4
**Acceptance:** Compiles PR lifecycle events into A6 rules cleanly.

Formats branch names and compiles lifecycle mappings and branch-regex rules into A6 engine rules. Following section 7.1, it maps lifecycle points to states (like In Progress, Done). It relies on A4's single write path to enforce the prohibition against writing into the `triage` group. Plane writes are issued exclusively through A4's client, never directly.

### B6 Two-way issue mirroring logic
**Files:** src/sync/mirror.ts
**Depends:** A4, A3
**Acceptance:** Replicates fields according to conflict policies and sync directions.

Handles the label-gated mechanism for mirroring issues between systems, creating a cross-link confirmation comment. Following section 7.3, it synchronises the field list including title, description, state, assignees, labels, and comments. Enforces the sync direction and resolves collisions using conflict policies (shipping defaults: `source_of_truth:github` for title/description, `last_write_wins` for state and assignees). Plane writes are issued exclusively through A4's client, never directly.

### B7 Development information rollup
**Files:** src/sync/dev-info.ts
**Depends:** A4, A3
**Acceptance:** Rolls up branch, commit, check, and deployment data as links.

Surfaces branches, commits, PRs, check and deployment rollups. Since duplicate link URLs are rejected, rollups must be updated in place via `/links/{pk}/`, retaining link ids and reconciling with A4. Following section 7.4, previews are detected by provider (Vercel, Netlify, Cloudflare Pages, AWS Amplify) and markdown links ending in "Preview". Title prefix is only for categorised links. Autolinks remain off by default because they need the `Administration: Write` permission. Plane writes are issued exclusively through A4's client, never directly.

### B8 Operational features implementation
**Files:** src/operations/tooling.ts
**Depends:** A6, A3, A2, A4
**Acceptance:** Allows manual replay of webhook events and supports dry-run.

Implements dry-run/simulate (using A6's no-write mode) to test rules safely. Following section 7.6, it provides an audit log (using A3's audit table) with manual replay for deliveries (via A2/A4 ingress and outbound workers) and a backfill on connect to scan existing data.

### B9 Attribution, identity mapping and rate limits
**Files:** src/auth/identity.ts
**Depends:** none
**Acceptance:** Authenticates user credentials and resolves exact email matches.

Manages credentials securely. Following §9, the service PAT uses a least-privileged account, while per-user PATs are full-privilege. It implements email-based user mapping requiring exactly one match. Concrete PAT obligations: encrypt at rest, never log, and provide a UI revocation path that invalidates the stored token. Rate-limit backoff belongs to A4's outbound workers.

