# Jira (GitHub for Atlassian) and ClickUp GitHub integrations: UX and flow catalogue (as of Oct 2026)

Naming note: the Marketplace app formerly called "GitHub for Jira" is now listed as **"GitHub for Atlassian"**. The marketplace API returns the name "GitHub for Atlassian" with the summary "Streamline development workflows across GitHub, Jira, and your Atlassian apps having unified data with one, Atlassian-powered app" — [Marketplace API](https://marketplace.atlassian.com/rest/2/addons/com.github.integration.production). The open-source repo atlassian/github-for-jira is deprecated: "This repository has been deprecated in favour of a private repository", and its README points to support.atlassian.com for docs — [GitHub repo](https://github.com/atlassian/github-for-jira). Some Atlassian docs still say "GitHub for Jira" (e.g. "Configure under GitHub for Jira") — [Atlassian: Connect GitHub Cloud](https://support.atlassian.com/jira-cloud-administration/docs/integrate-with-github/).

## Q1. GitHub for Atlassian (Jira): install/connect, backfill, GHES, Development panel, Smart Commits, Automation, admin config, permissions

### Takeaway
Jira uses a split-role wizard: a Jira site admin installs the Marketplace app, then a GitHub org owner connects the org through a GitHub App install. If the person running setup isn't an owner, the wizard gives them a "send a link to the owner" handoff. Data appears in two ways at once: real-time webhooks, plus an automatic 6-month backfill whose status is PENDING / IN PROGRESS / COMPLETE (or FINISHED) / FAILED. Admins can continue the backfill from a chosen date or restart it. On the work item, a Development panel shows aggregated counts with status lozenges and a details dialog, and has Create branch / Create commit / Create pull request actions. Smart Commits (`KEY #comment/#time/#transition`) report failures by email only.

### Cited Findings

**Install and connect flow (GitHub Cloud), with exact labels**
- Install: Jira **Apps** → **Explore more apps** → search **GitHub for Atlassian** → **Get app** → **Get it now** — [Atlassian: Connect GitHub Cloud to Jira](https://support.atlassian.com/jira-cloud-administration/docs/integrate-with-github/)
- Connect: **Get started** (or **Apps** > **Manage your apps** > **GitHub for Atlassian** if already installed) → **Continue** → choose **GitHub Cloud** → **Next** → GitHub sign-in → find the org → **Connect** — [Atlassian](https://support.atlassian.com/jira-cloud-administration/docs/integrate-with-github/)
- The **Connect** button "appears only if you own the GitHub organization". Non-owners get **Send them a link and ask them to connect**, which opens a "Send a link to an organization owner" dialog with a message and URL to send. The owner then signs in from that link and connects — [Atlassian](https://support.atlassian.com/jira-cloud-administration/docs/integrate-with-github/)
- Optional step: an **Enable Rovo Search for GitHub** page with a **Show GitHub data in Rovo** checkbox. Clearing it keeps the connection but leaves GitHub data out of Rovo. A final review screen lets you add another org, view all connected orgs, explore capabilities, or exit — [Atlassian](https://support.atlassian.com/jira-cloud-administration/docs/integrate-with-github/)
- Installing on a new org: **Select an organization in GitHub** opens GitHub in a new tab → pick the org → **All repositories** or **Only select repositories** → **Install** (owners only). Non-owners see **Request**, which emails the owner, and the owner uses **Approve & Install** — [Atlassian](https://support.atlassian.com/jira-cloud-administration/docs/integrate-with-github/)
- Repo scope: with **All repositories**, new repos are included automatically. With **Only select repositories**, you add repos manually: Apps > Manage apps → **Configure** under GitHub for Jira → org's **…** menu → **Configure** → **Repository access** → **Select repositories** → **Save** — [Atlassian](https://support.atlassian.com/jira-cloud-administration/docs/integrate-with-github/)
- Verify: Apps > Manage your apps, and check that the org appears under GitHub for Atlassian. The doc mixes the labels "Manage apps" and "Manage your apps" — [Atlassian](https://support.atlassian.com/jira-cloud-administration/docs/integrate-with-github/)
- Known edge case: a GitHub org IP allowlist can make the connection fail "even with the correct addresses", and a separate workaround article covers it — [Atlassian](https://support.atlassian.com/jira-cloud-administration/docs/integrate-with-github/)
- Linking: put the work item key (e.g. JRA-123) in branch names, commit messages and PR titles — [Atlassian](https://support.atlassian.com/jira-cloud-administration/docs/integrate-with-github/)

**Backfill (historical import) and its status UI**
- Connecting GitHub automatically imports **six months** of history. Going further back takes a manual backfill (Jira admin): **Apps** → **Manage apps** → **GitHub for Atlassian** in the sidebar → the settings icon for the org → **Continue backfill** → "Select the date you want to start importing history from" → **Backfill data**. A **Restart the backfill** checkbox replaces all existing historical data. By default the backfill appends — [Atlassian: Backfill GitHub data](https://support.atlassian.com/jira-cloud-administration/docs/understand-github-for-jiras-initial-backfill-process)
- What gets backfilled, and the matching rules:
  - PRs: key in the PR title, description or source branch name.
  - Builds and deployments: key in commit messages, branch names or PRs that are part of the workflow or deployment.
  - Commits: only the **latest 50 commits from non-default branches** that contain keys. Unreachable commits, such as those on deleted branches, are excluded.
  - Branches: key in the branch name, the latest associated PR title, or the last commit message.
  - Atlassian recommends running large backfills off-peak.
  - [Atlassian](https://support.atlassian.com/jira-cloud-administration/docs/understand-github-for-jiras-initial-backfill-process)
- Webhooks are live from the start: "New branches, commits, and PRs with keys show in Jira immediately, even during backfill". "You don't need to wait for backfill to finish" — [Atlassian FAQ](https://support.atlassian.com/jira-cloud-administration/docs/github-integration-faq/)
- Sync status values, from a mirror of the older repo SUPPORT.md (older behavior, not official current docs):
  - **PENDING**: backfill not started.
  - **IN PROGRESS**: more history appears over time while new data is processed.
  - **COMPLETE**: backfill finished.
  - **FAILED**: stopped on an error, and partial data may show.
  - The doc said "Jira shows no information until the status reaches COMPLETE", which contradicts the current FAQ quoted above.
  - Status lived at Jira Settings → Apps → Manage Apps → GitHub → Get started.
  - [Mirror of github-for-jira SUPPORT.md](https://github.com/kaydoh/jira/blob/master/SUPPORT.md)
- Older docs had a **"Restart backfill"** item in the "more options" menu. On GHES you expanded the GitHub App under the connected server first. It "rediscover[s] repositories and restart[s] historical data import". Users were told to check the GitHub App's Repository access first. Throughput was about 100 commits/sec, large installs could take "hours or days", and "All Repositories" includes forks — [Mirror SUPPORT.md](https://github.com/kaydoh/jira/blob/master/SUPPORT.md)
- A feature request gives the path as "Apps > GitHub > Configure Integration > Repo Settings '...' > Restart Backfill" and asks for automated backfill because it is manual today — [JRACLOUD-90014](https://jira.atlassian.com/browse/JRACLOUD-90014)
- Bugs and user reports:
  - A backfill can show "Finished" while old data is missing from the Development field, with no workaround — [JRACLOUD-91945](https://jira.atlassian.com/browse/JRACLOUD-91945)
  - A 2026 community thread title: "Commits/PRs not syncing and Backfill pulls 0 data after disconnect". Per search snippet, the status "quickly changes to FINISHED, but it pulls in 0 data" — [Atlassian Community](https://community.atlassian.com/forums/Jira-questions/GitHub-for-Jira-App-Commits-PRs-not-syncing-and-Backfill-pulls-0/qaq-p/3219774)
  - A full sync doesn't update builds and deployments — [JRACLOUD-89975](https://jira.atlassian.com/browse/JRACLOUD-89975)
- Older error strings:
  - "App is not responding. Wait or cancel." after clicking Getting started. The usual fix was to uninstall and reinstall.
  - "Exceeded issue key reference limit. Some issues may not be linked." when a branch or commit references more than 100 keys. Only the first 100 are sent, and sync status is unaffected.
  - Unmapped deployments: Jira only accepts the environment types development/testing/staging/production, GitHub environment names are mapped onto them, and unmatched names show as unmapped.
  - [Mirror SUPPORT.md](https://github.com/kaydoh/jira/blob/master/SUPPORT.md)

**GitHub Enterprise Server connection**
- Prerequisites: Jira site admin plus GitHub org owner. Firewall options: allow Atlassian IPs for a public URL, or build a locked gateway from a code template that yields a server URL, an **HTTP request header name** and an API key **value** — [Atlassian: Connect Jira to GHES](https://support.atlassian.com/jira-cloud-administration/docs/connect-a-github-enterprise-server-account-to-jira-software/)
- Flow: **Get started** → **Continue** → **GitHub Enterprise Server** → **Next** → enter **GitHub Enterprise Server URL** (plus the header name and value if using a gateway) → **Next**. Then either **Automatic app creation**, which redirects to GHES where you name the app → **Create GitHub App**, then update the Homepage URL with the app name; or create the app manually per a separate guide — [Atlassian GHES](https://support.atlassian.com/jira-cloud-administration/docs/connect-a-github-enterprise-server-account-to-jira-software/)
- Version requirements conflict. The GHES page says automatic creation needs **2.19+** — [Atlassian GHES](https://support.atlassian.com/jira-cloud-administration/docs/connect-a-github-enterprise-server-account-to-jira-software/). The FAQ says it needs **3.1+** for `callback_url` — [Atlassian FAQ](https://support.atlassian.com/jira-cloud-administration/docs/github-integration-faq/)
- Constraints and causes of GHES failures, all from the [Atlassian FAQ](https://support.atlassian.com/jira-cloud-administration/docs/github-integration-faq/):
  - Supported: multiple servers per Jira site, and multiple apps per server.
  - "One app, one site": each GitHub App connects to only one Jira instance.
  - Credential rotation: config page → **More actions** → **Edit** → update the client secret or private key → **Update**.
  - Common failures: blocked Atlassian IPs, SAML SSO (unsupported on GHES), reverse proxies (unsupported), self-signed certificates.
  - The server must reach `github.atlassian.com` over HTTPS.
  - Workflow, deployment and code-scanning data need GitHub Actions enabled.
- Legacy: DVCS accounts are cleaned up via **Jira settings** → **Jira apps** → **DVCS Accounts** → **More actions** → **Disconnect**. The DVCS connector is unsupported after March 31, 2024 — [Atlassian GHES](https://support.atlassian.com/jira-cloud-administration/docs/connect-a-github-enterprise-server-account-to-jira-software/)

**Permissions and security model**
- The app reads commit messages and branch names, and "no code is stored". Metadata is read-only (required by GitHub). Write access to PRs and issues lets it link work items from PR or issue comments when keys appear in square brackets. Contents write access lets it create branches on request. Permission upgrades are all-or-nothing: you can't accept new permissions while declining old ones — [Atlassian FAQ](https://support.atlassian.com/jira-cloud-administration/docs/github-integration-faq/)
- Author and reviewer names and avatars only show in the dev panel when the GitHub email matches the Jira email — [Atlassian FAQ](https://support.atlassian.com/jira-cloud-administration/docs/github-integration-faq/)
- Viewing the panel needs the "View development tools" permission. Jira checks permissions in the linked tool, so some items may be hidden from some users — [Atlassian: Development info](https://support.atlassian.com/jira-software-cloud/docs/view-development-information-for-an-issue/)
- User complaint (Jul 2025, 1 star): the app "inherits all permissions of Github admin", so anyone with dev-tools access can create branches in any org repo, private ones included — [Marketplace reviews API](https://marketplace.atlassian.com/rest/2/addons/com.github.integration.production/reviews?limit=30&sort=recent)

**Development panel on the work item**
- Sections: branches, commits, pull requests, builds, deployments, feature flags, reviews. Which appear depends on the connected tools. Each row shows a count plus a status (e.g. "1 pull request"). Clicking it opens a development dialog listing items, and each item links out to the tool — [Atlassian: Development info](https://support.atlassian.com/jira-software-cloud/docs/view-development-information-for-an-issue/)
- PR lozenge aggregation: **OPEN** if any PR is open, else **MERGED** if any is merged, else **DECLINED**. The number next to it counts PRs in that state. Reviews use REVIEW / APPROVAL / SUMMARIZE / REJECTED precedence — [Atlassian](https://support.atlassian.com/jira-software-cloud/docs/view-development-information-for-an-issue/)
- Limits: the dialog may show duplicates, with the unique count at the top. Only the first 100 commits appear. Once linked, dev info can't be removed — [Atlassian](https://support.atlassian.com/jira-software-cloud/docs/view-development-information-for-an-issue/)
- Actions:
  - **Create branch** opens the code tool (with a picker if several are connected) or lets you copy a git command. The key is auto-inserted. The name format is set via the settings icon beside "GIT CREATE & CHECKOUT A NEW BRANCH" and must include the key.
  - **Create commit** copies the key or a sample git command.
  - **Create pull request** opens the tool with the key in the title.
  - [Atlassian](https://support.atlassian.com/jira-software-cloud/docs/view-development-information-for-an-issue/)
- Empty state: the Development field sits under "Hide when empty" by default. Admins can move it to **Context fields** via Space settings → Work item layout → Edit work item layout, or via Work types for team-managed spaces — [Atlassian](https://support.atlassian.com/jira-software-cloud/docs/view-development-information-for-an-issue/)
- Other surfaces: board cards show PR/branch/commit icons with hover details. A Development page shows metrics (PR cycle time, deployment frequency), related work and suggestions — [Atlassian](https://support.atlassian.com/jira-software-cloud/docs/view-development-information-for-an-issue/)
- User complaint (Apr 2026): "The create branch doesn't apply the saved branch format. The list of branches is limited." — [Marketplace reviews API](https://marketplace.atlassian.com/rest/2/addons/com.github.integration.production/reviews?limit=30&sort=recent)

**Smart Commits**
- Syntax: `<ignored> KEY <ignored> #<command> <args>`. The commands, from [Atlassian: Smart Commits](https://support.atlassian.com/jira-software-cloud/docs/process-issues-with-smart-commits/):
  - `#comment` — e.g. `JRA-34 #comment corrected indent issue`
  - `#time 1w 2d 4h 30m <comment>` — decimals are allowed and the text goes to the work log
  - `#<transition>` — e.g. `JRA-090 #close #comment Fixed this today`
  - Commands can be chained: `JRA-123 #time 2d 5h #comment ... #resolve`
  - One command can target several keys, separated by whitespace or commas.
- Rules, from the same [Atlassian](https://support.atlassian.com/jira-software-cloud/docs/process-issues-with-smart-commits/) page:
  - Each command must stay on one line, and each line needs its own key.
  - Only the transition name before the first space is used. Use hyphens to disambiguate (`#start-review`).
  - `#resolve` can't set the Resolution field.
  - The transition **fails silently** if other required fields exist.
  - The committer email must match exactly one Jira user, and that user needs the relevant permission.
  - Only the default key format is supported.
  - Force-pushes and squash merges can re-run commands, so they look duplicated.
- Error reporting: the commit still shows on the work item. A failure triggers an **email** to the matched Jira user, or to the DVCS user if no Jira user matched. If neither address exists, the failure is silent — [Atlassian](https://support.atlassian.com/jira-software-cloud/docs/process-issues-with-smart-commits/)
- GitHub-specific failure causes: email mismatch, GitHub's "Keep my email addresses private" (the email is hidden from webhooks), a transition name not in the workflow, a restricted workflow step, and time tracking being off — [Atlassian FAQ](https://support.atlassian.com/jira-cloud-administration/docs/github-integration-faq/). Older troubleshooting advice was to check the author email by appending `.patch` to the commit URL — [Mirror SUPPORT.md](https://github.com/kaydoh/jira/blob/master/SUPPORT.md)

**Jira Automation triggered by GitHub events**
- DevOps source triggers: Branch created, Commit created, Pull request created, Pull request declined, Pull request merged. They work with Bitbucket, GitHub, GitLab and others — [Atlassian Community announcement](https://community.atlassian.com/t5/Automation-articles/New-automation-triggers-across-Jira-Cloud-Bitbucket-GitLab-amp/ba-p/1337351)
- Build and deployment triggers: Build status changed, Build successful, Build failed, Deployment status changed, Deployment successful, Deployment failed — [Atlassian Community](https://community.atlassian.com/forums/discussion/1442789/new-build-and-deploy-triggers-for-jira-automation)
- These triggers are only available when a source code tool is integrated — [Atlassian Confluence: Automation triggers](https://confluence.atlassian.com/display/SERVICEDESKCLOUD/Automation+triggers)
- Gotcha: a Commit created rule also fires for merge commits created by PRs — [Atlassian Community thread](https://community.atlassian.com/forums/Jira-questions/Transition-issue-when-pull-request-is-merged-on-a-specific/qaq-p/1028581)

**Admin config page / disconnect**
- From the docs: connected orgs are listed under GitHub for Atlassian in Manage apps. Each org has a **…** menu with **Configure** (Repository access), a settings icon with **Continue backfill**, and for GHES, **More actions → Edit** for credentials — [Atlassian](https://support.atlassian.com/jira-cloud-administration/docs/integrate-with-github/), [Backfill doc](https://support.atlassian.com/jira-cloud-administration/docs/understand-github-for-jiras-initial-backfill-process), [FAQ](https://support.atlassian.com/jira-cloud-administration/docs/github-integration-faq/)
- Older docs fixed an unresponsive app with **Uninstall** on Manage Apps followed by a reinstall — [Mirror SUPPORT.md](https://github.com/kaydoh/jira/blob/master/SUPPORT.md)

### Inferences
- Patterns worth copying:
  - The "you're not the owner, send this link to an owner" handoff.
  - The split between installer and connector roles.
  - An explicit backfill window ("Select the date you want to start importing history from"), with append vs **Restart** as separate choices.
  - Real-time webhooks running independently of backfill.
  - Panel counts that aggregate PR state by precedence (OPEN > MERGED > DECLINED).
  - Branch-name templates that must contain the key.
- Anti-patterns to avoid:
  - Smart Commit errors reported only by email, with silent failures in some cases.
  - A status that says "FINISHED/connected" while no data flows, which is the main theme in reviews.
  - No per-event delivery log or debug view.
  - Docs that reference UI labels that have changed.

### Gaps
- I found no current official doc with screenshots of the org list columns, the exact sync-status label set (current UI says FINISHED; older docs say COMPLETE), rate-limit display, or a per-repo progress bar.
- Uninstall/disconnect data-retention behavior isn't documented on the pages I fetched.
- The official Jira Automation triggers page on support.atlassian.com wasn't retrieved, so trigger labels come from community announcements.
- The Development panel doc fetch also returned "GitHub is supported only in Atlassian Government environments". This looks like a fetch or summary misreading (probably a note that applies to Government cloud), so treat it as unverified.

## Q2. ClickUp GitHub integration

### Takeaway
ClickUp has two connection types:
- **Personal**: per-user OAuth, needed to create branches, PRs and issues from a task.
- **Workspace**: admin-only. It connects GitHub, adds repos (repo admins only), and maps repos to Spaces.

Activity links when a task ID (`#id`, `CU-id`, or a custom ID) appears in a branch, commit, PR title or description. A status change can be embedded inline as `#id[status]`. The task shows a GitHub panel listing linked items with rich metadata, and activity also flows into the task feed. Separate GitHub Automations (Business plan and above) have PR, branch, commit and CI triggers with label and branch conditions. There's no general two-way issue sync: ClickUp can create GitHub issues, and an automation "Create Issue" action exists.

### Cited Findings
- Available on every plan. Only repo admins can add repos. Only Workspace owners and admins can create Workspace connections (several are allowed) and link repos to Spaces. Members and above can create personal connections. Guests and limited members can't use the integration — [ClickUp Help: GitHub integration (updated 2026-09-19)](https://help.clickup.com/hc/en-us/articles/6305771568791-GitHub-integration)
- Personal connection: Workspace avatar → **Apps** → **GitHub** → **Connect** → authorize → **Done**. This enables link previews, Create Branches and Pull Requests, and the app panel in Task view. Commands: Open GitHub, Create New GitHub issue, Create New GitHub Gist, Create New GitHub Branch, Create New GitHub Pull Request. "People can only see what they are authorized to view in GitHub" — [ClickUp Help](https://help.clickup.com/hc/en-us/articles/6305771568791-GitHub-integration)
- Workspace connection, three steps — [ClickUp Help](https://help.clickup.com/hc/en-us/articles/6305771568791-GitHub-integration):
  - Step 1: Apps → GitHub → **Workspace** tab → optional Workspace Connected Search toggle → **Connect** → authorize → **Select repositories** dropdown for search → **Save** → **Next** → **Done**.
  - Step 2: **Settings** (upper-right) → **Add repo**. "Only the connection owner can add repositories". "Attaching a repo does not give ClickUp users access to your repo's codebase".
  - Step 3: Settings → click the repo → **+ Add Space**. A repo can map to many Spaces, and a Space can hold many repos.
- Branch-name template: Settings → **Auto-generated branch name** → **Save**. The default is `:taskId:_:taskName:_:username:`, e.g. `CU-ae27de_Auto-generated-naming_John-smith` — [ClickUp Help](https://help.clickup.com/hc/en-us/articles/6305771568791-GitHub-integration)
- ID formats: `#{task_id}`, `CU-{task_id}`, `{custom_task_id}`, `#{custom_task_id}` (e.g. `#1abc2de`, `CU-1abc2de`, `eng-123`). They work in the PR title, PR description, branch name or commit message. When a PR contains a task ID, ClickUp **posts a comment with the task link on the PR**, using the GitHub account of whoever set up the repo↔Space mapping. No comment is posted when a PR link is pasted manually — [ClickUp Help](https://help.clickup.com/hc/en-us/articles/6305771568791-GitHub-integration)
- Manual linking: task → GitHub icon → **Add GitHub link** → paste → **Add**. The task must be in a Space linked to a repo — [ClickUp Help](https://help.clickup.com/hc/en-us/articles/6305771568791-GitHub-integration)
- Create from task: GitHub icon → suggested branch names and commit messages to copy, plus the task ID → **Add GitHub link** → **New GitHub Issue / New GitHub Branch / New GitHub Pull Request** → pick a repo and source/target branches → **Create**. This needs a personal connection and a linked Space — [ClickUp Help](https://help.clickup.com/hc/en-us/articles/6305771568791-GitHub-integration). The task sidebar also offers a copyable `git checkout -b "your-default-branch-name"` — [ClickUp Help: Integrations on tasks](https://help.clickup.com/hc/en-us/articles/35048588377495-Integrations-on-tasks)
- Fields shown per linked item, from [ClickUp Help](https://help.clickup.com/hc/en-us/articles/6305771568791-GitHub-integration):
  - PR: author, reviewers, assignees, line changes, link created, repository, source and target branch, status, URL.
  - Commit: author, changed files, line changes, repo, URL.
  - Branch: author, link creator, repo, URL.
  - Issue: author, reviewers, link created, repo, status, URL.
  - The **…** menu on each item offers copy link and delete.
  - A **Pull Requests** column is available in List and Table views.
- Activity feed: GitHub items can collapse (**Show more**). On merge, commits roll up into a single activity item, with a modal listing all commits. Activity can be filtered by "Git items". It uses the ClickUp username, or the GitHub username if there's no ClickUp account — [ClickUp Help](https://help.clickup.com/hc/en-us/articles/6305771568791-GitHub-integration)
- Inline status: `#{task_id}[status]`, e.g. `#ud5b[ready]`, with no space before the bracket. It applies "when you link a commit, push a commit, or create a pull request" — [ClickUp Help](https://help.clickup.com/hc/en-us/articles/6305771568791-GitHub-integration)
- GitHub Automations, from [ClickUp Help: Use GitHub Automations (updated 2026-09-28)](https://help.clickup.com/hc/en-us/articles/6305836061463-Use-GitHub-Automations):
  - Requirements: Business plan and above, the Automation ClickApp, and repo admin.
  - Triggers: Pull Request Merged, Branch Merged, On Commit, Pull Request Review Created, Pull Request Review Updated, CI/CD Status Changed, Pull Request Linked, Branch Linked, Commit Linked.
  - Conditions: GitHub label, Head ref, Base ref, with logic "is any of / is all of / is not any of / is not all of / is set / is not set". They are case-sensitive.
  - Actions: every action except webhook. A task must already be linked unless the action is Create Task.
  - GitHub-side action: Create Issue.
  - Each automation picks one repo. You also specify who can use your GitHub account for automations. To update the account you remove and re-add it, and removal doesn't break existing automations.
- Errors and recovery:
  - The "Missing activity" guidance is to check the task ID format.
  - "Connection issues" advice: disconnect and reconnect repos or the account (Settings → repo **…** → **Delete from ClickUp**).
  - Full disconnect: Workspace tab → **…** next to **Connected** → **Disconnect** → confirm **Disconnect**.
  - [ClickUp Help](https://help.clickup.com/hc/en-us/articles/6305771568791-GitHub-integration)
- OAuth scopes listed: `read:user`, `repo`, `admin:repo_hook` (webhooks for sync), `project`, `read:org`. ClickUp uses an OAuth app here, not a GitHub App — [ClickUp Help](https://help.clickup.com/hc/en-us/articles/6305771568791-GitHub-integration)

### Inferences
- Ideas for Plane:
  - Space↔repo mapping, analogous to Plane project↔repo.
  - A configurable branch-name template with tokens.
  - Copyable branch names, commit messages and git commands on the issue.
  - A bot back-link comment on the PR.
  - Inline status syntax.
  - Commit roll-up on merge.
  - Automation conditions on base and head ref and on labels.
- ClickUp's coarse `repo` + `admin:repo_hook` OAuth scopes are broader than a GitHub App's. Jira's GitHub App model gives finer per-repo access.

### Gaps
- No ClickUp docs on backfill or historical import. Activity appears to start at link time, but this is unconfirmed.
- No documented sync-status or health UI, and no docs on rate limits or webhook failure reporting.
- No GHES support statement was found.
- Two-way GitHub Issue ↔ task sync isn't documented. Only creating issues and linking exist.

## Q3. Error/empty/edge states and what users value or complain about

### Takeaway
Both tools mostly tell users "check your ID/key format, emails, repo access, then disconnect and reconnect". Neither shows per-event delivery errors. GitHub for Atlassian has 508 reviews with an average of about 3.34 stars. Recent reviews are dominated by "shows connected but nothing syncs, no way to debug" and by outages.

### Cited Findings
- Marketplace: 508 reviews with an average of 3.34 stars — [Marketplace API](https://marketplace.atlassian.com/rest/2/addons/com.github.integration.production)
- Review quotes, all from the [Marketplace reviews API](https://marketplace.atlassian.com/rest/2/addons/com.github.integration.production/reviews?limit=30&sort=recent):
  - Apr 2026, 1 star: "all status indicators show that the system is 'connected' and should be functioning, yet no data is synced. There is no way to debug or see where the actual failure is happening".
  - Oct 2025: the docs "reference names and buttons that either don't exist or have changed".
  - Aug 2025: several reviewers say it was "Not working since Aug 5th, 2025 -- not a word from Atlassian", and one says it was "not refreshing the status anymore".
  - Positive, Jan 2026, 4 stars: it "works out of the box", but data only appeared after the first new PR was merged.
  - A request to connect the same repos to both production and sandbox Jira sites. This conflicts with the "one app, one site" constraint for GHES — [FAQ](https://support.atlassian.com/jira-cloud-administration/docs/github-integration-faq/)
- Empty states:
  - Jira hides the Development field when empty by default — [Atlassian](https://support.atlassian.com/jira-software-cloud/docs/view-development-information-for-an-issue/)
  - Older docs said no data shows until backfill is COMPLETE — [Mirror SUPPORT.md](https://github.com/kaydoh/jira/blob/master/SUPPORT.md)
  - Newly added repos may not show until something links to an issue — [Atlassian Community (2023)](https://community.atlassian.com/forums/Jira-questions/New-Github-Repo-not-recognized-by-JIRA-Github-App/qaq-p/2450551)
- Older behavior (2018): an org sync stuck at PENDING for hours eventually completed after roughly 8–24 hours (per search snippet) — [Atlassian Community (2018)](https://tnckb94959.lithium.com/forums/Marketplace-Apps-Integrations/GItHub-for-Jira-How-soon-should-I-expect-organization-syncing-to/qaq-p/909023)

### Inferences
- What to audit in a Plane↔GitHub sync service:
  - Surface per-repo and per-event sync health: last webhook received, last error, rate-limit state.
  - Distinguish "connected" from "data flowing".
  - Report smart-command failures in-product, e.g. as an issue comment or activity entry, not just by email.
  - Make backfill scope and progress explicit, with counts, not just a status word.
  - Handle the edge cases these tools hit: private-email commits, email mismatch, more than 100 keys per item, force-push duplication, and merge commits firing commit triggers.

### Gaps
- No ClickUp user reviews were gathered: G2 and Capterra weren't fetched within the tool budget.
- No official Atlassian statement on uninstall or app-suspension behavior. For example, whether data stays when the GitHub App is uninstalled from the GitHub side is undocumented in the sources fetched.
