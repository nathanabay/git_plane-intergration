# Our self-hosted Plane v1.4.2 ↔ GitHub sync service: user flows and UI/UX as built (branch `seal`)

Scope and method: read-only code reading of the working tree at `/home/claudeuser/orca/workspaces/git_plane-intergration/seal` on 2026-10-12. The tree contains uncommitted fixes in progress (`git status` shows ~50 modified files and new `src/github/errors.ts`, migration `009-plane-ingress-spool-link-visibility.sql`, `docs/impl/fixes-audit-G1..G5.md`); everything below describes the files as they are now. Sources are given as repository-relative `path:line` links. Line numbers refer to the current working-tree files. No web sources were used.

---

## 1. Entry points: Plane fork patches and the embedded config app (pages, controls, messages, access)

### Takeaway
There are exactly two screens. The Plane admin app (`/god-mode`) has a "GitHub Sync" sidebar item that opens an iframe at `/git-sync/ui/admin`, for instance admins only. Workspace Settings → Developer has a "GitHub Sync" item that opens an iframe at `/git-sync/ui/workspaces/:slug`, for workspace admins only (role 20). Plain members get no entry point and no UI at all. The UI is a single unstyled-by-Plane React app with plain forms, raw IDs, and no Plane design-system components.

### Cited Findings

**Fork surface (Plane frontends)**
- The fork touches 7 files: in the admin app, the nav entry, route registration and iframe page; in the web app, the iframe page, route registration, sidebar item and the `WORKSPACE_SETTINGS_ACCESS` entry. — [apps/README.md:7-19](apps/README.md); [spec §8](docs/superpowers/specs/2026-10-10-plane-github-sync-design.md) lines 474-485
- Admin sidebar: an item named "GitHub Sync", description "Manage GitHub synchronization.", inline GitHub SVG icon, href `/git-sync/`, appended after Plane's own menu items. — [apps/admin/app/(all)/(dashboard)/sidebar-menu.tsx:25-37](apps/admin/app/(all)/(dashboard)/sidebar-menu.tsx)
- Admin route `git-sync`. — [apps/admin/app/routes.ts:24](apps/admin/app/routes.ts)
- The admin page is only an iframe (`src="/git-sync/ui/admin"`, height `calc(100vh - 4rem)`, title "GitHub Sync Admin Configuration"). It has no loading or permission state of its own: it relies on the admin app's layout and the iframe's API auth. — [apps/admin/app/(all)/(dashboard)/git-sync/page.tsx:1-13](apps/admin/app/(all)/(dashboard)/git-sync/page.tsx)
- Workspace settings sidebar: a "GitHub Sync" item with the lucide `Github` icon, shown only under the "developer" category and only when `allowPermissions([EUserPermissions.ADMIN], WORKSPACE)`. — [apps/web/core/components/settings/workspace/sidebar/item-categories.tsx:70-79](apps/web/core/components/settings/workspace/sidebar/item-categories.tsx)
- Route `:workspaceSlug/settings/git-sync`, nested in Plane's settings layouts. — [apps/web/app/routes/extended.ts:10-20](apps/web/app/routes/extended.ts)
- `/settings/git-sync` is added to `WORKSPACE_SETTINGS_ACCESS` as `[EUserWorkspaceRoles.ADMIN]` only. Without this, Plane's settings layout renders "not authorized". — [packages/constants/src/settings/workspace.ts:67-71](packages/constants/src/settings/workspace.ts)
- Workspace page behaviour: a `LogoSpinner` while `workspaceUserInfo` loads, Plane's `NotAuthorizedView` for non-admins, otherwise `PageHead title="GitHub Sync"` and an iframe at `/git-sync/ui/workspaces/${workspaceSlug}` (height `calc(100vh - 8rem)`). — [apps/web/app/(all)/[workspaceSlug]/(settings)/settings/(workspace)/git-sync/page.tsx:17-46](apps/web/app/(all)/[workspaceSlug]/(settings)/settings/(workspace)/git-sync/page.tsx)
- No fork file touches the work-item (issue) detail page, the project settings, or the user profile. Nothing GitHub-specific renders natively on a Plane work item. — [apps/README.md:9-19](apps/README.md) (the file list is exhaustive)

**Embedded app routing** (`src/ui/client/router.ts`)
- Client routes: `/git-sync/ui/admin`, `/git-sync/ui/workspaces/:slug` (Repositories), `…/users` (User links), `…/audit` (Audit log), `…/mappings/:id` (Settings tab), `…/mappings/:id/policies`, `…/rules`, `…/dry-run`. Anything else is `notfound`. — [src/ui/client/router.ts:5-36](src/ui/client/router.ts)
- The not-found page reads "Page not found. This page is not part of the git-sync settings." and links to "Instance settings". — [src/ui/app.tsx:13-18](src/ui/app.tsx)

**Shared states and messages** (`src/ui/client/common.tsx`, `http.ts`)
- Loading: "Loading…" (`aria-busy`). Load error: the message plus a "Try again" button. 401/403: a panel titled "Not authorised" with the text "{what} Sign in to Plane with an account that has the right access, then reload this page." — [src/ui/client/common.tsx:67-91](src/ui/client/common.tsx)
- Save status for every form: "Saving…", then "Saved." or an error paragraph with `role="alert"`. — [src/ui/client/common.tsx:133-141](src/ui/client/common.tsx)
- Timestamps use the browser locale (`toLocaleString`); a null time shows "never". — [src/ui/client/common.tsx:143-147](src/ui/client/common.tsx)
- Network failure shows "Could not reach the git-sync service". Other errors show the server's `error` string, or "Request failed (status)". — [src/ui/client/http.ts:36-50](src/ui/client/http.ts)
- Server-side error strings reach the user verbatim, for example "Cross-site request refused", "Content-Type must be application/json", "GitHub rate limit reached; retry after the indicated deadline" (429 with `retryAt`), and "Internal error". — [src/ui/api.ts:97-132](src/ui/api.ts)
- Authentication messages: "Sign in to Plane to continue", "Workspace admin access is required", "Sign in to the Plane admin app to continue", "Plane is unreachable", "Plane could not verify the session". — [src/ui/plane-auth.ts:45-98](src/ui/plane-auth.ts)

