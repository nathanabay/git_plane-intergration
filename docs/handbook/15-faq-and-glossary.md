# 15. FAQ and glossary

These answers bring together the daily decisions a developer makes while using Plane and GitHub. They describe the current integration and distinguish software behavior from team policy. If your workspace behaves differently, start with its configured mappings and rules, then use chapter 14 to collect evidence.

## 15.1 Getting started

**Do I have to understand every Plane feature on my first day?**

No. Start by finding your assigned project, opening a work item, reading its description and comments, and understanding its current state. Connect your personal GitHub account before relying on personal attribution. Then follow the daily loop in chapter 12. Cycles, modules, views and pages become useful as you join planning and handover conversations. Learn the team's actual practices before reorganizing shared work.

**What is the difference between a workspace and a project?**

A workspace groups people and projects. A project groups related work and gives its items an identifier prefix, such as `WEB`. The item `WEB-42` is sequence 42 in that project. Check the workspace and project when a familiar-looking title appears twice. Workspace membership and project access are related but separate access decisions; you may need an invitation or a project administrator's help.

**Which system should I open first each morning?**

A useful suggested habit is to check Plane for priorities, mentions and blockers, then GitHub for requested reviews and the status of your open PRs. Your team may choose another order. Plane gives planning context; GitHub gives code context. Neither automatically replaces the conversations and decisions that make work ready to start.

**Can I use a saved view as the team's source of truth?**

A view presents a filtered selection of work. It can hide items because of its filters, grouping or sub-work-item setting. If an item disappears, search for its identifier and check the view configuration before assuming it was deleted. Shared views are helpful for common planning routines, but changing shared filters can affect what teammates see.

## 15.2 Accounts and permissions

**Why connect my personal GitHub account when the repository already syncs?**

The repository installation permits the service to access selected repository data. Your personal connection links your GitHub identity to your Plane membership and supports writing eligible changes as you. The settings UI explains that eligible changes use service identity until you connect. A missing personal connection is therefore different from a broken repository mapping.

**Does connecting grant access to every private repository I can see?**

No. Installation access and project mappings decide which repository the integration uses. Your own GitHub access does not expand an installation's permissions automatically. Ask the workspace administrator or organization owner if an expected repository is missing. Do not request broader access than your work requires.

**Can I disconnect without breaking everyone's sync?**

The personal control is **Disconnect personal account**. It removes your personal connection; the UI warns that synced writes will use service identity until you reconnect. Workspace installation controls have a wider effect and can disable mappings. Check the label carefully and use the personal account page for a personal disconnect.

**Why is a change credited to the service account?**

The sender may be unlinked, a bot, a deleted-user identity, or missing a usable credential. Some integration-created records intentionally use service identity. The authenticated webhook sender determines Smart Commit attribution, not the forgeable author or committer fields in a git commit. Reconnecting helps eligible future personal actions; it does not rewrite historical attribution.

## 15.3 Linking and completion

**Do I need the key in the branch, commit and PR?**

A valid reference in an applicable scanned source can be enough. Repeating the key thoughtfully improves readability, but it also creates opportunities for conflicting intent. For PR linkage, the handler scans the branch, title and body. Under the defaults, a bare branch key is closing, a bare uppercase PR title key is closing, and a bare body key is relation-only. Explicit configured magic words assign a tier. The parser keeps the strongest tier it finds for each identifier. Commit messages are processed separately on push for Smart Commits and applicable push rules; do not rely on a commit message alone to establish the PR link.

**Why did `Refs WEB-42` still allow completion?**

Look for a stronger source. Branch `web-42-fix`, title `WEB-42 Fix layout`, or a closing phrase in another scanned source can make the final tier closing. A non-closing phrase does not veto a closing one. For a partial contribution, omit the key from the branch and use explicit non-closing wording in the PR title and body. A branch such as `refs/web-42/layout` still has a bare closing key. Verify the intended links before merge. Existing stored links persist even if the text is later removed or suppressed with `skip`; ask an administrator about an association established in error.

**Is `Closes WEB-42` the same as `#done`?**

No. `Closes WEB-42` is a reference classified for PR lifecycle automation. A qualifying merge can complete the work item under the applicable rules. `WEB-42 #done` is a Smart Commit state command interpreted when the commit is processed from a push, assuming `Done` resolves to a state. It can change the work item before code review or merge.

**Does GitHub understand Plane keys itself?**

