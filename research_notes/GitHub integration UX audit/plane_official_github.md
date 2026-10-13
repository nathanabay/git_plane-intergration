# Plane's Official GitHub Integration: User Flows and UI/UX (as of Oct 2026)

Source key used below:
- DOCS = [docs.plane.so/integrations/github](https://docs.plane.so/integrations/github)
- DEVDOCS = [developers.plane.so/self-hosting/govern/integrations/github](https://developers.plane.so/self-hosting/govern/integrations/github)
- I18N = [makeplane/plane packages/i18n/src/locales/en/integration.json](https://github.com/makeplane/plane/blob/preview/packages/i18n/src/locales/en/integration.json). These are the English UI strings shipped in Plane's public monorepo, and the most reliable source for exact on-screen labels. I pulled them with `gh api` on 2026-10-12. The UI code that uses them lives in the commercial edition, which is not public, so these notes record which strings exist, not exactly where each one renders.
- MARKET = [plane.so/marketplace/github](https://plane.so/marketplace/github)

## Q1. Setup flows: where the integration lives, connecting and disconnecting the org, self-hosted GitHub App creation, and GHE Cloud vs GHE Server

### Takeaway
GitHub is a commercial-only (Pro/Business/Enterprise) integration at **Workspace settings → Integrations → GitHub**, with a separate **GitHub Enterprise** card. A workspace Admin or Owner clicks **Connect**, which goes through the GitHub App install to the GitHub org, and then returns to a page with three sections: org connection, personal account, and Project Issue Sync / PR state mapping. Self-hosted instances must first register their own GitHub App, with two callback URLs, a setup URL, a webhook URL, 5 permissions and 10 events, and put its credentials in `.env`. GHE is configured per workspace through an in-app credentials form instead.

### Cited Findings
**Availability and tier**
- The docs page carries a **Pro** badge. GitHub Cloud (github.com) "covers all plans", and the connection lives at **Workspace settings → Integrations → GitHub** — [DOCS](https://docs.plane.so/integrations/github)
- The marketplace lists the tiers "Pro", "Business" and "Enterprise", deployable on Cloud and Self-hosted — [MARKET](https://plane.so/marketplace/github)
- Integrations are not available in the self-hosted Community edition. A Plane staff member said in June 2025: "Integrations is not available for Community, it is available only for Pro and Business plan users". In Community, `/settings/integrations/` shows a "Not Authorized" view — [makeplane/plane#7269](https://github.com/makeplane/plane/issues/7269)
- History: GitHub launched on Cloud on Feb 17, 2025, alongside Slack and GitLab, as "Issues, pull requests, labels, comments, and more stay in sync" with PR state mapping — [Changelog Feb 17 2025](https://plane.so/changelog/cloud-feb-17-2025). GitHub Enterprise reached self-hosted in v1.14.0 (Sep 2025), and Cloud on Oct 1, 2025, alongside an unexplained "Refined GitHub integration for a cleaner, easier experience" — [Changelog Oct 1 2025](https://plane.so/changelog/2025-10-01-universal-filtering-github-enterprise). The same Oct 2025 changelog lists "Fixed configure button not working for existing integrations"; it does not say whether this was GitHub-specific.
- Older behavior: an earlier GitHub sync and importer, configured per project in the 2023-era Community edition, had bugs including "Can't select GitHub Repo" (#3368), "Unable to uninstall or reinstall the GitHub integration through Plane" (#3245), "GitHub sync replaces markdown issues with HTML" (#2136), and a request to "show github sync status/log/errors" (#1622). All are closed. That system was superseded by the 2025 "silo"-based integration — [gh search makeplane/plane](https://github.com/makeplane/plane/issues?q=github+integration)

**Integrations list and card states (I18N)**
- The page title is "Integrations". Generic states include "Loading", "Configure", "Not configured", "{name} is not enabled for this workspace.", "You are not authorized to view this page.", "Back to integrations", "Not able to fetch supported integrations. Please try again later.", and "Not able to access the external API. Please try again later." — [I18N](https://github.com/makeplane/plane/blob/preview/packages/i18n/src/locales/en/integration.json)
- If the instance has no App credentials, the card says: "{name} integration is not configured. Please contact your instance admin to configure it." (self-hosted) or "…Please contact support to configure it." (Cloud) — [I18N](https://github.com/makeplane/plane/blob/preview/packages/i18n/src/locales/en/integration.json)
- GitHub card: name "GitHub", description "Connect and sync your GitHub work items with Plane". GHE card: "GitHub Enterprise", described as "Connect and sync your GitHub Enterprise organization with Plane." — [I18N](https://github.com/makeplane/plane/blob/preview/packages/i18n/src/locales/en/integration.json)

**Org connect flow (workspace Admin/Owner)**
- Prerequisite: the connecting user must be a workspace **Admin** or **Owner** — [DOCS](https://docs.plane.so/integrations/github)
- Steps: Workspace settings → Integrations → GitHub → click **Connect**. On github.com, pick the org or personal account, then choose all repositories or specific ones, then click **Install**. You are redirected back to Plane, which shows the org as connected — [DOCS](https://docs.plane.so/integrations/github)
- Section header strings: "Connect Organization" / "Connect your GitHub organization with Plane". While in progress, the UI shows "Processing". Once connected, a "GitHub org added by and time" line appears, meaning the row shows who connected it and when. A load failure shows "Error fetching connection details from server" — [I18N](https://github.com/makeplane/plane/blob/preview/packages/i18n/src/locales/en/integration.json)
- One GitHub org can connect to only one Plane workspace. If it is already connected elsewhere, "the connection attempt fails with an error" — [DOCS](https://docs.plane.so/integrations/github). The error string is "You have already connected your organization with a workspace. Please disconnect the existing connection before connecting a new one." — [I18N](https://github.com/makeplane/plane/blob/preview/packages/i18n/src/locales/en/integration.json)
- Self-hosted users report that the frontend polls `GET /silo/api/github/auth/organization-status/<workspaceId>` and then `GET /silo/api/supported-integrations/` — [makeplane/plane#8100](https://github.com/makeplane/plane/issues/8100)

**Self-hosted GitHub App creation (instance admin)**
- Path: GitHub org **Settings > Developer Settings > GitHub Apps → New GitHub App**. Enter the **GitHub App name** and **Homepage URL** — [DEVDOCS](https://developers.plane.so/self-hosting/govern/integrations/github)
- Callback URLs, under "Identifying and authorizing users":
  - `https://<domain>/silo/api/github/auth/callback`
  - `https://<domain>/silo/api/github/auth/user/callback`
  - The guide says to opt out of **Expire user authorization tokens**, with a warning.
  - Source: [DEVDOCS](https://developers.plane.so/self-hosting/govern/integrations/github)
- Post installation: **Setup URL** = `https://<domain>/silo/api/github/auth/callback`, with **Redirect on update** ON. Webhook URL = `https://<domain>/silo/api/github/github-webhook` — [DEVDOCS](https://developers.plane.so/self-hosting/govern/integrations/github)
- GHE Server URLs:
  - Callbacks: `https://<domain>/silo/api/oauth/github-enterprise/auth/callback` and `…/auth/user/callback`
  - Setup URL: `https://<domain>/silo/api/oauth/github-enterprise/auth/callback`
  - Webhook: `https://<domain>/silo/api/github-enterprise/github-webhook` (no `oauth` segment)
  - GHE Cloud apps are created at `https://<x>.ghe.com/enterprises/<enterprise-slug>/settings/apps`
  - Plane Cloud + GHE uses `https://silo.plane.so/...`
  - Source: [DEVDOCS](https://developers.plane.so/self-hosting/govern/integrations/github)
- Repository permissions: Issues = Read and write; Metadata = Read-only; Pull requests = Read and write. Account permissions: Email addresses = Read-only; Profile = Read and write — [DEVDOCS](https://developers.plane.so/self-hosting/govern/integrations/github)
- Subscribed events (10): Installation target, Meta, Issue comment, Issues, Pull request, Pull request review, Pull request review comment, Pull request review thread, Push, Repository sub issues — [DEVDOCS](https://developers.plane.so/self-hosting/govern/integrations/github)
- Credentials to collect:
  - Generate a client secret and a private key ("Genereate a private key" [sic]).
  - Collect App ID, Client ID, Client secret, App slug (the last segment of `github.com/apps/<slug>`; "use the slug, not the display name") and the private key.
  - Base64-encode the key: `cat private_key.pem | base64 -w 0`.
  - Source: [DEVDOCS](https://developers.plane.so/self-hosting/govern/integrations/github)
- `.env` vars: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_NAME` (the slug), `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`. Restart afterwards; on AIO, recreate the container with `-e` or `--env-file`. Then "activate" the integration in the Plane UI — [DEVDOCS](https://developers.plane.so/self-hosting/govern/integrations/github)
- Troubleshooting entries:
  - "Failed to create GitHub connection: Invalid keyData": regenerate and base64-encode the key.
  - "Invalid request callback URL.": check the callback URL, and the App must be **public**.
  - "Application secret value not found for key: x-github-id": delete the Redis key `plane_app_details_github`, set `SILO_BASE_URL`, run `python manage.py reset_marketplace_app_secrets`, and reconnect.
  - "Integration stopped working after a while": opt out of token expiration under Optional Features, then reconnect.
  - Source: [DEVDOCS](https://developers.plane.so/self-hosting/govern/integrations/github)
- A user-reported failure mode: after setting the env vars, the "configure button appears but clicking does not do anything". The workaround was to put `GITHUB_*` in the compose-level `.env`, restart silo, and run the management command in `plane-api` so the values are stored in the DB. The issue was still open as of 2026 — [makeplane/plane#8100](https://github.com/makeplane/plane/issues/8100)

**GitHub Enterprise form (workspace Admin, per-workspace App credentials)**
- GHE Cloud (ghe.com):
  - Path: Integrations → GitHub Enterprise → **Connect**, then turn on the **GitHub Enterprise Cloud (ghe.com)** toggle.
  - Fields: App ID; App slug; Enterprise slug (the part before `.ghe.com`); Organisation ID (the `id` from the REST org response); Client ID; Client secret; Webhook secret; Private key (base64 of the .pem, e.g. `base64 -i your-key.pem`).
  - Click **Connect app**, then select the org and authorize.
  - Source: [DOCS](https://docs.plane.so/integrations/github)
- GHE Server:
  - Fields: App ID; App Name ("must match exactly"); Base URL (no trailing slash); Client ID; Client Secret; Webhook Secret; Private Key. The docs say full PEM with the BEGIN/END lines, but the UI label says Base64 (see the conflict below).
  - Then **Connect app**, select the org and authorize, choose all or specific repos, and click **Install**.
  - Source: [DOCS](https://docs.plane.so/integrations/github)
- UI strings:
  - Form title "GitHub Enterprise Configuration" / "Configure GitHub Enterprise to connect with Plane."
  - Field labels: "App ID", "App Slug", "Base URL" (placeholder `e.g., "https://gh.plane.town"`), "Client ID", "Client Secret", "Webhook Secret", "Private Key (Base64 encoded)"
  - Validation errors: "App ID is required", "App slug is required", "Base URL is required", "Invalid base URL", "Client ID is required", "Client secret is required", "Webhook secret is required", "Private key is required"
  - Button: "Connect App"
  - Source: [I18N](https://github.com/makeplane/plane/blob/preview/packages/i18n/src/locales/en/integration.json)
- Conflict on the private key format:
  - The DOCS GHE Server steps say the full PEM with BEGIN/END lines.
  - The I18N field label says "Private Key (Base64 encoded)" — [DOCS](https://docs.plane.so/integrations/github) vs [I18N](https://github.com/makeplane/plane/blob/preview/packages/i18n/src/locales/en/integration.json)
- The DOCS navigation names the Server variant both "GitHub Enterprise" and "GitHub Enterprise Server" — [DOCS](https://docs.plane.so/integrations/github)

### Inferences
- The ghe.com-only fields (Enterprise slug, Organisation ID, the toggle) are not in the public i18n file. They are probably hard-coded in the commercial UI or newer than this i18n snapshot.
- On self-hosted, there is a single instance-wide App for github.com, configured by env. GHE uses a per-workspace App entered in the UI. The UX therefore has two very different setup surfaces.

### Gaps
- No source describes an org **Disconnect** button label or confirmation for the org-level GitHub connection. Slack and Sentry have "Disconnect {name} workspace", but no GitHub equivalent exists in I18N. There is no org avatar or name rendering detail either.
- I found no documented behavior for when the GitHub App is uninstalled from GitHub's side, or for missing-permission or rate-limit errors.

## Q2. Personal account connection

### Takeaway
This is optional, and available to Admins and members. It changes attribution of Plane-originated comments from the bot ("Plane GitHub App" or the custom app name) to the user's GitHub identity.

### Cited Findings
- Admins and members can connect personal GitHub accounts — [DOCS](https://docs.plane.so/integrations/github)
- Steps: in the **Connect personal account** section, click **Connect**, review the permissions, and authorize. The status then shows as connected, with your account listed — [DOCS](https://docs.plane.so/integrations/github)
- Attribution: without a personal connection, comments appear as "Plane GitHub App" or the custom app name. With one, they appear under the user's GitHub account — [DOCS](https://docs.plane.so/integrations/github)
- Strings: "Connect Personal Account" / "Connect your personal GitHub account with Plane." Connected state: "Personal account connected" / "Your GitHub account is now connected to Plane". Disconnect: "Disconnect personal {providerName} account" — [I18N](https://github.com/makeplane/plane/blob/preview/packages/i18n/src/locales/en/integration.json)
- The OAuth user flow uses the callback `/silo/api/github/auth/user/callback` — [DEVDOCS](https://developers.plane.so/self-hosting/govern/integrations/github)
- Reported bug: authorizing the personal account redirects to `/auth/o/authorize-app`, which returns 400 "Mismatching redirect URI" on self-hosted (Dec 2025 and Jun 2026 reports, no maintainer answer) — [makeplane/plane#5853](https://github.com/makeplane/plane/issues/5853)
- MARKET: "Personal account linking: Each user can link their own GitHub account"; "Users see only the GitHub repositories they already have access to" — [MARKET](https://plane.so/marketplace/github)

### Inferences
- Personal linking also feeds the user map used for assignees and mentions (see Q5). Unmapped users degrade to empty assignee fields, bot attribution, or profile links.

### Gaps
- No source states whether the personal connection is per workspace or per Plane user, or whether it also attributes state and title edits made in Plane on GitHub.

## Q3. Project Issue Sync (repo ↔ project mapping)

### Takeaway
A workspace Admin adds mappings with a **(+)** button in "Project Issue Sync". The modal picks a Plane project and a GitHub repo, maps "Issue Open" and "Issue Closed" to Plane states, and picks Unidirectional or Bidirectional, then **Start Sync**. Mappings are listed and can be edited or removed with a confirmation.

### Cited Findings
- Steps:
  - Open **Project Issue Sync** → **(+)**.
  - Modal fields: **Plane project**; **GitHub repository**; **Project issue sync** state mapping (Issue Open → e.g. Todo, Issue Closed → e.g. Done); **Select issue sync direction** (Unidirectional GitHub→Plane, or Bidirectional).
  - Click **Start Sync**. The mapping can then be edited or removed from the list.
  - Source: [DOCS](https://docs.plane.so/integrations/github)
- Strings:
  - Section: "Project Issue Sync" / "Sync issues from GitHub to your Plane project". Empty state: "Mapped project issue sync will appear here".
  - Modal header: "Link GitHub Repository to a Plane Project". Pickers: "Choose Project...", "Choose Repository...". Sub-header: "Configure Issue Sync State". State labels: "Issue Open", "Issue Closed", "Select State" / "Set State".
  - Direction prompt: "Select issue sync direction". Options: "Bidirectional - Sync issues and comments both ways between GitHub and Plane" and "Unidirectional - Sync issues and comments from GitHub to Plane only".
  - Warning: "Data from GitHub Issue will replace data in Linked Plane Work Item (GitHub → Plane only)".
  - Button: "Start Sync". List row text: "Work items are synced to {project}".
  - Remove: "Remove this Project Issue Sync" / "Are you sure you want to remove this project issue sync?"
  - Also present: "Repository Mapping" / "Map your GitHub repositories with Plane projects."
  - Source: [I18N](https://github.com/makeplane/plane/blob/preview/packages/i18n/src/locales/en/integration.json)
- DOCS paraphrases the overwrite warning as "This will overwrite Plane work item content with GitHub issue data" — [DOCS](https://docs.plane.so/integrations/github)
- Conflict on multi-repo mapping:
  - MARKET says multiple repositories can connect to one Plane project — [MARKET](https://plane.so/marketplace/github)
  - A forum thread describes the issue sync as one repo per project — [forum: Syncing Multiple GitHub Repositories to a Single Plane Project](https://forum.plane.so/t/syncing-multiple-github-repositories-to-a-single-plane-project/145). I saw this only as a search snippet; the thread was not fetched.
- Feature request (May 2026): only two state mappings exist (Issue Open/Closed). There is no "issue referenced by an open PR" state; `Closes #NNN` in a PR does not move the Plane item. A Plane staff member replied "we will add this to our road map". The reporter notes that synced items store `external_source: "GITHUB"` and `external_id: "<issue_number>"` — [makeplane/plane#9056](https://github.com/makeplane/plane/issues/9056)
- Mappings are not exposed on the public REST API v1. The internal resources are `workspace-integrations` and `github-repository-sync`, and setup must be done in the UI. No maintainer response as of the fetch — [makeplane/plane#8906](https://github.com/makeplane/plane/issues/8906)

### Inferences
- The modal treats direction as a per-mapping choice. "Unidirectional" means GitHub is the source of truth and Plane edits get overwritten, which is why the warning exists.

### Gaps
- No source says whether a project can hold several issue-sync mappings, whether existing GitHub issues are backfilled at Start Sync, or what the list row shows beyond the "Work items are synced to {project}" string.

## Q4. Pull request state mapping and references

### Takeaway
There is a separate per-project "Pull Request State Mapping" with six PR lifecycle events, each mapped to a Plane state, plus an option to prevent backward moves. Only bracketed references (`[WEB-344]`) drive state changes; bare `WEB-344` only links and comments. Plane posts a comment on the PR listing the linked work items.

### Cited Findings
- Steps: open **Pull request state mapping** → **(+)**. In the modal, pick the **Plane project** and configure **Pull request automation**, then click **Save**. Mappings can be edited or removed from the list — [DOCS](https://docs.plane.so/integrations/github)
- Events: Draft PR created; PR opened; Review requested; PR approved and ready to merge; PR merged; PR closed without merging — [DOCS](https://docs.plane.so/integrations/github)
- Strings:
  - Section: "Pull Request State Mapping" / "Map GitHub pull request states to your Plane project". Empty state: "Mapped PR states will appear here".
  - Modal titles: "Add Pull Request State Mapping for Plane project" / "Edit Pull Request State Mapping for Plane project". Sub-header: "Pull Request Automation" / "Configure pull request state mapping from GitHub to your Plane project".
  - Event labels: "Draft Open", "Open", "Review Requested", "Ready for Merge", "Merged", "Closed".
  - Checkbox: "Prevent issues from moving to an earlier state due to PR updates".
  - Button: "Save". Remove: "Remove this Pull Request State Mapping" / "Are you sure you want to remove this pull request state mapping?"
  - Source: [I18N](https://github.com/makeplane/plane/blob/preview/packages/i18n/src/locales/en/integration.json)
- For comparison, GitLab's labels are sentence-style, e.g. "On MR merged, set the state to" — [I18N](https://github.com/makeplane/plane/blob/preview/packages/i18n/src/locales/en/integration.json)
- References:
  - `[WEB-344]` (brackets) links the item to the PR, adds a Plane App comment listing the linked items, and enables automatic state updates. `WEB-344` (bare) links as a reference and comments, without changing state.
  - Example: PR title `[WEB-344] Add user authentication feature` with "WEB-345" in the body. WEB-344 is fully automated; WEB-345 is reference-only.
  - Source: [DOCS](https://docs.plane.so/integrations/github)
- Backlink: "When a PR references Plane work items, Plane posts a confirmation comment on the PR listing the linked issues" — [DOCS](https://docs.plane.so/integrations/github)
- The user-perceived friction of the bracket requirement: "developers must manually look up and include the Plane ID on every PR, and it breaks down as soon as anyone forgets" — [makeplane/plane#9056](https://github.com/makeplane/plane/issues/9056)
- Open feature request: "Create a GitHub Branch From A Work Item" (Feb 2025, open) — [makeplane/plane#6611](https://github.com/makeplane/plane/issues/6611)

### Inferences
- The "Prevent … earlier state" checkbox is the only conflict and regression guard surfaced for PR automation.
- The PR events depend on the Pull request and Pull request review webhook subscriptions listed in DEVDOCS.

### Gaps
- No source gives the exact PR comment text, whether it is edited or reposted on update, or whether references in commit messages or branch names are honored. MARKET claims commit linking, with no detail. Whether the PR mapping is per repo or per project beyond "Plane project" is not stated. There is also no source on what happens when one PR references items across several projects.

## Q5. What appears on Plane work items and on GitHub; label-driven sync; what syncs

### Takeaway
Sync is opt-in per issue through labels: a `plane` label on a GitHub issue creates a Plane work item, and a `github` label on a work item creates a GitHub issue. Both sides get cross-link comments. Title, description, assignees, labels, state, comments and mentions sync both ways (subject to the direction setting); issue links sync GitHub→Plane only. The markdown fidelity of round-trips was a major 2026 complaint, which Plane says it fixed in Aug 2026.

### Cited Findings
- Prerequisite: create the trigger labels, `plane` on GitHub and `github` on Plane — [DOCS](https://docs.plane.so/integrations/github)
- GitHub→Plane: add the `plane` label, and a work item is created in the mapped project. Plane comments on the GitHub issue with a link, and the work item links back — [DOCS](https://docs.plane.so/integrations/github)
- Plane→GitHub: add the `github` label (spelled "gitHub" in one place in the docs), and a GitHub issue is created in the linked repo and linked back. Later updates follow the configured direction — [DOCS](https://docs.plane.so/integrations/github)
- A user report (via search snippet, v2.3.0) says the `github` label is matched case-insensitively, that items without it are silently skipped, and asks for the label to be configurable. Not verified against code — [search snippet; source not fetched]. Treat as unconfirmed.
- Sync table:
  - Title, Description and States: both ways.
  - Assignees: both ways, "based on the user map". Unmapped users may leave the field empty.
  - Labels: both ways. Missing labels are created on the other side.
  - Comments: both ways, with source attribution. Unmapped commenters appear as the GitHub bot.
  - Mentions: both ways if mapped; otherwise a GitHub profile link is inserted.
  - Issue links: GitHub→Plane only, with owner/repo in the URL.
  - Issue open/close moves the item to the mapped state. With bidirectional sync, Plane state changes open or close the GitHub issue.
  - Source: [DOCS](https://docs.plane.so/integrations/github)
- Fidelity bugs, filed May 14, 2026 by aspiers:
  - #9071: @mentions corrupted to `[From GitHub: user](url)`
  - #9072: `#NNN` refs duplicated, with a broken URL missing the owner
  - #9073: `<img>` alt text lost, replaced with auth-gated silo URLs
  - #9074: GFM tables flattened to `<p>` blocks
  - #9075: bare URLs wrapped as `[url](url)`
  - #9076: soft wraps turned into hard `<p>` breaks
  - Meta #9077, "Plane→GitHub sync silently overwrites GitHub bodies with corrupted markdown", was closed Aug 31, 2026 by a maintainer: "We've fixed this in our latest release." The sub-issues still showed open in the search results.
  - Sources: [#9077](https://github.com/makeplane/plane/issues/9077); [gh issue search](https://github.com/makeplane/plane/issues?q=github+integration)
- Forum (May 2026): "the integration isn't very usable in its current form". The Plane team said on Aug 31, 2026 that "All the bugs in this issue are fixed", and the user replied that the GitHub issues had not been updated — [forum #130](https://forum.plane.so/t/github-integration-has-several-problems/130)
- Labeling a GitHub issue imports only the title and description, not its prior comment history. The user wrote a script as a workaround — [forum #119 Full imports of GitHub issues including comments](https://forum.plane.so/t/full-imports-of-github-issues-including-comments/119); summarized in [forum #130](https://forum.plane.so/t/github-integration-has-several-problems/130)
- Markdown rendered as plain text in work items (Mar 2026, open) — [makeplane/plane#8781](https://github.com/makeplane/plane/issues/8781). Title only; body not fetched.
- MARKET claims: "Link Plane work items with GitHub pull requests and commits"; "When a PR linked to an issue moves from draft → open → merged, the Plane issue updates automatically" — [MARKET](https://plane.so/marketplace/github)

### Inferences
- Work items show links to the GitHub issue or PR and bot comments, plus state changes in activity driven by the mappings. The "Plane App" comment wording in DOCS suggests that bot comments in Plane are authored by the integration's app user.

### Gaps
- No source documents the exact work-item UI: whether PRs appear as typed link cards showing PR status, a dedicated "Pull requests" panel, or commit and branch rows. The exact activity-log wording and the exact text of the cross-link comments on GitHub and in Plane are also undocumented. Whether Plane adds or removes labels on GitHub beyond label sync is unknown.
- Conflict handling for simultaneous edits is not documented. The only explicit rules are the unidirectional overwrite warning and the "Prevent … earlier state" PR guard.
- Sub-issue sync is undocumented, although "Repository sub issues" is a subscribed event.

## Q6. Error, empty and edge states, troubleshooting, recent changes and complaints

### Takeaway
Surfaced errors are generic silo errors plus the one-org-per-workspace conflict. Empty states are short placeholders. Troubleshooting exists only in the self-hosting guide. The main 2025–2026 complaints are markdown corruption, self-hosted setup friction, commercial-only gating, missing "in review" automation, and no API for mappings. There is no sync log or status UI.

### Cited Findings
- Silo error strings:
  - "The provided query parameters are invalid or missing required fields"
  - "The installation account provided is not valid"
  - "An unexpected error occurred while processing your request"
  - "The requested connection could not be found"
  - "Multiple connections were found when only one was expected"
  - "You have already connected your organization with a workspace. Please disconnect the existing connection before connecting a new one."
  - "The requested installation could not be found"
  - "The requested user could not be found"
  - "Failed to fetch authentication token"
  - "The provided app credentials are invalid"
  - "Failed to install the app"
  - Source: [I18N](https://github.com/makeplane/plane/blob/preview/packages/i18n/src/locales/en/integration.json)
- Empty states: "Mapped project issue sync will appear here"; "Mapped PR states will appear here" — [I18N](https://github.com/makeplane/plane/blob/preview/packages/i18n/src/locales/en/integration.json)
- The DOCS page has no troubleshooting or FAQ section. Self-host troubleshooting covers the four errors listed in Q1 — [DOCS](https://docs.plane.so/integrations/github); [DEVDOCS](https://developers.plane.so/self-hosting/govern/integrations/github)
- A 2023 request to "show github sync status/log/errors" was closed. I found no sync-log UI in the current docs or strings — [makeplane/plane#1622](https://github.com/makeplane/plane/issues/1622)
- A May 2026 changelog mentions fixes to the "github integration", without details (search snippet) — [plane.so/changelog](https://plane.so/changelog/commercial)
- Feature requests:
  - Unify integration actions into the automation engine (#9048, May 2026)
  - GitLab parity with GitHub issue sync (#8088)
  - Source: [gh issue search](https://github.com/makeplane/plane/issues?q=github+integration)
- Community pushback on gating integrations to commercial tiers — [makeplane/plane#7269](https://github.com/makeplane/plane/issues/7269)

### Inferences
- The user-visible error surface is thin. Sync failures after setup (webhook signature mismatch, uninstalled app, expired tokens) appear to show no in-app status, and the docs' remedy for those cases is "reconnect".

### Gaps
- I found no documentation of rate-limit handling, retry behavior, or how sync failures are shown in the UI.
- No YouTube or blog walkthrough with current screenshots was found within the tool budget, so screen layout (cards, avatars, list row composition) is unverified.
- I found no Discord or Reddit material within the tool budget.