**Instance admin page** ("Git sync: instance settings"; every API call needs a Plane instance-admin cookie `admin-session-id`) — [src/ui/client/Admin.tsx:12-26](src/ui/client/Admin.tsx); [src/ui/plane-auth.ts:17,90-98](src/ui/plane-auth.ts)
- If the health call answers 401/403, the whole page is replaced by Not authorised: "The instance settings need a Plane instance-admin session." — [src/ui/client/Admin.tsx:10,14](src/ui/client/Admin.tsx)
- Panel "Connection health" is a read-only list: Database (reachable/unreachable), GitHub App (configured/not configured), Repository mappings (count), Last sync activity, and "Failures in the last 24 hours", shown red when above 0. It has no refresh button. — [src/ui/client/Admin.tsx:50-67](src/ui/client/Admin.tsx)
- Panel "GitHub App" has fields "App ID" (numeric), "Private key (PEM)" (textarea, hint "Stored encrypted; it is never shown again."), "Webhook secret" (password, same hint) and "GitHub Enterprise base URL" (hint "Leave empty for github.com.", placeholder `https://github.example.com`), plus the button "Save GitHub App". The intro text is "A GitHub App is configured. Leave the secrets empty to keep the stored ones." or "No GitHub App is configured yet." — [src/ui/client/Admin.tsx:81-117](src/ui/client/Admin.tsx)
- Panel "Workspace GitHub App installations": a table (Workspace slug, Installation ID, Account / Org, Allow-listed at, and a red "Remove" button behind the confirm "Remove allow-list entry for installation {id}?"). The empty state is "No installations allow-listed yet.". Below it, the form "Allow-list an installation" has "Installation ID" (hint "Numeric GitHub App installation ID.", placeholder "e.g. 12345678"), "Workspace slug" (free text), "Account / Org (optional)" (display only) and the button "Allow-list installation". — [src/ui/client/Admin.tsx:120-236](src/ui/client/Admin.tsx)
- Panel "Disabled repository mappings": an explanation, a "Refresh mappings" button, and a table (Workspace, Repository, Project as a raw id, Installation or "Unresolved", Reason: "Save the mapping to verify its installation" or "Installation is not allowed for this workspace"). The empty state is "No disabled mappings.". — [src/ui/client/Admin.tsx:28-48](src/ui/client/Admin.tsx)
- Panel "Magic words": three textareas, "Closing words", "Non-closing words" and "Relation phrases", one entry per line, under the note "A word may belong to only one tier.", plus the button "Save magic words". — [src/ui/client/Admin.tsx:238-280](src/ui/client/Admin.tsx). Server error: `"word" is in both X and Y`. — [src/ui/validate.ts:179](src/ui/validate.ts)
- Panel "Defaults": a checkbox "Enable Smart Commits for newly mapped repositories", "Reconciliation interval (minutes)" (hint "How often missed webhooks are reconciled."), "Echo-suppression TTL (minutes)" (hint "How long an applied operation is remembered to stop sync loops.") and the button "Save defaults". — [src/ui/client/Admin.tsx:282-319](src/ui/client/Admin.tsx)

**Workspace admin page** ("Git sync: {slug}"; tabs Repositories / User links / Audit log; every API call checks Plane workspace role ≥ 20) — [src/ui/client/Workspace.tsx:16,21-37](src/ui/client/Workspace.tsx); [src/ui/plane-auth.ts:62-86](src/ui/plane-auth.ts)
- Repositories tab, "Mapped repositories" table: Repository, Plane project (raw UUID in `<code>`), Direction ("Two-way" or "GitHub to Plane"), an "Edit" link, and a red "Remove" button behind the confirm "Remove the mapping for {repo}? Its rules and conflict policies are deleted too." The empty state is "No repository is mapped to a project in this workspace yet." — [src/ui/client/Workspace.tsx:40-81](src/ui/client/Workspace.tsx)
- "Map a repository" form:
  - "GitHub repository" (`owner/repo` text, regex-checked) with a "Look up id" button.
  - "GitHub repository id" (numeric, required; hint "Numeric id; Look up id uses this service's GitHub server.").
  - "Plane project": a `<select>` filled best-effort from Plane's own `/api/workspaces/{slug}/projects/` using the browser session. If that fetch fails, a free-text "project id" input appears.
  - "Sync direction": Two-way, or GitHub to Plane only.
  - Checkboxes "Smart Commits", "Post link-back comments on GitHub", and a disabled "GitHub autolink references (unavailable)".
  - Button "Add mapping" or "Save changes".
  — [src/ui/client/Workspace.tsx:85-182](src/ui/client/Workspace.tsx)
