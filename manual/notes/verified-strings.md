# Verified UI strings (verbatim)

Every user-visible string in `src/ui/client/*.tsx` (plus the Plane-fork labels and server texts that appear on screen),
grouped by screen. Use this list to check bold labels in the manual: a bold label must match a line here exactly
(or be a Plane CE label verified by screenshot). `<…>` marks a value filled in at runtime.

## Plane fork navigation (apps/, packages/)

- GitHub Sync — workspace settings sidebar item (`apps/web/core/components/settings/workspace/sidebar/item-categories.tsx:77`) and page title
- GitHub Sync — God mode sidebar item; description "Manage GitHub synchronization." (`apps/admin/app/(all)/(dashboard)/sidebar-menu.tsx:32-33`)
- Development — iframe title in the work-item sidebar (`apps/web/core/components/issues/issue-detail/sidebar.tsx:255`)
- GitHub Sync Workspace Configuration — workspace iframe title
- GitHub Sync Admin Configuration — God mode iframe title

## Shared (common.tsx)

- Not authorised
- <reason> Sign in to Plane with an account that has the right access, then reload this page.
- Something went wrong
- Try again
- Loading…
- Saving…
- Saved.
- never  (formatTime for a missing time)

## Workspace page shell (Workspace.tsx)

- Git sync: <slug>
- Repositories
- User links
- My GitHub account
- Audit log
- Workspace settings need a workspace admin.

## Health banners and checklist (health.tsx)

- The sync database is unreachable. Settings and activity cannot be loaded.
- Plane changes have stopped arriving. Ask a workspace admin to re-enable the Git sync webhook in Plane’s webhook settings.
- GitHub App credentials could not be decrypted. Ask an instance admin to repair the GitHub App settings.
- Set up GitHub sync
- Connect the GitHub App and choose a repository below.
- Rules: shipping defaults are ready; customize them after adding a mapping.
- Rules: custom rules are saved.
- Conflict policies: default policies are ready; customize them after adding a mapping.
- Conflict policies: custom policies are saved.
- Member accounts: <n> linked of <m>.
- Member accounts: <n> linked; total membership could not be loaded.
- App events: verified.
- App events: need attention from an instance admin.
- App events: not yet verified; ask an instance admin to check setup.

## Mapping health card (health.tsx)

- Disabled · <reason>
- Last GitHub delivery
- Last Plane delivery
- Last successful write
- Errors in the last 24 hours
- Rate-limited until

## Repositories tab (Workspace.tsx MappingsPage)

- Refresh sync health
- Repository mapped
- Not now
- Mapped repositories
- No repository is mapped to a project in this workspace yet.
- Loading setup checklist…
- Repository | Plane project | Direction | Sync health  (table headers)
- Loading project…
- Project unavailable
- Two-way
- GitHub to Plane
- Health unavailable
- Edit
- Remove
- Remove the mapping for <owner/repo>? Its rules and conflict policies are deleted too.
- Reload project names
- Map a repository

## Mapping form (Workspace.tsx MappingForm)

- GitHub repository
- Repositories your account can access in this workspace's connected installations.
- Refresh repositories
- Connect your personal GitHub account to select a repository.
- Reconnect your personal GitHub account to select a repository.
- No repositories available. Connect an installation or ask its owner to grant repository access.
- Choose a repository
- Previously mapped repository (access unavailable)
- <owner/repo> (private)
- Plane project
- Choose a project
- Previously selected project (unavailable)
- Reload projects
- No projects are available in this workspace.
- Open state
- Where an issue goes when it is reopened on GitHub (and where new open issues start). Leave empty for the project's default not-started state; new issues then keep Plane's default state.
- Closed state
- Where an issue goes when it is closed on GitHub. Leave empty for the project's default completed state.
- Project default
- Choose different states for open and closed.
- Reload states
- Sync direction
- Two-way mirrors issues both ways; GitHub to Plane only never writes back to GitHub.
- Two-way
- GitHub to Plane only
- Smart Commits
- Loading instance default…
- Reload defaults
- Post link-back comments on GitHub
- Report problems as comments on GitHub and Plane
- GitHub autolink references (unavailable)
- Add mapping
- Save changes