The integration reads the Plane identifier. GitHub issue numbers use their own repository context. A Plane work item and a GitHub issue can be mirrored, but that is a separate opt-in relationship. Do not assume a native GitHub closing expression and a Plane closing expression refer to the same record.

**What happens if one PR addresses two items?**

Use an explicit phrase such as `Closes WEB-42, WEB-45` if the PR really finishes both. The parser supports multiple identifiers after one magic word. Each work item's other linked PRs still matter. Verify both records after merge because one can remain open while the other completes.

**What happens if one item needs two PRs?**

The completion check requires at least one merged linked PR and no open linked PRs. A closed, unmerged PR neither establishes completion nor blocks a merge transition. The service treats a PR it cannot read as open rather than guessing it is finished. Use non-closing references for contributions when merge must not mean the entire item is complete.

**Will a parent item close when all its children close?**

Do not rely on git-sync to provide a child-to-parent completion rule. It evaluates the linked work items and PRs described in its reference and lifecycle logic. Parent/sub-work-item planning in Plane does not automatically create a PR reference for the parent. Follow the team's explicit parent acceptance and completion process.

**Does reverting a PR reopen the work item?**

There is no dedicated inverse operation that undoes the old PR's state, comments or time records. A revert is new code and new events. Review generated revert text because copied keys and closing phrases can still be recognized. Reopen the old item deliberately when appropriate, or track the corrective work with a new item and explain the relationship.

## 15.4 Comments, time and issue mirroring

**Where does `#time` go?**

It becomes a Plane comment containing the duration and calculated minutes, with provenance. The CE integration does not write a native worklog. Duration units are weeks, days, hours and minutes; a day is eight hours and a week is five days. Decimals are supported. Agree with the team before treating these comments as reportable time records.

**Can a command span two commit-message lines?**

No. Each parsed line needs its identifiers before the first command on that same line. Put `WEB-42` again on a new line that contains another command. A `#comment` takes the rest of its line as text. Put it after state and time commands to avoid accidentally turning commands into prose.

**If a push failed halfway through, should I make another commit with the commands?**

First inspect the actual result and ask an administrator about pending steps. The integration records completed steps and can retry transient failures without repeating completed actions for the same commit identity. A new commit has a new SHA and can repeat effects. This is especially relevant for time comments and messages that were already written successfully.

**Will every GitHub issue become a Plane work item?**

No. The ordinary mirror uses opt-in labels: `plane` on the GitHub issue or `github` on the Plane work item. The mapping and allowed direction still govern creation. A PR reference is not the same as a mirrored issue pair. Check for an existing partner before creating a manual duplicate.

**Will an edited comment update on both sides?**

The mirror handles newly created comments. It is not a shared live document that synchronizes comment edits or deletions. Add a clear correction when both audiences need the new information. Markdown and Plane's rich text are converted representations; complicated formatting may not survive identically, even when the meaning remains readable.

**Why is a label, assignee or state different on each side?**

Your administrator can configure direction and field policy. Identity mapping also affects which assignees can be represented. Some labels are integration opt-in controls rather than normal mirrored categorization. Read the team's policy before editing both systems to force agreement; competing edits can obscure the real ownership decision.

## 15.5 Trusting what you see

**Does `MERGED` mean the feature is live?**

It means the PR merged. A deployment and a release are later or separate events in many teams. Development can also show deployment or preview links when reported data is available. Check the intended environment and team release process before telling a user a fix is live.

**Why can the panel show `OPEN · APPROVAL` while the item is In Review?**

The first labels describe the PR and its review summary. In Review is a Plane work item state chosen by rules or people. Approval has no shipping transition to Done. A team can configure different rules, but the displayed labels are still distinct concepts.

**How long should synchronization take?**

This handbook does not promise a fixed number of seconds. Delivery, queue load, API limits and retries affect timing. Check once after allowing processing time. If a result stays missing, collect the identifier, URL, action time, expected behavior and actual behavior. An administrator can tell whether the event is missing, waiting, rejected or intentionally ignored.

**Why are some bot edits ignored?**

The service filters its own Plane service-user events and recognized echoes to prevent endless copying. That is expected. It does not mean every action by every GitHub bot is discarded. Applicable bot actions can run under service identity. Ask about the specific event rather than relying only on the displayed account name.

**Can I fix a missing link by deleting and recreating the item?**