- Server rejections on save: "That Plane project does not exist in this workspace", "The GitHub App is not installed on that repository", "That GitHub installation is not allowed for this workspace; ask an instance admin to allow-list it", "The repository id does not match…", "That repository is already mapped to that project" (409), and "Could not verify the mapping with Plane and GitHub" (502). — [src/ui/mapping-check.ts:48-72](src/ui/mapping-check.ts); [src/ui/api.ts:162-176,238](src/ui/api.ts)
- Mapping detail page: the heading is the repo full name, with sub-tabs "Settings", "Conflict policies", "Rules" and "Test rules". The Settings tab holds the same mapping form plus a "Backfill" section. An unknown id shows "That mapping does not exist in this workspace." and "Back to repositories". — [src/ui/client/Workspace.tsx:185-211](src/ui/client/Workspace.tsx)
- Conflict policies: six selects (Title, Description, State, Assignees, Labels, Comments), each "Last write wins", "GitHub is the source of truth" or "Plane is the source of truth", plus the button "Save policies". Intro: "Which side wins when both change the same field between syncs." — [src/ui/client/Workspace.tsx:213-248](src/ui/client/Workspace.tsx). Defaults: GitHub is the source of truth for title and description, last-write-wins for the rest. — [src/ui/validate.ts:16-21](src/ui/validate.ts)
- Rules tab, two modes switched by the buttons "Lifecycle mapping table" and "Raw YAML editor". — [src/ui/client/Workspace.tsx:268-543](src/ui/client/Workspace.tsx)
  - Table mode, "Lifecycle points → Plane state": 10 free-text inputs, one per lifecycle (Branch pushed, PR drafted, PR opened, Review requested, Changes requested, PR approved, Ready for merge, PR merged, PR closed without merge, PR reopened). States are typed as `group:Name` strings (placeholder "e.g. started:In Progress (leave blank for no change)"); there is no state dropdown. The hint text says "Map each §7.1 lifecycle point…", which leaks a spec section number. — [src/ui/client/Workspace.tsx:255-266,418-446](src/ui/client/Workspace.tsx)
  - "Merged base-branch regex" (default `^main$`), a "Branch-aware rules" table (Base branch regex, Lifecycle, Target state, Remove), the button "+ Add branch rule", the empty state "No branch-specific rules configured.", and the button "Save mapping table". — [src/ui/client/Workspace.tsx:448-521](src/ui/client/Workspace.tsx)
  - YAML mode: a "Rules (YAML)" textarea whose hint lists the triggers, plus the button "Validate and save YAML". Status line: "Saved version N." or "Using shipping defaults (not saved yet)." — [src/ui/client/Workspace.tsx:394-398,524-539](src/ui/client/Workspace.tsx)
  - Destructive confirms: switching YAML→table with custom YAML ("…will replace your rules with defaults upon save. Discard custom YAML?"), and saving the table over custom YAML ("…will overwrite your custom YAML rules. Overwrite?"). — [src/ui/client/Workspace.tsx:346,357](src/ui/client/Workspace.tsx)
  - Each save writes a new version row (`rule_sets.version`, `updated_by`). The UI shows only the current version number; it has no history or rollback view. — [src/ui/api.ts:293-314](src/ui/api.ts)
- Test rules (dry-run) tab:
  - Fields: "Event" select (`pull_request`, `pull_request_review`, `push` only), "Recorded delivery (audit entry id)", "Payload (JSON)" textarea, "Rules to test (YAML, optional)", and the button "Run dry-run".
  - Results: "That delivery is not an automation event.", or "Trigger: X. Matched rule N (name)." or "No rule matched.", followed by the actions as a JSON block or "No actions would run.".
  — [src/ui/client/Workspace.tsx:735-782](src/ui/client/Workspace.tsx); [src/ui/validate.ts:241](src/ui/validate.ts)
- Backfill section: the text "Link this repository's open pull requests and issues to the Plane work items they mention.", a "Run backfill" button, and a "Continue" button while incomplete. The result reads "Checked N pull requests and M issues: X links made, Y references did not match a work item." with "More items remain; continue to check the next batch." when incomplete. — [src/ui/client/Workspace.tsx:709-733](src/ui/client/Workspace.tsx)
- User links tab, "Linked GitHub accounts": a table (Plane user id as a raw UUID, GitHub login with "(id N)", and "Unlink" behind the confirm "Unlink {login}? Any credentials stored for this user are deleted."). The empty state is "No Plane users are linked to GitHub accounts yet. Unlinked users are attributed to the service account." — [src/ui/client/Workspace.tsx:546-585](src/ui/client/Workspace.tsx)
- "Link a user" form: "Plane user id" (hint "The user's id in Plane, not their email."), "GitHub username" with "Look up id", "GitHub user id" (hint "Numeric and stable across renames."), and the button "Link account". — [src/ui/client/Workspace.tsx:587-629](src/ui/client/Workspace.tsx)
- Server rejections for links: "That GitHub account does not exist", "githubId does not match that GitHub login", "That Plane user is not a member of this workspace", "That GitHub account is already linked to another user in this workspace" (409). — [src/ui/api.ts:356-386](src/ui/api.ts)
- Audit log tab:
  - Table: When, Event (the raw `kind` plus `· source`), Outcome (red when there is an error), Detail (the error text, or the raw `JSON.stringify(detail)`, which includes full webhook payloads), and Actions.
  - Pagination: 50 rows per page with a "Load older entries" button.
  - Empty state: "Nothing has been recorded for this workspace yet."
  — [src/ui/client/Workspace.tsx:632-696](src/ui/client/Workspace.tsx)
- Audit actions:
  - "Replay" on every `inbound_delivery` row, behind the confirm "Replay this delivery? It runs again under a new delivery id and may write to Plane and GitHub."
  - "Retry", changing to "Retry scheduled", on `outbound_write_failed` rows that carry an `outboxId`.
  — [src/ui/client/Workspace.tsx:662-704](src/ui/client/Workspace.tsx); [src/ui/client/http.ts:17-25](src/ui/client/http.ts)

**Who can reach what**
- Instance admin: the admin page only (API under `/git-sync/api/instance/*`). The workspace pages check the separate Plane web session's workspace role. — [src/ui/api.ts:138-146](src/ui/api.ts)
- Workspace admin (role ≥ 20): all workspace pages. — [src/ui/plane-auth.ts:62-86](src/ui/plane-auth.ts)
- Workspace member or guest: nothing. There is no self-service account linking and no per-user view. — [packages/constants/src/settings/workspace.ts:70](packages/constants/src/settings/workspace.ts); [docs/plan/parity-plan.md:84](docs/plan/parity-plan.md) ("Workspace members (not only admins) may link their own account" is planned, not built)
- Write CSRF guard: any non-GET request must carry `Origin == PUBLIC_ORIGIN`. — [src/ui/api.ts:97-103](src/ui/api.ts)

