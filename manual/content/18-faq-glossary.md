# 18 · FAQ and glossary

Short answers to the questions new developers ask most. Each answer points to the chapter with the details. If your workspace behaves differently, your admin's mapping and rules are the reason. Use Chapter 17 to collect evidence.

## Getting started

*Do I need to learn all of Plane on day one?*
No. Learn to find your assigned items (**Your work**), open one, read it, change its state and comment. Then connect your GitHub account (Chapter 8) and follow the daily loop (Chapter 15). Cycles, modules and pages can wait.

**What is the difference between a workspace and a project?**
A workspace (here **Acme**, slug `acme`) holds people and projects. A project (here **Website**) holds work items and gives them their prefix: `WEB-42` is item 42 of the project with identifier `WEB`.

*Which of the "four connections" do I set up myself?*
Only the last one: your personal GitHub account. The App, the workspace connection and the repository mappings are set up by admins (Chapter 8).

**Where do I find the git-sync settings? I can't see GitHub Sync in workspace settings.**
That menu is for workspace admins. Members use the direct page `/git-sync/ui/workspaces/<slug>/account` (**My GitHub account**). The Development panel appears in every work item for everyone.

## Your GitHub account

*Why connect my GitHub account if the repository already syncs?*
It tells git-sync which Plane member you are on GitHub. With the link, your Smart Commits say "by &lt;your login&gt;", your GitHub assignments and @mentions become Plane assignments and mentions, and changes git-sync makes on GitHub for your Plane edits are made as you. Without it, git-sync uses the App's identity.

*Will my Plane comments from Smart Commits show my name as the author?*
No. In this release every Plane-side change is made by the git-sync service account. Smart Commit comments name you in their "via &lt;sha&gt; by &lt;login&gt;" line.

*Does connecting give git-sync access to my private repositories?*
No. Repository access comes only from the GitHub App installation that your organization approved. Your personal link adds identity, not access.

*What does "Needs re-authorization" mean?*
GitHub refused the stored token: you revoked it, it expired, or the App was changed. Press **Reconnect**. Until you do, git-sync uses the App's identity for you.

*Is Disconnect safe?*
**Disconnect personal account** removes only your link and revokes your token. The team's sync keeps working. It also stops git-sync from re-linking you automatically by email. The organization card's **Disconnect** is a different, admin-only button that disables mappings.

## Linking code

*Where must the key appear for the PR to link?*
In the branch name, the PR title or the PR body. Commit messages never create a PR link; they only run Smart Commits.

*Why is `WEB-42` in my branch name treated as "closes"?*
A bare key in the branch name (any case) or in the PR title (uppercase) is a **closing** reference. A bare uppercase key in the body is only a relation. Magic words set the tier explicitly (Chapters 9–10).

*I wrote `Refs WEB-42` but the merge still moved the item to Done. Why?*
The strongest tier wins. A key in the branch name or title made it closing. For partial work, keep the key out of both.

*Can I unlink a PR by removing the key or adding `skip`?*
No. `skip WEB-42` (in the PR body) only prevents a *new* link. An existing link stays. Ask your admin.

*Can one PR close two items?*
Yes: `Closes WEB-42, WEB-45` (or `and`, `&`). Each item is checked separately at merge.

*Can one item have several PRs?*
Yes. The item moves to Done only when at least one linked PR has merged and none is still open. This is called the merge guard (Chapter 14).

*What is `WEB-NEW`?*
Put `WEB-NEW` in a PR title or body and git-sync creates a new item in project `WEB`, titled after the PR, already In Progress and linked to the PR.

*Does GitHub itself understand `WEB-42`?*
No. `WEB-42` is a Plane key that git-sync reads. GitHub's own `Closes #123` refers to GitHub issues. You can use both in one PR body.

## Smart Commits

*When do Smart Commit commands run?*
When the commit is **pushed** to the mapped repository, and only if the mapping has **Smart Commits** turned on.

*Where does `#time` go?*
Into a Plane comment, "Time logged: 1h 30m (90 minutes)". Plane CE has no worklog. `1d` = 8h and `1w` = 5d.

*Why did my commands run twice?*
You rebased or amended a pushed commit. The new SHA counts as a new commit. Each SHA runs once.

*Why does `#in` fail?*
It matches both In Progress and In Review. Use `#in-progress` or `#in-review`.

*Does the God mode setting "Require signed commits" protect us?*
Not in this release. The setting is stored but not enforced. Enforcement is the server setting `REQUIRE_VERIFIED_COMMITS=true` (Chapter 11).

## Automation and the Development panel

*Why didn't approval move my item?*
The shipped rules change nothing on approval or ready for merge. Merging into `main` moves it to Done.

*What do `OPEN · REVIEW`, `REJECTED` and `APPROVAL` mean?*
`OPEN` is the PR state. `REVIEW` means no decisive review yet. `REJECTED` means a reviewer currently requests changes. `APPROVAL` means approved with no standing change request. They are PR badges, not Plane states.

*Does MERGED mean deployed?*
No. Check **Deployments** and your release process.