That usually loses context and can create duplicates. First verify the key, mapping, permissions and event. Deletion is a separate lifecycle with reconciliation limits. Preserve the original evidence while an administrator investigates. Recreate only after the team understands what happened and has decided which record should remain authoritative.

## 15.6 Glossary

| Term | Meaning in this handbook |
|---|---|
| Acceptance criteria | Concrete checks that show the requested outcome has been delivered. |
| Activity history | The record of changes and discussion associated with a work item. |
| Administrator | A person authorized to manage workspace, project or instance configuration; the scope matters. |
| Assignee | A person responsible for moving a work item forward. |
| Base branch | The branch a PR proposes to merge into, such as `main`. |
| Blocking relation | A statement that one work item depends on another outcome first. |
| Branch | A named line of development in git. A local branch reaches GitHub only after a push or remote creation. |
| Build | A reported automated check or collection of checks; its scope depends on the repository. |
| Closing reference | A link tier eligible for merge completion, subject to rules and all linked PRs. |
| Commit | A recorded git change with a message and an identifying SHA. |
| Cycle | A planning period used to organize a time-bounded set of project work. |
| Deployment | An event placing a version in an environment; it is separate from merging code. |
| Development panel | Work-item view of linked PRs, branches and available build, deployment and preview information. |
| Direction | The configured allowance for changes to travel from GitHub, Plane or both. |
| Draft | Saved incomplete work; a Plane draft and a GitHub draft PR are different kinds of record. |
| Echo | An event produced when the service's own write is reported back by the other system. |
| Field policy | A per-field decision about which changes the integration may apply. |
| Gate label | An opt-in label used to request ordinary issue mirroring: `plane` on GitHub or `github` in Plane. |
| GitHub App | The installed integration identity with repository permissions granted by its owner. |
| Identifier | A project's prefix and work-item sequence, such as `WEB-42`. |
| Intake | A place to receive and triage incoming work before normal project handling. |
| Linkback | A cross-link or comment that helps a reader reach the related record; it can be configured. |
| Magic word | Configurable prose such as `Closes` or `Refs` that classifies a following reference. |
| Mapping | The configuration joining a Plane project and a GitHub repository with sync policy. |
| Mention | A reference to a person in discussion, often used to bring a question to their attention. |
| Mirror pair | An opted-in GitHub issue and Plane work item whose allowed fields synchronize. |
| Module | A planning container for a related body of work within a project. |
| Non-closing reference | A contribution link that can take part in earlier lifecycle changes but does not complete on merge. |
| Orphan | A link whose partner has been confirmed missing by the integration's reconciliation process. |
| Personal connection | Your linked GitHub account and associated authorization for attribution. |
| Preview | A reported review environment link, often temporary; it is not a production release guarantee. |
| Priority | The relative urgency assigned to a work item. |
| Project | A grouping of related work with its own identifier prefix, members and workflow settings. |
| Pull request / PR | A proposal to review and merge changes from one branch into another. |
| Push | Sending local git commits and branch updates to a remote repository. |
| Queue | Durable pending work processed by the service after an event arrives. |
| Reconciliation | A background check that repairs or classifies differences missed by normal event handling. |
| Relation reference | A contextual link that does not make lifecycle state changes. |
| Review summary | The aggregate review label, such as REVIEW, APPROVAL or REJECTED, shown for an open PR. |
| Rule | A configured trigger, conditions and actions that describe automation behavior. |
| Saved view | A reusable way to filter and display work items; it does not create another copy of each item. |
| Service account | The integration's non-personal identity used for system writes or permitted fallback. |
| SHA | The git commit identifier used to distinguish recorded commit actions. |
| Smart Commit | A commit-message line containing work-item keys and commands interpreted from a push. |
| State | A named point in the project's workflow, such as In Review. |
| State group | A broader workflow category, such as started or completed, containing named states. |
| Sub-work item | A smaller work item connected to a parent to break down a larger outcome. |
| Subscription | Following a work item to stay informed about its activity. |
| Webhook | A signed event notification sent by one system to the integration. |
| Work item | The Plane record describing an outcome, its ownership, workflow and discussion. |
| Workspace | A shared Plane area containing members, projects and workspace-level settings. |

The source references for the integration vocabulary are `src/parse/magicWords.ts`, `src/parse/references.ts`, `src/github/smart-commits.ts`, `src/github/pr-automation.ts`, `src/sync/dev-info.ts` and `src/sync/mirror.ts`. The complete field and event reference is in chapter 11. Keep the printable page that follows nearby while you learn the daily flow.