### Inferences
- The UI is functional but developer-grade. Users must handle raw UUIDs (Plane project id, Plane user id), numeric GitHub ids, `group:Name` state strings, regexes, YAML and JSON payloads. Nothing on the GitHub side is picked from a list except the Plane project select, which is best effort.
- The workspace and admin halves are separate iframes with no cross-links. A workspace admin who hits "That GitHub installation is not allowed…" has no in-UI way to ask for or see the allow-list.

### Gaps
- The CSS (`src/ui/styles.css`) was not reviewed, so visual fidelity to Plane's design system is not assessed beyond noting that no `@plane/*` components are used. That last point follows from the import lists in [src/ui/client/Admin.tsx:1-8](src/ui/client/Admin.tsx) and [src/ui/client/Workspace.tsx:1-14](src/ui/client/Workspace.tsx).
- Whether Plane's admin layout itself blocks non-admins before the iframe loads was not checked. The patch adds no guard of its own.

---

## 2. Setup flow end to end, and which steps leave the UI

### Takeaway
Setup is an operator runbook rather than a guided in-product flow. About ten steps happen outside our UI: forking and rebuilding Plane images, creating the GitHub App by hand, writing env and secret files, Caddy, the Plane webhook, Plane's rate limit, and copying installation ids from GitHub URLs. Our UI covers only the last mile: App credentials, installation allow-list, mappings, rules, policies, magic words and manual user links. There is no "Connect GitHub" or OAuth button, no App manifest flow, and no repository picker.

### Cited Findings
Ordered as a user would do it today:
1. **Build forked Plane images** (admin and web) from patches with `build-fork-image.sh`, pinned to the v1.4.2 tag. Outside the UI. — [deploy/APPLY.md:13-30](deploy/APPLY.md); [apps/README.md:21-30](apps/README.md)
2. **Create the GitHub App by hand** on GitHub with permissions Pull requests RW, Issues RW, Contents RW, Checks R, Deployments R, Members R, and Administration W only for autolinks. No manifest or automated registration exists. The README does not list which webhook **events** to subscribe to; no doc lists them (searched `deploy/APPLY.md`, `apps/README.md`). — [apps/README.md:32-42](apps/README.md)
   - At runtime the code expects "Commit statuses: Read" for merge readiness, and audits "grant the App "Commit statuses: Read"" when it is missing, but this permission is not in the README list. — [src/app/pr.ts:198](src/app/pr.ts)
3. **Env file and secrets**: copy `git-sync.env.example`, then fill `PLANE_SERVICE_PAT` (a PAT of a dedicated Plane service account that must be created by hand in Plane), `PLANE_WEBHOOK_SECRET`, `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY_PATH`, `GITHUB_WEBHOOK_SECRET`, `GITSYNC_TOKEN_KEY`, `PLANE_SERVICE_USER_ID`, `PUBLIC_ORIGIN`, the optional `GITHUB_API_BASE_URL`, `REQUIRE_VERIFIED_COMMITS` and `PLANE_API_RATE_PER_MINUTE`. Place the PEM with `chown 1000` and `chmod 400`, and create a credential-state directory. — [deploy/APPLY.md:37-76](deploy/APPLY.md); [deploy/git-sync.env.example](deploy/git-sync.env.example)
4. **Database, compose override and Caddy** `handle /git-sync/*` block, then reload. — [deploy/APPLY.md:77-168](deploy/APPLY.md)
5. **Register webhooks by hand**: in Plane, Workspace settings → Webhooks → `https://<host>/git-sync/webhooks/plane`; on GitHub, the App webhook URL `…/git-sync/webhooks/github`. — [deploy/APPLY.md:170-174](deploy/APPLY.md)
6. **Rate limit alignment**: edit `API_KEY_RATE_LIMIT` in `plane.env` and set `PLANE_API_RATE_PER_MINUTE` to the same value. — [deploy/APPLY.md:176-182](deploy/APPLY.md)
7. **Verify** with `docker inspect` and `curl /git-sync/healthz`. There is no in-UI check. — [deploy/APPLY.md:184-194](deploy/APPLY.md)
8. **In UI (instance admin)**: optionally re-enter App ID, PEM, webhook secret and GHE URL. A save moves credentials from the env bootstrap into the encrypted DB row and retires the bootstrap ("Migration 008 retires bootstrap credentials…"). — [src/ui/api.ts:522-538](src/ui/api.ts); [deploy/APPLY.md:69-75](deploy/APPLY.md)
9. **In UI (instance admin)**: allow-list each installation by **numeric installation id**, which the admin has to find on GitHub (for example in the installation settings URL), plus a typed workspace slug. One installation can belong to only one workspace: "That installation is already allowed for another workspace; remove it there first". — [src/ui/client/Admin.tsx:203-233](src/ui/client/Admin.tsx); [src/ui/api.ts:585-604](src/ui/api.ts)
10. **In UI (workspace admin)**: map a repository by typing `owner/repo` → Look up id → choose a project → direction and toggles → Add mapping. The server verifies the project, the installation and the allow-list. — [src/ui/client/Workspace.tsx:110-182](src/ui/client/Workspace.tsx); [src/ui/mapping-check.ts:42-75](src/ui/mapping-check.ts)
11. **In UI (workspace admin)**: optionally set rules or the lifecycle table, conflict policies and backfill. Without a saved rule set the shipping defaults `QLL_DEFAULTS` apply. — [src/ui/client/Workspace.tsx:269-279](src/ui/client/Workspace.tsx); [src/ui/api.ts:450](src/ui/api.ts)
12. **In UI (workspace admin)**: link users by Plane user id + GitHub login/id. As a fallback, GitHub senders without a link are auto-matched by **public email**, which must match exactly one workspace member. — [src/ui/client/Workspace.tsx:587-629](src/ui/client/Workspace.tsx); [src/app/identity.ts:1-2,68-71](src/app/identity.ts)
13. **In UI (instance admin)**: magic words and defaults. — [src/ui/client/Admin.tsx:244-319](src/ui/client/Admin.tsx)