*Why does Create branch not show my branch locally?*
It creates the branch on GitHub only. Run `git fetch origin` and `git switch <branch>`.

*Why is there no list of commits in the panel?*
The panel shows PRs, builds, deployments, previews and branches. A commits list is not part of this release.

## Mirrored issues

*Will every GitHub issue appear in Plane?*
No. Only issues with the `plane` label, and only in mapped repositories.

*Why did my Plane title edit not reach GitHub?*
By default GitHub owns the title and description. Edit them on GitHub.

*Why did a merge close the Plane item but not its GitHub issue?*
git-sync's own changes in Plane are not mirrored back. Add `Closes #N` to the PR so GitHub closes the issue.

*What happens if I delete a mirrored Plane item?*
Nothing is closed. Within about an hour, reconciliation marks the link orphaned and comments on the GitHub issue.

*Are priority, due dates, estimates or cycles synced?*
No. Only title, description, state, assignees, labels and new comments.

## Trust and timing

*How fast is sync?*
Usually seconds, but nothing is guaranteed: queues, rate limits and outages add delay. Wait, then report.

*Can sync loop forever between Plane and GitHub?*
No. git-sync remembers what it wrote and ignores the echo. It also ignores Plane events from its own service account.

*Can I fix a missing link by recreating the item?*
Do not. You would get a duplicate, and the original event is still in the audit log. Report it so an admin can **Replay** the delivery.

## Glossary

Plain definitions of the terms used in this manual. Terms in **bold** are exact UI labels.