## State picker (pickers.tsx)

- Project default
- No state change
- Choose a state
- <State name> · Backlog | Not started | In progress | Completed | Cancelled
- <Group> (any matching state)
- Previously selected: <value>
- Choose a member
- Choose a workspace

## Mapping page tabs (Workspace.tsx MappingPage)

- <owner/repo>  (heading)
- Settings
- Conflict policies
- Rules
- Test rules
- That mapping does not exist in this workspace.
- Back to repositories

## Conflict policies

- Which side wins when both change the same field between syncs.
- Title | Description | State | Assignees | Labels | Comments
- Last write wins
- GitHub is the source of truth
- Plane is the source of truth
- Save policies

## Rules

- Rules decide what happens on each GitHub event. State mappings are rules too, for example when: pull_request.merged then set_state: completed:Done.
- Saved version <n>.
- Using shipping defaults (not saved yet).
- Lifecycle mapping table
- Raw YAML editor
- Lifecycle points → Plane state
- Choose a project state for each event. Leave it empty for no state change.
- Lifecycle event | Target state
- Branch pushed
- PR drafted
- PR opened
- Review requested
- Changes requested
- PR approved
- Ready for merge
- PR merged
- PR closed without merge
- PR reopened
- Merged base-branch regex
- The PR base branch must match this regex for the merged state to apply (default: ^main$).
- Branch-aware rules
- Evaluated before defaults; first match wins. Useful for staging/release branch flows.
- Base branch (regex) | Lifecycle | Target state
- N/A (branch has no base)
- No branch-specific rules configured.
- + Add branch rule
- Save mapping table
- Rules (YAML)
- Use lifecycle, branch, push, check, deployment, issue or comment triggers. Test rules before saving.
- Example: - when: pull_request.merged then: [{set_state: "completed:Done"}]
- Rule to update
- Rule <n> · <triggers>
- Target state
- Apply state to selected rule
- Validate and save YAML
- The current YAML contains custom rules or manual edits that cannot be represented in the table. Switching to table mode will replace your rules with defaults upon save. Discard custom YAML?
- Saving the mapping table will overwrite your custom YAML rules. Overwrite?
- Rule versions
- Reload author names
- No saved versions yet.
- Version | Saved by | Saved at | Action
- <n> (current)
- Former or unavailable member
- System
- Restore
- Restore version <n>? This creates a new version and replaces unsaved editor changes.

## Test rules (dry-run)

- Run a delivery through the rules without writing anything. Leave the rules empty to use this mapping's saved rules.
- Test input
- Webhook delivery
- Specific rule trigger
- Source  (GitHub | Plane)
- Event  (Pull request | Pull request review | Push | Check suite | Deployment status | Issues | Issue comment | Issue — humanised)
- Rule trigger
- Choose a suggestion or enter any trigger accepted by the engine, including issue.*, comment.*, check_suite.* and deployment_status.* families.
- Recorded delivery (audit entry id)
- Uses the payload stored in the audit log instead of the one below.
- Payload (JSON)
- Rule context (JSON)
- Optional fields: repo, project, author, base_branch, head_branch, labels, context (for templates). Use {} to test only the trigger.
- Rules to test (YAML, optional)
- Run dry-run
- The payload is not valid JSON
- That delivery is not an automation event.
- Trigger: <trigger>. Matched rule <n> (<name>).
- Trigger: <trigger>. No rule matched.
- No actions would run.

## Backfill

- Backfill
- Link this repository's open pull requests and issues to the Plane work items they mention.
- Link existing open PRs and issues now
- Run backfill
- Continue
- Checked <n> pull requests and <m> issues: <k> links made, <u> references did not match a work item.
- More items remain; continue to check the next batch.