Settings that exist **only** in env or files, with no UI: `REQUIRE_VERIFIED_COMMITS` (signed-commit gate for Smart Commits), `PLANE_SERVICE_PAT`, `PLANE_SERVICE_USER_ID`, `PLANE_WEBHOOK_SECRET` and `_PREVIOUS`, `PLANE_API_RATE_PER_MINUTE`, `PLANE_SESSION_COOKIE_NAME` and `PUBLIC_ORIGIN`. — [deploy/git-sync.env.example](deploy/git-sync.env.example); [src/config/env.ts:27,59](src/config/env.ts); [src/app/push.ts:51](src/app/push.ts)

Planned but not built (per the parity plan): "Connect GitHub" install-and-return (C1), personal OAuth linking (C2), a user-scoped repo picker (C3), per-mapping open/closed states (C4), cross-links on mirrored issues (C5), mentions (C6), issue references (C7), and ghe.com/GHES edition handling (C8). The App has no Client ID or secret, setup URL or callback URL yet. — [docs/plan/parity-plan.md:12-41](docs/plan/parity-plan.md)

### Inferences
- A non-operator workspace admin cannot finish setup alone. The instance admin must first have the App installed on the GitHub org, find the numeric installation id on GitHub, and allow-list it against the right slug.
- There is one Plane webhook secret per service (`PLANE_WEBHOOK_SECRET`, plus a previous one during rotation), while Plane generates a secret per workspace webhook. Serving more than one Plane workspace therefore looks unsupported or awkward. This is inferred from the env shape and was not verified in `src/api/handler.ts`.

### Gaps
- No doc gives the GitHub App's webhook event subscription list. I could not confirm from docs which events an operator must tick.
- How the operator obtains `PLANE_SERVICE_USER_ID` (a UUID) is not documented beyond the env comment.

---

## 3. What a user sees on a Plane work item and on GitHub as a result of sync

### Takeaway
All visible output is plain links and plain comments written through Plane's public API as a **service account**, plus GitHub comments posted by the **App bot**. On Plane: categorized links titled "[PR] #12 Title · OPEN · REVIEW", "[CI] Build · pass", "[Deploy] env · state", "[Preview] Vercel" and "[Branch] name". Comments include "Mirrored from GitHub issue …", "**login** commented on GitHub:", Smart Commit comments with a "via <sha> by <login>" footer, and "Time logged: …". On GitHub: a PR linkback comment "Linked Plane work item(s):", "**Name** commented in Plane:", mirrored issues with a "Mirrored from Plane: <url>" footer and the `plane` label, and an orphan notice. Per-user attribution (acting as the human) is effectively unreachable because no code path stores per-user tokens.

### Cited Findings

**On the Plane work item**
- PR rollup link, one per PR, edited in place. Title format `[PR] #12 Title · OPEN · REVIEW`: PR status is OPEN, MERGED or DECLINED, and review status (REVIEW, APPROVAL or REJECTED) is shown only while the PR is open. — [src/sync/dev-info.ts:12-56](src/sync/dev-info.ts); [src/app/pr.ts:363-374](src/app/pr.ts)
- Build, deploy and preview links: `[CI] Build · {pass|fail|pending}`, `[Deploy] {env} · {state}`, `[Preview] {Vercel|Netlify|…}`. — [src/app/checks.ts:165,266,274](src/app/checks.ts); [src/sync/dev-info.ts:69-78](src/sync/dev-info.ts)
- Branch link `[Branch] {branch}` on push. — [src/app/push.ts:101](src/app/push.ts)
- There is no per-commit link: `categorisedTitle` is called only for PR, CI, Deploy, Preview and Branch (grep of `src/`).
- The spec planned for "our UI" to render these title prefixes as icons. Since nothing in our UI renders on the work item, they show as plain text links in Plane's native Links section. — [spec §7.4](docs/superpowers/specs/2026-10-10-plane-github-sync-design.md) lines 406-411
- State changes come from the rules engine (lifecycle table or YAML): `set_state`, `add_label`, `remove_label`, `assign`, `comment` (`<p>body</p>`), `log_time` (a comment "Time logged: {duration}", not a real worklog), `add_link` and `create_issue`. — [src/github/pr-automation.ts:500-567](src/github/pr-automation.ts)
- Mirrored GitHub comment on Plane: `<strong>{login}</strong> commented on <a>GitHub</a>:` followed by the body. — [src/sync/mirror.ts:257-262](src/sync/mirror.ts)
- A Plane item created from a GitHub issue receives the comment "Mirrored from GitHub issue owner/repo#N." and the auto-created `github` label. — [src/sync/mirror.ts:358,377-378,402,417-418](src/sync/mirror.ts)
- A Plane item mirrored to GitHub receives the comment "Mirrored to GitHub issue owner/repo#N.". — [src/sync/mirror.ts:610-611,625-626](src/sync/mirror.ts)
- Smart Commits: `#comment` posts `<p>text</p>` and `#time` posts `<p>Time logged: 2h (120 minutes)</p>`, each followed by a provenance footer `<small>via <a>sha7</a> by {login}</small>`. `#<transition>` sets the state. — [src/github/smart-commits.ts:398,484-496](src/github/smart-commits.ts)
- `{IDENTIFIER}-NEW` in a PR body creates a new work item, links it, and puts it in the started group. — [src/app/pr.ts:108,153-166](src/app/pr.ts); [spec §6](docs/superpowers/specs/2026-10-10-plane-github-sync-design.md) line 277
- `skip KEY` or `ignore KEY` in a PR body suppresses linking. — [src/parse/references.ts:57](src/parse/references.ts)