| Term | Definition |
|---|---|
| Plane | The self-hosted project-management tool (Community Edition v1.4.2) where the team plans and tracks work. |
| Community Edition (CE) | The free, self-hosted edition of Plane. It has no built-in GitHub integration; git-sync adds one. |
| git-sync | The service in this repository. It runs beside Plane as one extra container and keeps Plane and GitHub in step. |
| Workspace | The top-level Plane space for a team or company (for example `acme`). Members, projects and settings live in it. |
| Workspace slug | The short name of a workspace used in URLs, such as `acme`. |
| Project | A group of work items inside a workspace, with its own identifier (for example **Website**, identifier **WEB**). |
| Project identifier | The letters before the number in a work-item key (`WEB` in `WEB-42`). 2–12 characters, starting with a letter. |
| Work item | One task, bug or story in Plane (Plane's name for an issue). |
| Work-item key | The project identifier plus a number, such as `WEB-42`. git-sync finds these keys in branch names, PRs and commits. |
| State | Where a work item is in the workflow, such as Todo, In Progress, In Review or Done. |
| State group | The fixed category a state belongs to: Backlog, Unstarted (shown as "Not started"), Started, Completed, Cancelled, or Triage. Rules can target a group. |
| Triage | The state group used by Intake for unreviewed requests. git-sync never moves an item into triage. |
| Cycle | A time-boxed planning period (a sprint) that collects work items. Not synced. |
| Module | A feature-sized group of work items. Not synced. |
| Page | A Plane document (notes, specs, agreements). Not synced. |
| View | A saved set of filters and display options. Not synced. |
| Intake | The project inbox for requests that are triaged before they become regular work. |
| Estimate | A size value (for example Points 1, 2, 3, 5, 8, 13). Not synced. |
| God mode | Plane's instance-admin area at `/god-mode/`. git-sync's instance settings appear there under **GitHub Sync**. |
| Instance admin | The person who administers the whole Plane installation (God mode). Configures the GitHub App, magic words and defaults. |
| Workspace admin | A Plane workspace member with the Admin role. Connects GitHub, maps repositories, edits rules and user links. |
| Member | An ordinary workspace member. Can use the Development panel and **My GitHub account**, but cannot open **GitHub Sync** in workspace settings. |
| Service account (bot) | The Plane user git-sync acts as, using its Plane personal access token. Plane-side changes made by git-sync appear under this account. |
| Personal access token (PAT) | A Plane API key. The bot's PAT is set at install time; it is separate from any GitHub authorization. |
| GitHub App | The application registered on GitHub that gives git-sync permission to read and write repositories and receive webhooks. |
| Installation | The GitHub App installed on one GitHub organization or user account. One installation can be connected to only one Plane workspace. |
| Allow-list | The instance admin's list that permits an installation to be used by a workspace (**Allow-list an installation**). |
| Owner handoff link | A single-use link a workspace admin sends to a GitHub organization owner so the owner can approve and connect the installation. |
| Repository mapping | The link between one GitHub repository and one Plane project, created with **Add mapping**. |
| Sync direction | A mapping setting: **Two-way**, or **GitHub to Plane only** (Plane changes are never written to GitHub). |
| Personal GitHub link | Your Plane account linked to your GitHub account through **Connect personal account**. Identified by GitHub's stable numeric user id. |
| OAuth | The standard sign-in-with-GitHub flow used by **Connect personal account**. git-sync never sees your GitHub password. |
| Re-authorization | Connecting your GitHub account again (**Reconnect**) after the stored authorization stopped working. |
| User link | The record that pairs a Plane member with a GitHub account. Created by the member (OAuth), by an admin (**Link a user**) or automatically by a unique public email match. |
| Tombstone | A record left when a link is removed, so automatic email matching does not link the same account again. |
| Reference | A work-item key found in a branch name, PR title, PR body or commit message. |
| Magic word | A word or phrase before a key that sets the reference's tier, such as `Closes`, `Refs` or `Relates to`. Instance admins can edit the list. |
| Tier | How strong a reference is: closing, non-closing or relation. The strongest one found wins. |
| Closing reference | A reference that may move the item to its merged state (Done) when the PR merges. Bare keys in branch names and PR titles are closing. |
| Non-closing reference | A reference that links and can change state on PR events, but never on merge (`Refs WEB-42`). |
| Relation reference | A reference that only links; it never changes state (`Relates to WEB-42`, or a bare key in a PR body). |
| `skip` / `ignore` | A PR-body phrase (`skip WEB-42`) that stops one key from being linked by that PR. It does not remove an existing link. |
| `WEB-NEW` | A marker in a PR title or body that asks git-sync to create a new work item in project WEB and link it. |
| Merge guard | The rule that a closing item moves on merge only when at least one linked PR merged and none is still open. |
| Smart Commit | A commit-message command such as `WEB-42 #comment …`, `#time 30m` or `#in-review`, run when the commit is pushed. |
| Provenance | The "via &lt;commit&gt; by &lt;login&gt;" line git-sync adds to Smart Commit comments so readers can see their source. |
| Signed (verified) commit | A commit GitHub marks as signature-verified. Smart Commits can be limited to these with `REQUIRE_VERIFIED_COMMITS`. |
| Development panel | The **Development** box in a work item's sidebar showing linked PRs, builds, deployments, previews, branches and **Start work**. |
| Rollup link | A categorized Plane link (`[PR]`, `[Branch]`, `[CI]`, `[Deploy]`, `[Preview]`) that git-sync creates and updates in place. |
| Branch template | The pattern for suggested branch names, `{key}-{title-slug}` by default. Not editable in the UI in this release. |
| Issue mirroring | Opt-in two-way copying between a GitHub issue and a Plane work item, started by the `plane` or `github` label. |
| Gate label | The label that opts an item into mirroring: `plane` on a GitHub issue, `github` on a Plane work item. |
| Conflict policy | Per field, which side wins when both changed: **Last write wins**, **GitHub is the source of truth**, **Plane is the source of truth**. |
| Linkback comment | A comment git-sync posts on GitHub with the Plane link when a link is created (**Post link-back comments on GitHub**). |
| Problem report | A GitHub/Plane comment starting "Git sync could not complete this action:" posted when **Report problems as comments on GitHub and Plane** is on. |
| Rule | A YAML instruction: **when** a trigger happens, **if** conditions match, **then** run actions. The first matching rule wins. |
| Lifecycle point | A named PR or branch moment (Branch pushed, PR opened, Review requested, PR merged …) used in the rules table. |
| Trigger | The event name a rule listens for, such as `pull_request.merged` or `branch.created`. |
| Ready for merge | A lifecycle point reached when a PR is open, not a draft, approved, has no standing change request and all checks pass. |
| Branch-aware rule | A rule limited to a base-branch regex, such as "merged into `^staging$` → In QA". |
| Dry run | **Test rules**: running a delivery or trigger through the rules without writing anything. |
| Backfill | Linking a newly mapped repository's existing open PRs and issues to the work items they mention. |
| Webhook | An HTTP message one system sends another when something changes. GitHub and Plane both send webhooks to git-sync. |
| Delivery | One received webhook, recorded in the audit log and replayable. |
| Replay | Running a recorded delivery again (**Replay**), which may write to Plane and GitHub. |
| Echo suppression | Ignoring the webhook git-sync caused itself, so a change does not bounce back and forth. |
| Reconciliation | A periodic sweep (default every 60 minutes) that detects missed changes and deleted or archived Plane items. |
| Orphaned link | A link whose Plane work item no longer exists. git-sync comments on GitHub but never closes anything. |
| Audit log | The list of everything git-sync received and did, with outcome and raw detail. |
| Sync health | Per-mapping timestamps and error counts shown on the Repositories tab. |
| Setup checks | God-mode checks of App credentials, permissions, events, deliveries and the Plane request rate. |
| `git-sync.internal` | The Docker network name Plane uses to send its webhooks to git-sync. |

## What you learned

- Members set up only their personal GitHub link. Everything else is admin work.
- Keys in branch names and titles close items, the strongest tier wins, and `skip` never unlinks.
- `#time` is a comment, commands run once per SHA, and signed-commit enforcement is the server variable `REQUIRE_VERIFIED_COMMITS`.
- Only six fields mirror, and git-sync's own Plane changes are not mirrored back.

## Source files

- `manual/notes/glossary.md`: glossary source
- `src/parse/references.ts`, `src/github/smart-commits.ts`, `src/sync/mirror.ts`, `src/github/pr-automation.ts`: behavior behind the answers