## User links

- Linked GitHub accounts
- No Plane users are linked to GitHub accounts yet. Unlinked users are attributed to the service account.
- Plane member | GitHub account
- Loading member…
- Former or unavailable member
- Needs re-authorization. Reconnect using this member’s own Plane session.
- Unlink
- Unlink <login>? Any credentials stored for this user are deleted.
- Reload member names
- Link a user
- Plane member
- Reload members
- No active members are available.
- GitHub username
- Look up id
- GitHub user id
- Numeric and stable across renames.
- Lookup failed
- Link account

## Audit log (Workspace.tsx AuditLogPage, audit.tsx)

- Audit log
- Errors in the last <n> hours for mapping <id>.
- Showing instance and workspace activity.
- Showing activity with no workspace.
- A Plane instance-admin session is required.
- No activity matches this view.
- When | Workspace | Event | Outcome | Detail
- View workspace activity
- Instance
- · GitHub / · Plane
- Replay
- Replay this delivery? It runs again under a new delivery id and may write to Plane and GitHub.
- Retry
- Retry scheduled
- Load older entries
- Show raw
- Recorded sync activity
- GitHub account: <login>
- Rule: <name>
- Event labels: Webhook received; Unrecognized webhook; Branch or commit push; Pull request updated; Plane work item updated; GitHub issue updated; Comment updated; Commit status updated; Sync write failed; Sync write retry scheduled; Sync write; GitHub installation is not approved; GitHub installation access removed; GitHub App unavailable; Service account attribution; Account matched by email; Plane webhook has stopped arriving; Merge readiness could not be checked; Build checks are incomplete; Development link updated; Missing work item reported; Automation rule matched; Automation action; Work item reference not found; Concurrent mirror update; Mirrored work item creation failed; Mirrored work item created; Existing references linked; Webhook replay requested; Smart Commit action completed; Work item creation requested by pull request; Pull request ready to merge; Related pull requests could not be checked; Older deployment update skipped; Deployment status updated

## My GitHub account (Connect.tsx)

- My GitHub account
- Needs re-authorization. Reconnect your GitHub account to author changes as yourself. Changes use the service account until you connect.
- Connect your personal GitHub account to author synced changes as yourself. Changes use the service account until you connect.
- GitHub account: <login>
- No personal GitHub account connected.
- The instance admin must configure the GitHub App OAuth credentials.
- Connect personal account
- Reconnect
- Disconnect personal account
- Disconnect your GitHub account? Synced writes will use the service account until you reconnect.
- My GitHub account settings
- Personal account settings need workspace membership.

### Callback notices (Connect.tsx connectionNotice)

- Your personal GitHub account is connected.  (`?github=linked`)
- GitHub is connected to this workspace.  (`?connect=ok`)
- The account owner has connected GitHub to this workspace. You can close this page; the workspace admin can refresh the connection.  (`?connect=ok&via=handoff`)
- Repository access updated and mappings rechecked.  (`?connect=updated`)
- The organization owner must complete GitHub authorization using the handoff link. Then refresh this workspace's connection.  (`?connect=handoff`)
- The owner handoff could not be completed. <reason text>  (`via=handoff` errors)
- internal: The connection could not be completed. Try again; ask an instance admin to check the service if it keeps failing.
- state: This connection link has expired, was already used, or belongs to another Plane account. Start again.
- denied: GitHub authorization was declined. You can connect again when ready.
- exchange: GitHub authorization could not be completed. Start again.
- already_linked: This GitHub account is already linked to another member in this workspace.
- not_yours: Your GitHub account cannot access that installation. Choose an installation you can access, or ask its organization owner to connect it.
- not_owner: Only an active GitHub organization owner or admin can connect its installation. Ask an organization owner to connect it using a handoff link. A personal installation must be connected by its account owner.
- wrong_account: This handoff link was issued for a different GitHub organization. Use the link for the organization you want to connect.
- unsupported_account: This kind of GitHub account is not supported. Choose an organization or personal account installation.
- taken: That installation is connected to another workspace.
- not_configured: Ask the instance admin to configure the GitHub App client ID, client secret and App slug.
- installation: GitHub did not return a valid installation. Start again and choose the intended organization or personal account.
- github: GitHub could not complete the connection. Check your account access and try again.