**On GitHub**
- PR linkback comment, once per newly linked item and only when the mapping toggle is on: `Linked Plane work item(s):\n- QLL-12: <url>`. — [src/app/pr.ts:377-383](src/app/pr.ts)
- Plane comment mirrored to the issue: `**{display_name}** commented in Plane:` followed by the text. — [src/sync/mirror.ts:493-496](src/sync/mirror.ts)
- A GitHub issue created from Plane gets the body, a `---\nMirrored from Plane: <url>` footer, and the `plane` label, which is created on the repo if absent. — [src/sync/mirror.ts:591-608](src/sync/mirror.ts)
- Orphan notice (when linkback is on): "The linked Plane work item can no longer be found, so this link has been marked orphaned. Nothing was changed or closed here." — [src/app/main.ts:226-239](src/app/main.ts)
- No GitHub check run, commit status, or autolink is produced. The autolinks toggle is disabled in the UI ("unavailable") and nothing calls GitHub's autolink endpoint. — [src/ui/client/Workspace.tsx:177](src/ui/client/Workspace.tsx); [docs/impl/audit-github.md:139](docs/impl/audit-github.md) (A12)

**Opt-in model and attribution**
- Mirroring is gated by labels: a GitHub issue labelled `plane` creates a Plane item, and a Plane item labelled `github` creates a GitHub issue. Without the label the event is ignored with the reason "not opted in", and nothing is shown to the user. — [src/sync/mirror.ts:27,236-240,509](src/sync/mirror.ts)
- Attribution:
  - Plane writes use the service PAT and GitHub writes use the App installation token. The human appears only as text, such as `**login** commented…` or `by {login}`.
  - The design names per-user tokens "phase 2". `TokenVault.store` exists, but no call site in `src/` invokes it (grep for `.store(` returns nothing outside tests), so no per-user Plane PAT or GitHub OAuth token can ever be stored.
  - The Unlink confirm still says "Any credentials stored for this user are deleted."
  — [spec §9](docs/superpowers/specs/2026-10-10-plane-github-sync-design.md) lines 500-505; [src/auth/identity.ts:135-146](src/auth/identity.ts); [src/ui/client/Workspace.tsx:565](src/ui/client/Workspace.tsx)
- When the service identity is used for a sender, an `identity_fallback` audit row is written. Nothing is shown on the item. — [src/github/smart-commits.ts:395](src/github/smart-commits.ts)

### Inferences
- Compared with tools that render a native development panel (PR, branch and build status), our dev-info is a list of text-prefixed links in Plane's generic Links section. It is functional but visually plain, and noisy when there are many PRs, deploys and previews.
- Errors almost never show on the work item or the PR. Smart Commit failures, unknown transitions, and unsigned-commit rejections go to the audit log only, not as a reply on the commit or PR (see §4).
- Mirrored comments and issues in both directions are authored by the bot or service account, with the human named in bold text.

### Gaps
- I did not trace every rule template variable or the exact HTML-to-markdown conversion (`htmlToText`/`textToHtml`), so formatting fidelity of mirrored descriptions is not assessed.
- There are no mention or issue-reference conversions (parity plan C6/C7 are open), but I did not test how raw `@login` or `#123` text renders after mirroring.

---

## 4. Operational UX: audit, health, retry, replay, backfill, dry-run, disabled mappings, signals

### Takeaway
The operator tools are richer than typical SaaS integrations: an audit log with replay and retry, a dry-run of rules against recorded deliveries, backfill, and a disabled-mapping list. But they are raw (JSON detail, internal `kind` names) and split by role: health and disabled mappings are instance-admin only, while the audit log, replay and retry are workspace-admin only. Several important signals never reach any UI: a silent Plane webhook, credential decrypt failure, rate limiting during background sync, and non-allow-listed installations at runtime. These show up only as unattributed audit rows, the health JSON, or server logs.

### Cited Findings
- **Health** (instance admin): the response includes `githubAppCredentials: {source, decryptOk}`, but the UI renders only database, configured, mapping count, last activity and failures in 24h. A decrypt failure, which makes every GitHub webhook fail with 503, is invisible in the UI. The runbook tells operators to read `decryptOk` from the raw API. — [src/ui/api.ts:620-644](src/ui/api.ts); [src/ui/client/Admin.tsx:56-62](src/ui/client/Admin.tsx); [deploy/APPLY.md:206-213](deploy/APPLY.md)
- "Database: reachable" can never show "unreachable": the API hard-codes `database: true` and a DB failure turns into a load error. "GitHub App configured" reflects only the DB row, not env bootstrap credentials. — [src/ui/api.ts:621,637-638](src/ui/api.ts)
- "Failures in the last 24 hours" counts **all** audit rows with an error across the instance, with no drill-down link. — [src/ui/api.ts:632-635](src/ui/api.ts)
- **Silent Plane webhook**: the reconcile sweep writes `plane_webhook_silent` and `plane_webhook_recovered` rows with **no `workspaceSlug` and no `error`**. They are therefore excluded from the workspace audit view (which filters by workspace) and from the health failure count. The only other signal is a server log line. Recovery requires re-enabling the webhook in Plane and manually re-saving changed items. — [src/sync/reconcile.ts:169-171](src/sync/reconcile.ts); [src/ui/api.ts:411-419](src/ui/api.ts); [deploy/APPLY.md:223-239](deploy/APPLY.md)
- **Audit log visibility**: rows are shown only when they carry this workspace's slug or mapping id. "Unattributed rows stay instance-private", yet no instance-level audit view exists. — [src/ui/api.ts:401-419](src/ui/api.ts)
- **Replay**:
  - The button appears on every `inbound_delivery` row (successful ones too).
  - Replay requires the row's `workspace_slug` column to equal the workspace, otherwise "Audit entry not found".
  - Duplicates keep no payload, so replaying them fails with "That delivery has no payload on file (duplicates keep only the event)".
  - Each replay adds a `replay` row ("queued").
  — [src/ui/client/Workspace.tsx:662-667](src/ui/client/Workspace.tsx); [src/ui/api.ts:434-439,467-472](src/ui/api.ts); [src/operations/tooling.ts:161-190](src/operations/tooling.ts); [src/queue/workers.ts:119-133](src/queue/workers.ts)
