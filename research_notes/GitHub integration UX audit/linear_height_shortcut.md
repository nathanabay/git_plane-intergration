# Linear, Height and Shortcut GitHub integrations: user flows and UX catalogue (as of Oct 2026)

Source note: Linear docs pages carry no publication dates; they were fetched live on 2026-10-12 and are treated as current. Older Shortcut help-center URLs (help.shortcut.com) now 301 to shortcut.com/help. Height has shut down (see Q3).

## Linear: connection, account linking, branches, magic words, PR panel, workflow automation, Issues sync, linkbacks, errors

### Takeaway
Linear's model is: one workspace-level GitHub App install (org-wide, All vs selected repos), plus optional personal GitHub account linking for attribution. Linking happens through the issue ID in the branch name, PR title or description. Status transitions are configured per team, with per-target-branch regex overrides, and wait for the last of several linked PRs. A rich PR attachment on the issue shows reviewers and previews, and a linkback comment is posted on the PR. GitHub Issues sync can be one-way or two-way for each repo↔team, and only one two-way repo is allowed per team.

### Cited Findings
**Workspace connection / App install**
- Path: **Settings > Features > Integrations > GitHub**, click **Enable**, select the GitHub org, choose **All repositories** or **Only select repositories**, click **Install**, then authenticate your personal GitHub account. An org owner must install for org-level access; a repo admin can install for repo-level access only. — [Linear Docs: GitHub](https://linear.app/docs/github)
- App permissions: read access to checks, commit statuses, deployments, members, merge queues and metadata; read/write access to actions, code, issues, pull requests and workflows. — [Linear Docs: GitHub](https://linear.app/docs/github)
- Multiple orgs: use the **+** icon under **Connected organizations**. Multi-org works for PR automation only; commit linking works with one org. A GitHub org can connect to only one Linear workspace. — [Linear Docs: GitHub](https://linear.app/docs/github)
- GitHub Enterprise Cloud (*.ghe.com) is a separate entry: **Settings > Integrations > GitHub Enterprise Cloud** > **Enable**, then enter the .ghe domain, repeated for each org. If an IP allow list is in use, turn on **Enable IP allow list configuration for installed GitHub Apps** or allow Linear's IPs. — [Linear Docs: GitHub](https://linear.app/docs/github)
- GitHub Enterprise Server uses a separate integration and a self-created GitHub App. The webhook secret must be saved at creation; if it is lost, you must disconnect, remove the installation and reinstall. GHES limits: single org, PR-description magic words only, no commit linking, no Issues sync, and no multi-repo sync to one team. — [Linear Docs: GitHub](https://linear.app/docs/github)

**Personal account linking**
- Linked under **Settings > Connected accounts**. It attributes synced activity, synced comments and assignees to the user. **Members who have not connected see a banner in the GitHub integration settings.** — [Linear Docs: GitHub](https://linear.app/docs/github)
- A GitHub account can connect to only one Linear workspace. — [Linear Docs: GitHub](https://linear.app/docs/github)

**Branch names**
- A workspace-level **Branch format** setting lives in the GitHub integration settings. On an issue, **Copy git branch name** (shortcut `Cmd/Ctrl + Shift + .`) copies the name. An issue ID in the branch name auto-links the PR. — [Linear Docs: GitHub](https://linear.app/docs/github)
- Personal settings under **Settings → Account → Code & reviews** have a **Move issue to started status** group, with separate settings for copying the git branch name and for opening the issue in a coding tool (including **Copy as prompt**). Closed or already-started issues are not moved. Holding Option/Alt skips the status change for one action. — [Linear Docs: Code & reviews](https://linear.app/docs/code-and-reviews)
- Account **Preferences** can auto-assign to yourself the issues you create and the issues you move to started. — [Linear Docs: GitHub](https://linear.app/docs/github)
- Third-party troubleshooting content describes the recognized format as team-key/issue-number/short-description. — [workmanagementhub (third-party)](https://workmanagementhub.com/linear-github-sync-troubleshooting-2026/)

**Magic words / linking**
- Closing words: close, closes, closed, closing, fix(es/ed/ing), resolve(s/d/ing), complete(s/d/ing), implement(s/ed/ing), "linear issue". These apply the **On PR or commit merge** status. — [Linear Docs: GitHub](https://linear.app/docs/github)
- Non-closing words: ref, refs, references, part of, contributes to, toward(s). These move the issue through statuses but do not apply the merge status. Relation words "relates to" and "related to" only mark the PR as related. — [Linear Docs: GitHub](https://linear.app/docs/github)
- Opt-out: `skip` or `ignore` + ID (e.g. `Ignore ENG-123`) prevents linking. This is also the way to unlink a PR whose branch name carries the ID. — [Linear Docs: GitHub](https://linear.app/docs/github)
- Creating from a PR: `{TEAM}-NEW` (e.g. `ENG-NEW`) in the PR description creates and links a new issue in Started, assigned to the PR author. On Business and Enterprise plans, AI writes the title and description and sets labels, project and milestone; other plans use the PR title. Nothing is created if an issue is already linked. — [Linear Docs: GitHub](https://linear.app/docs/github)
- An ID in the PR title, or a magic word + ID in the title or description, links on save. One magic word can take several IDs (`Fixes ENG-123, DES-5, and ENG-256`). **Magic words in PR comments do not link.** If the issue is unassigned, the PR author becomes the assignee. To link an existing PR, edit its title or description. — [Linear Docs: GitHub](https://linear.app/docs/github)

**Commit linking**
- Turned on with the **Link commits to issues with magic words** toggle at the bottom of the GitHub settings page. You then add a GitHub webhook by hand (Payload URL and Secret shown by Linear, `application/json`, **Push events**), then click **Done** in Linear. A magic-word commit moves the issue to In Progress on push and to Done when the commit reaches the default branch. Not available on GHES. — [Linear Docs: GitHub](https://linear.app/docs/github)

**PR attachment / panel on the issue**
- The GitHub attachment shows reviewer avatars and their actions (commented, changes requested, approved). A team review request shows "review requested" or "in review" instead of avatars. — [Linear Docs: GitHub](https://linear.app/docs/github)
- To remove: open the three-dot menu on the attachment and choose **Remove**, or search `git.` in the command menu. — [Linear Docs: GitHub](https://linear.app/docs/github)
- Preview links: a Markdown link whose label ends in "Preview" becomes a preview shortcut. Vercel, Netlify, Cloudflare and AWS Amplify are auto-detected. Several previews appear in a dropdown, and they are removed after 30 days of PR inactivity. — [Linear Docs: GitHub](https://linear.app/docs/github)
- **Git attachment format** is a personal setting: Title, or Title+Repository. **Open GitHub pull requests in** is GitHub or Graphite. — [Linear Docs: Code & reviews](https://linear.app/docs/code-and-reviews)
- All linked PRs appear in the issue details. — [Linear Docs: GitHub](https://linear.app/docs/github)

**Workflow automation (team-level)**
- Path: **Settings > Team > Workflows & automations > Pull request and commit automations**, configured separately for each team. Trigger states are draft, opened, review requested, ready for merge and merged. The defaults are In Progress on PR open and Done on merge. — [Linear Docs: GitHub](https://linear.app/docs/github)
- "Ready for merge" requires a review or checks configured in GitHub. Unstable PRs, including those with failed non-required checks, do not trigger it, and it requires a review-request automation to be configured. Without branch protection, the issue skips the review state and goes to ready-to-merge. — [Linear Docs: GitHub](https://linear.app/docs/github)
- Per-branch rules apply to the **target** branch only, using regex (e.g. `^fea/.*`). Choosing **no action** overrides a default (e.g. `staging` → "In QA", `main` → "Deployed"). — [Linear Docs: GitHub](https://linear.app/docs/github)
- Multiple PRs: the status updates only when the **last** linked PR reaches the required state. — [Linear Docs: GitHub](https://linear.app/docs/github)
- Reverse automation: canceling an issue, or marking it a duplicate, closes open linked PRs that used Closes or Contributes. Completing an issue does not close them. A PR stays open if another open issue still links it. — [Linear Docs: GitHub](https://linear.app/docs/github)
- Custom merge queues: add the `externally-merged` label before closing so the PR counts as merged. — [Linear Docs: GitHub](https://linear.app/docs/github)
- Squash into a new branch loses previously linked issues; you must relink in the new PR. — [Linear Docs: GitHub](https://linear.app/docs/github)
- Older (2019): a changelog entry added moving to a review state when review is requested, and reopening issues when a PR is reverted. — [Linear changelog 2019-08-25](https://linear.app/changelog/2019-08-25-github-pull-request-improvements) (seen as a search snippet only, not fetched in full)

**GitHub Issues sync**
- In the integration's **GitHub Issues** section, click **+**, pick the repo and the Linear team, then choose **One-way** (GitHub→Linear) or **Two-way**. Only one repo per team can be two-way. Change it with **... > Edit Link**. — [Linear Docs: GitHub](https://linear.app/docs/github)
- Synced fields: title, description, status, assignee, labels, sub-issues, comments, priority. **Only newly created issues sync**; existing issues need the Importer. Remove the attachment (overflow menu) on the Linear issue to stop syncing. Sync banners show connection status and errors. — [Linear Docs: GitHub](https://linear.app/docs/github)
- Launched 2023-12-14 as two-way sync of title, description, status, labels, assignee and comments. Users can reply to GitHub comments from Linear while keeping private Linear-only discussion. — [Linear changelog: GitHub Issues Sync](https://www.linear.app/changelog/2023-12-14-github-issues-sync)

**Linkbacks and notifications**
- When linked, Linear posts a linkback comment on the PR with the issue title, description, images and attachments. For private teams, the linkback hides the title and limits access to team members. Linkbacks can be turned off in integration settings; the FAQ gives this as the fix for "notification on every PR open." — [Linear Docs: GitHub](https://linear.app/docs/github)
- Personal **Review notifications**: **Comments & reviews** (All / Exclude Bots / None), **Review requests**, **GitHub team review requests** (teams of 10 or fewer only), and **Checks & merge queue**. — [Linear Docs: Code & reviews](https://linear.app/docs/code-and-reviews)

**Newer code-review surface (Linear Reviews / Diffs)**
- The sidebar has a **Reviews** section (`G`+`R`) with **For me** and **Created** tabs. It shows PR details, the diff (Unified/Split), CI checks and overall status, and review actions (approve / request changes / comment) that sync to GitHub, plus merge from Linear. Display options: group by status, author or repo; hide draft or closed; show failed checks or preview links. — [Linear Docs: Diffs](https://linear.app/docs/diffs)
- Requirements: the **Enable code reviews** toggle (Settings → Code & reviews), code access granted through the integration, and a connected personal GitHub account. Personal settings include **Auto-convert draft pull requests** and **Merge strategy**. — [Linear Docs: Diffs](https://linear.app/docs/diffs); [Linear Docs: Code & reviews](https://linear.app/docs/code-and-reviews)

**Errors / disconnected states**
- A sync error banner is shown on the issue when sync fails. The generic fix is to disconnect in GitHub, reset at linear.app/reset, and reconnect. — [Linear Docs: GitHub](https://linear.app/docs/github)
- A third-party guide reports that most link failures are matching failures (ID not in branch, title or description) and fail silently, with no error or notification. It says a green "Connected" badge only proves OAuth worked, not webhook delivery. — [workmanagementhub (third-party, unverified)](https://workmanagementhub.com/linear-github-sync-troubleshooting-2026/)

### Inferences
- Linear splits settings across three scopes. The **workspace** (integration page) holds the install, orgs, branch format, linkbacks, commit linking and the Issues sync links. Each **team** holds the status mapping and per-branch rules. The **personal account** holds connected account, copy-branch→started, attachment format and notifications. A Plane sync should map these scopes the same way: workspace, project, user.
- The core UX patterns are an explicit opt-out syntax (skip/ignore), aggregate state across multiple PRs (last-PR-wins), target-branch regex rules with an explicit "no action", and reverse automation (cancel issue → close PR).
- Linear shows connection health as a banner in settings for unlinked members and on the issue for sync errors. Silent link-matching failures remain a known weak spot.

### Gaps
- I did not find the exact option names for the **Branch format** dropdown or the exact label of the linkback toggle. The docs describe them without verbatim labels.
- The docs do not document the Issues sync status or label mapping rules (how GitHub open/closed maps to Linear states, and whether labels are auto-created).
- There are no screenshots or video walkthroughs confirming the empty state or onboarding of the integration page.

## Linear settings UI: team vs workspace, toggles, defaults, onboarding

### Takeaway
See the cited findings above. Workspace = Settings > Features > Integrations > GitHub. Team = Settings > Team > Workflows & automations > Pull request and commit automations (defaults: open → In Progress, merge → Done). Personal = Settings > Account > Code & reviews, plus Settings > Connected accounts.

### Cited Findings
- Team automation is configured separately for each team. Its triggers are draft, opened, review requested, ready for merge and merged, with per-branch regex rules and **no action**. — [Linear Docs: GitHub](https://linear.app/docs/github)
- A banner in the integration settings prompts unconnected members to link their GitHub accounts. — [Linear Docs: GitHub](https://linear.app/docs/github)
- **Require signed commits** is a workspace setting that only an admin can change; **Commit signing key** is personal. — [Linear Docs: Code & reviews](https://linear.app/docs/code-and-reviews)

### Inferences
- Defaults that work with zero configuration (open → started, merge → done) plus opt-in refinements appear to be the expected baseline.

### Gaps
- No source described the empty state or first-run onboarding screens of the GitHub settings page.

## Height and Shortcut: setup, linking, automation, VCS panel, differences

### Takeaway
Height is defunct, so it is only a historical reference. Shortcut is the strongest secondary reference. Its model is an admin-only GitHub App install, email-based user matching, **Git Helpers** for branch names with customizable **Git Branch Formatting**, `[sc-123]` linking anywhere (including PR comments), and user-built **Event Handlers** (event → workflow state). It skips handlers when other open work exists, and its Story pane shows review status, build status and PR labels.

### Cited Findings
**Height**
- Height announced a shutdown by September 2025 (headline from March 24, 2025). A third-party site says Height stopped operating on 2025-09-24. — [AlternativeTo news](https://alternativeto.net/software/height/news); [Subger (third-party)](https://subger.com/en/cancel/height)
- Height staff on the forum said its GitHub integration "keep[s] tasks up to date as code ships" and can "crosspost comments". GitHub Issues was a one-off import, not a sync, and users asked for real sync. — [Height forum](https://forum.height.app/t/synchronize-github-issues-with-height-instead-of-one-off-import/1713)

**Shortcut: setup**
- Only users who are admins in both Shortcut and GitHub can install. Go to **Integrations > GitHub** > **Add Account**; in GitHub, choose the account or org, all or selected repos, then **Install**. Other workspaces use **Add Account from Another Workspace**. — [Shortcut Help: GitHub](https://www.shortcut.com/help/integrations/github)
- One workspace links to only one GitHub org at a time. — [Shortcut Help (search snippet)](https://help.shortcut.com/hc/en-us/articles/207540323)
- **User matching is by email**: a user's primary GitHub email must match an email on their Shortcut profile. There is no OAuth account-link step. — [Shortcut Help: GitHub](https://www.shortcut.com/help/integrations/github)
- GitHub Enterprise: support must enable it first. Then **Add Account**, enable **GitHub Enterprise**, copy the **GitHub Enterprise Payload URL**, and add a webhook (`application/json`, **Send me everything**, or Create/Delete/Comment/Pull Request/Push). — [Shortcut Help: GitHub](https://www.shortcut.com/help/integrations/github)

**Shortcut: branch and PR linking**
- **Git Helpers** on a Story copy the suggested branch name, which must contain `/sc-<id>/`. The format is customized at **Integrations > your VCS provider > Git Branch Formatting**. — [Shortcut Help: GitHub](https://www.shortcut.com/help/integrations/github)
- Branch formatting offers presets and a "Custom Format" that picks attributes and their order, including the team mention name and the Epic name. PR titles can be auto-generated from Product Area. (Blog, 2023-07-01.) — [Shortcut blog](https://www.shortcut.com/blog/shortcut-vcs-integration)
- Link with `[sc-123]` or the Story URL in a branch, commit message, PR title, PR description **or PR comment**. `[sc-123][sc-456]` links several Stories. `[sc-new-story]` (or a branch containing `sc-new-story`) creates and links a new Story. Commits can be removed from Story Activity and restored. Commit verbs in the Workflow (e.g. a finish verb) can move a Story. — [Shortcut Help: GitHub](https://www.shortcut.com/help/integrations/github)
- Opt-out: the `skip-sc` PR label or `[skip-sc]` in the title or body. — [Shortcut Help: GitHub](https://www.shortcut.com/help/integrations/github)

**Shortcut: Event Handlers (automation)**
- Path: **Integrations > your VCS provider > Event Handlers** > **Add New Event Handler**. Choose an event (branch association, commit association, PR opened, approval, label, review requested, merge), enter a branch or label if needed, then choose the destination Workflow State. — [Shortcut Help: GitHub](https://www.shortcut.com/help/integrations/github)
- Named handlers include Pull request opened, Pull request labeled, Pull request review requested, Pull request approved and Branch merged. — [Shortcut Help (search snippet)](https://help.shortcut.com/hc/en-us/articles/207540323)
- Draft PRs do not trigger handlers until they are opened. PR-opened and branch-merged handlers are held back when the Story has another open PR or an unmerged, undeleted branch. — [Shortcut Help: GitHub](https://www.shortcut.com/help/integrations/github); [Shortcut blog 2023](https://www.shortcut.com/blog/shortcut-vcs-integration)

**Shortcut: VCS display on the Story**
- The Story pane shows PR review status (review required / changes requested / approved), build status (in progress / failed / successful), PR labels on hover, and overlapping PRs. (Blog, 2023-07-01.) — [Shortcut blog](https://www.shortcut.com/blog/shortcut-vcs-integration)

### Inferences
- Shortcut's improvements over Linear are three. (1) Automation is an explicit event→state list that the user builds, rather than fixed slots. (2) Labels can act as triggers. (3) Comments also link (Linear ignores magic words in comments).
- Linear's improvements over Shortcut are explicit OAuth account linking (more reliable than email matching), per-target-branch rules and reverse automation.
- Both tools converge on an ID token in the branch name, a copy-branch helper, draft PRs that do not advance state, explicit opt-out tokens and labels, and multi-PR gating.

### Gaps
- Height's official help pages are unavailable (the site is shut down, and the Wayback fetch was blocked), so I could not verify its settings labels or status-automation specifics.
- I did not confirm whether Shortcut has a two-way GitHub Issues sync (none was found), or Shortcut's current (2026) Story VCS panel visuals beyond the 2023 blog.

## Common UX patterns users value

### Takeaway
Users value one-click branch names, zero-config default transitions, visible review and check status on the ticket, and explicit opt-outs. Their pain points are silent link-matching failures and branch-name ergonomics.

### Cited Findings
- Most "not linking" reports are ID-matching failures that fail silently, and "Connected" badges can be misleading about webhook health. — [workmanagementhub (third-party)](https://workmanagementhub.com/linear-github-sync-troubleshooting-2026/)
- Hacker News users split on ID-heavy branch names. Some dislike opaque IDs like ISSUE-9482; others value Linear's one-click copy. — [HN thread (via search summary)](https://news.ycombinator.com/threads?id=r1cka)
- Linear's FAQ treats linkback comments as a notification-noise problem and makes them toggleable. — [Linear Docs: GitHub](https://linear.app/docs/github)

### Inferences
- For a Plane↔GitHub sync audit, these features are worth checking: a webhook-health indicator separate from auth status; feedback when a PR mentions an unknown ID; a toggleable or quiet linkback comment; private-project redaction in linkbacks; last-PR-wins gating; and draft-PR suppression.

### Gaps
- I found no Reddit or G2 threads specifically about Linear, Shortcut or Height GitHub UX; the community evidence is thin and partly third-party.