## Workspace GitHub connection (Connect.tsx)

- Workspace GitHub connection
- Refresh connection
- Connecting an organization needs a workspace admin.
- Ask the instance admin to configure the GitHub App client ID, client secret and App slug.
- GitHub installation
- <Account type> · installation <id>
- Manage repository access on GitHub
- Disconnect
- Disconnect <login>? Its mappings will be disabled.
- Connect GitHub
- Send a link to an organization owner
- Which GitHub organization should the owner connect? Enter its login.
- Pending organization approval
- <org> — requested by <login>. Waiting for an owner to approve.
- Send owner handoff link
- Connect your personal GitHub account to finish connecting an installation.
- Reconnect your personal GitHub account to finish connecting an installation.
- <account> — connected | — connected to another workspace | — available
- Finish connecting
- Ask an organization owner to connect it
- Send a link to an organization owner  (dialog heading)
- Ask an organization owner or admin to install or approve the App, then complete GitHub authorization using this link. They can connect it without a Plane account. Afterwards, refresh this workspace's connection.
- Installation link
- Copy link
- Copied
- Copy failed. Select the link above and copy it.
- Expires <time>
- Close

## Development panel (DevPanel.tsx)

- You cannot see this work item.
- Development
- PRs: OPEN | PRs: MERGED | PRs: DECLINED
- Pull requests
- Builds
- Deployments
- Previews
- Branches
- Start work
- No GitHub repository is mapped to this project.
- Branch name for <owner/repo>  (aria-label)
- Copy branch name
- Create branch
- Creating…
- Copied
- Copy failed; select the name and copy it
- Branch created
- Branch already exists
- Server errors shown: The repository is empty; push a first commit before creating branches / The GitHub App cannot create branches in this repository (it needs Contents: write) / The mapping's branch template does not give a valid branch name
- Link text formats: `[PR] #<n> <title> · OPEN · REVIEW|APPROVAL|REJECTED`, `[PR] #<n> <title> · MERGED`, `[PR] … · DECLINED`, `[Branch] <name>`, `[CI] …`, `[Deploy] …`, `[Preview] …`

## God mode — instance settings (Admin.tsx)

- Git sync: instance settings
- Settings
- Instance audit
- The instance settings need a Plane instance-admin session.

### Connection health
- Connection health
- GitHub App credentials cannot be decrypted. Save the App secrets again.
- Database — reachable | unreachable
- GitHub App — configured | not configured
- Repository mappings — <n> | Unknown
- Last sync activity
- Failures in the last 24 hours

### Setup checks (Admin.tsx + setup-check.ts)
- Setup checks
- Check setup again
- Checked <time>
- <title>: Verified | Needs attention | Not verified — <detail>
- Titles: App credentials; App permissions; App webhook events; Signed GitHub deliveries; Plane deliveries; Plane request rate
- Details include: "Required App registration permissions match. Verify installation approval after any permission change."; "Subscribe the App to the missing webhook events."; "Required webhook subscriptions match."; "A verified transport delivery was processed or durably spooled."; "No verified transport delivery is recorded yet. Make an issue or PR change to verify the webhook."; "The client limit matches config. Confirm Plane API_KEY_RATE_LIMIT separately: Plane v1.4.2 does not expose the total limit in API response headers."; "Read the App credentials first."

### GitHub App
- GitHub App
- A GitHub App is configured. Leave the secrets empty to keep the stored ones.
- No GitHub App is configured yet.
- App ID
- Private key (PEM)
- Stored encrypted; it is never shown again.
- Webhook secret
- App slug
- Used for the Connect GitHub installation link.
- OAuth client ID
- OAuth client secret
- Configured. Leave empty to keep the secret.
- Required for personal account authorization.
- GitHub edition
- GitHub.com
- Enterprise Cloud with data residency
- Enterprise Server
- Enterprise Cloud subdomain
- The enterprise name before .ghe.com.
- Enterprise Server URL
- Save GitHub App