- **Retry failed write**: only for `outbound_write_failed` rows with an `outboxId`. The answer is 202 "retry_scheduled", or 404 "No failed outbound write with that id in this workspace". There is no follow-up status beyond reloading the log. — [src/ui/api.ts:474-484](src/ui/api.ts); [src/operations/outbox.ts:226-229,500-504](src/operations/outbox.ts)
- **Backfill**: manual and per mapping only. The spec's "on first mapping a repo, optionally scan" prompt is not offered in the create flow, which simply resets the form after save. — [src/ui/client/Workspace.tsx:141-144,709-733](src/ui/client/Workspace.tsx); [spec §7.6](docs/superpowers/specs/2026-10-10-plane-github-sync-design.md) lines 452-453
- **Dry-run**: three event types, a free JSON payload or an audit id, and optional YAML. Results show the trigger, the matched rule and the actions as JSON. No visual diff is shown against the Plane item. — [src/ui/client/Workspace.tsx:735-782](src/ui/client/Workspace.tsx); [src/ui/api.ts:441-465](src/ui/api.ts)
- **Disabled mappings**: visible only on the instance page. The workspace mapping list DTO carries no disabled, installation or health field, so a workspace admin sees a disabled mapping as normal. — [src/ui/client/Admin.tsx:28-48](src/ui/client/Admin.tsx); [src/ui/api.ts:149-159](src/ui/api.ts)
- **Rate limits**: config-API calls answer 429 with `retryAt` and the message "GitHub rate limit reached; retry after the indicated deadline". Background rate limiting shows up only as audit rows (`smart_commit_retry` and similar) or as delays; there is no banner or health field. — [src/ui/api.ts:124-128](src/ui/api.ts); [src/github/smart-commits.ts:434,461,476](src/github/smart-commits.ts)
- **Smart Commit failures** are audit-only:
  - "{KEY}: transition #x matches no state / matches several states in project {uuid}"
  - "#time needs a duration…"
  - "commit abc1234 is not signature-verified; Smart Commit commands ignored"
  - `smart_commit_truncated` for large pushes
  — [src/github/smart-commits.ts:72-78,250-284,344-350,481](src/github/smart-commits.ts)
- Other audit-only signals:
  - `github_not_installed` ("the GitHub App is not installed on this repository")
  - `readiness_unavailable` (missing "Commit statuses: Read")
  - `identity_email_match` failures ("GitHub user X has no public email to match")
  - `reference_unresolved`, `mirror_conflict`, `sync_link_missing`/`archived`/`orphaned`, `installation_invalidated`
  — [src/app/issues.ts:233](src/app/issues.ts); [src/app/pr.ts:198](src/app/pr.ts); [src/app/identity.ts:69](src/app/identity.ts); [src/sync/reconcile.ts:78-84](src/sync/reconcile.ts); audit kind list from a grep of `src/app src/sync src/github src/operations src/queue src/api`
- **Webhook redelivery** for lost GitHub events is a manual trip to GitHub → App → Advanced → Recent deliveries. — [deploy/APPLY.md:206-213](deploy/APPLY.md)
- **Plane secret rotation** is a four-step env-and-restart procedure. — [deploy/APPLY.md:241-252](deploy/APPLY.md)

### Inferences
- A workspace admin cannot tell from the UI whether sync is healthy. They have no health card, no "last delivery" time, no webhook status and no disabled-mapping badge, and must read raw audit rows.
- An instance admin sees a failure count but cannot open the failures, since there is no instance audit view.
- The deepest operational signals (decrypt failure, silent webhook) need API or log access, which pushes troubleshooting to whoever runs the server.

### Gaps
- I did not verify whether the working-tree fixes (`docs/impl/fixes-audit-G1..G5.md`, migration 009) add any new UI surface for these signals. The UI files read above (`Admin.tsx`, `Workspace.tsx`) contain none.

---

## 5. Gaps visible directly in the code (API-only settings, manual steps, confusing labels)

### Takeaway
Several settings exist in the API but not the UI, or the UI silently overrides them. Key self-service flows (connect, personal linking, repo picker, per-user attribution) are missing. A number of labels expose internal jargon.

### Cited Findings
- **The instance default "Smart Commits for newly mapped repositories" is bypassed by the UI.** The mapping form starts the checkbox at `true` and always sends `smartCommitsEnabled`, so the server's `input.smartCommitsEnabled ?? smartDefault` fallback never applies to UI-created mappings. The default only affects API callers that omit the field. — [src/ui/client/Workspace.tsx:115,134-137](src/ui/client/Workspace.tsx); [src/ui/api.ts:239,245](src/ui/api.ts)
- **The autolinks field is API-only and gets clobbered by the UI.** The API accepts `autolinks` on POST and PATCH, but the UI always sends `autolinks: false`. Saving a mapping in the UI resets an API-set `true`, which has no effect anyway because no autolink call exists. — [src/ui/client/Workspace.tsx:136,177](src/ui/client/Workspace.tsx); [src/ui/api.ts:259](src/ui/api.ts); [docs/impl/audit-github.md:139](docs/impl/audit-github.md)
- **Health credential status (`githubAppCredentials.source/decryptOk`) is API-only.** — [src/ui/api.ts:639](src/ui/api.ts)
- **Rule version history** is stored (`version`, `updated_by`, `updated_at`) but there is no UI to view or roll back; only the current version number is shown. — [src/ui/api.ts:283-314](src/ui/api.ts); [src/ui/client/Workspace.tsx:397](src/ui/client/Workspace.tsx)
- **The rule engine is richer than the UI's dry-run**: triggers include `check_suite.*`, `deployment_status.*`, `issue.*` and `comment.*`, but dry-run offers only `pull_request`, `pull_request_review` and `push`. — [spec §7.5](docs/superpowers/specs/2026-10-10-plane-github-sync-design.md) lines 435-438; [src/ui/validate.ts:241](src/ui/validate.ts)
- **Per-user tokens**: the storage method exists but nothing calls it. There is no UI or API to add a Plane PAT or GitHub OAuth token, so "phase 2" per-user attribution is unreachable. — [src/auth/identity.ts:143-146](src/auth/identity.ts)
- **Spec features not found in the code**: the copyable branch name and branch creation from an issue (§7.1 "Issue → branch"), a grep for `branchName`/`{username}` found no implementation; and the preview/category icons rendered by "our UI". — [spec §7.1](docs/superpowers/specs/2026-10-10-plane-github-sync-design.md) lines 325-327
- **Manual identifiers everywhere**: Plane user ids (the hint says "The user's id in Plane, not their email."), project UUIDs in the mapping list and disabled list, installation ids, and a free-text workspace slug in the allow-list. — [src/ui/client/Workspace.tsx:55,560,612](src/ui/client/Workspace.tsx); [src/ui/client/Admin.tsx:40,206-222](src/ui/client/Admin.tsx)
- **Confusing or internal labels**:
  - "Map each §7.1 lifecycle point…", which cites a spec section.
  - "Echo-suppression TTL (minutes)".
  - The state syntax `started:In Progress`.
  - Raw audit `kind` values such as `outbound_write_failed` and `inbound_delivery`.
  - The rules intro example uses `set_state: Done`, which does not match the table's `group:Name` format.
  — [src/ui/client/Workspace.tsx:395-396,420,658](src/ui/client/Workspace.tsx); [src/ui/client/Admin.tsx:312](src/ui/client/Admin.tsx)