### Installations
- Workspace GitHub App installations
- Allow-list GitHub App installations per workspace. A repository can only be mapped if its installation is allow-listed for that workspace.
- No installations allow-listed yet.
- Workspace | Installation ID | Account / Org | Allow-listed at
- Loading workspace…
- Workspace unavailable
- Remove
- Remove allow-list entry for installation <id>?
- Reload workspaces
- Allow-list an installation
- Installation ID
- Numeric GitHub App installation ID.
- Workspace
- Workspace allowed to use this installation.
- Account / Org (optional)
- GitHub org or user name for display.
- Allow-list installation

### Disabled mappings
- Disabled repository mappings
- Unresolved mappings and mappings whose installation is no longer allowed are disabled. Allow-list the installation for its workspace, then have a workspace admin save the mapping to verify it.
- Refresh mappings
- No disabled mappings.
- Workspace | Repository | Project | Installation | Reason
- Unresolved
- Save the mapping to verify its installation
- Installation is not allowed for this workspace
- Reload workspace names
- Some project names could not be loaded.
- Reload project names

### Manual mapping recovery
- Manual mapping recovery
- Instance admins can map a repository by ID when personal GitHub authorization is unavailable. The App installation and Plane project are still verified.
- Workspace
- Plane project
- GitHub repository
- GitHub repository ID
- Add manual mapping

### Magic words
- Magic words
- One word or phrase per line. A word may belong to only one tier.
- Closing words
- Non-closing words
- Relation phrases
- Save magic words

### Defaults
- Defaults
- Enable Smart Commits for newly mapped repositories
- Require signed commits for Smart Commits
- Only commits GitHub marks as verified can run Smart Commit commands when enabled.
- Reconciliation interval (minutes)
- How often missed webhooks are reconciled.
- Echo-suppression TTL (minutes)
- How long an applied operation is remembered to stop sync loops.
- Save defaults

## Texts git-sync posts on GitHub / Plane (server)

- Linked Plane work item:\n- WEB-42: <url>  /  Linked Plane work items: … (`src/app/pr.ts:400-405`)
- Linked to Plane work item: <url> (`src/sync/mirror.ts:524-526`)
- Mirrored from GitHub issue <owner/repo#n>. (`mirror.ts:518-519`)
- Mirrored to GitHub issue <owner/repo#n>. (`mirror.ts:781`)
- ---\nMirrored from Plane: <url> (issue body footer, `mirror.ts:766`)
- **<login>** commented on GitHub: (`mirror.ts:378-379`)
- **<Name>** commented in Plane: (`mirror.ts:660`)
- Time logged: <raw> (<n> minutes) + via <sha7> by <login> (`smart-commits.ts:574`)
- Time logged: <duration> (rule action, `pr-automation.ts:530`)
- Git sync could not complete this action: (problem report heading, `src/github/problems.ts:65,84`)
- <KEY> does not match a work item in the linked Plane workspace, so this pull request is not linked to it. (`pr.ts:286`)
- This commit is not signature-verified; Smart Commit commands were ignored.
- This push was incomplete; some Smart Commit commands may not have been processed.
- <KEY>: #<token> matches several Plane states. / <KEY>: #<token> matches no Plane state.
- <KEYS>: #time needs a duration such as 1h 30m. / <KEYS>: a Smart Commit command is malformed.
- Unknown work item <KEY>.
- Some Smart Commit commands could not be applied. Check the sync audit log with a linked workspace member.
- Additional failures are recorded in the sync audit log.
- The linked Plane work item can no longer be found, so this link has been marked orphaned. Nothing was changed or closed here. (`src/app/main.ts:264`)