- **Lifecycle table vs YAML**: custom YAML cannot be shown in the table, and switching back discards it after a confirm. — [src/ui/client/Workspace.tsx:340-352](src/ui/client/Workspace.tsx)
- **Open and closed states are fixed** to the project's default completed and unstarted states (parity C4). — [docs/plan/parity-plan.md:105-112](docs/plan/parity-plan.md)
- **Single GitHub App per instance**; GHE is a single base-URL field with no ghe.com handling, and GHES links still point to github.com (audit A11). — [docs/plan/parity-plan.md:144-155](docs/plan/parity-plan.md); [docs/impl/audit-github.md:127](docs/impl/audit-github.md)

### Inferences
- The most user-visible missing flows compared with SaaS integrations are: one-click Connect (install and return), per-user OAuth linking by members themselves, a repo picker, real per-user authorship, and in-product errors on the PR or commit.

### Gaps
- None beyond those noted in sections 1-4.

---

## 6. Already-known gaps from docs/plan/parity-plan.md and docs/impl/audit-*.md, and which are UX-visible

### Takeaway
Of the 8 parity gaps, all are user-visible (C1-C3 setup and identity UX, C4-C7 item content, C8 admin settings). Of the docs-audit findings, the user-visible ones mainly cause wrong or stale information on the work item or GitHub. Several Plane audit items appear to be addressed in the working tree.

### Cited Findings
**Parity plan (proposed 2026-10-12, not started)** — [docs/plan/parity-plan.md:12-23](docs/plan/parity-plan.md)
- C1, no "Connect" button (install → return): UX-visible (setup).
- C2, no personal GitHub OAuth linking: UX-visible (members cannot link, and there is no real authorship).
- C3, no user-scoped repository picker: UX-visible (typed `owner/repo` and an id lookup).
- C4, open/closed states fixed to project defaults: UX-visible (wrong column after close or reopen).
- C5, no cross-link comment or link on mirrored issues: partly. Today there is a Plane comment "Mirrored from/to GitHub issue …" and a GitHub footer, but no Plane **link** and no GitHub comment ([src/sync/mirror.ts:377-378,596](src/sync/mirror.ts)).
- C6, mentions not synced: UX-visible.
- C7, GitHub issue refs not linkified in Plane: UX-visible.
- C8, no ghe.com or Server distinction: admin UX-visible.

**GitHub docs audit** — [docs/impl/audit-github.md](docs/impl/audit-github.md). UX-visible ones:
- A5, build rollups look only at the first 100 check runs, so `[CI] Build` status can be wrong (line 55).
- A6, review rollups keep old decisions after 100 reviews, so `[PR] … · APPROVAL/REJECTED` can be wrong (line 67).
- A8, Smart Commits stop silently at 3,000 commits (line 91).
- A9, fork PR checks dropped, so no CI link (line 103).
- A10, out-of-order snapshots overwrite newer state (line 115).
- A11, GHES generates github.com links (line 127).
- A12, autolinks never called, hence "(unavailable)" (line 139).
- A13, label-removal 404s reported as success (line 151).
- A15, an approved draft marked ready does not fire ready-for-merge (line 175).
- A1-A4 and A14 are mostly back-end, but A1 affects the manual "Look up id" for user linking (line 7).

**Plane docs audit** — [docs/impl/audit-plane.md](docs/impl/audit-plane.md)
- A1: Plane ingress lost events and the webhook auto-disabled. The working tree now has spool persistence and a silent-webhook detector ([deploy/APPLY.md:215-239](deploy/APPLY.md); migration `009-plane-ingress-spool-link-visibility.sql`). The detector's output is invisible in the UI (§4 above).
- A2: archived items were orphaned, with a false GitHub orphan comment. The working tree has a `sync_link_archived` path ([src/sync/reconcile.ts:78](src/sync/reconcile.ts)). UX-visible: the orphan comment text.
- A3: unordered Plane deliveries (stale overwrite), UX-visible.
- A7: hardcoded session cookie name. Now an env var, `PLANE_SESSION_COOKIE_NAME` ([deploy/git-sync.env.example](deploy/git-sync.env.example)).
- A8: a slug containing "instances" breaks the auth check. UX-visible as a spurious "not authorised".
- A9: triage guard dead code.

### Inferences
- The fix status of each audit item could not be confirmed without running tests or reading every `fixes-audit-G*.md`. The statements above about A1, A2 and A7 being addressed rest on the presence of the corresponding code and docs in the working tree.

### Gaps
- `docs/impl/fixes-audit-G1..G5.md` were not read in full, so the exact closure status of each GitHub audit item (A1-A16) is unverified.
