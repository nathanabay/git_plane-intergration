# 14. Troubleshooting

Most apparent sync failures come from one of four places: the identifier was not recognized, the repository or project is not mapped, policy does not allow the expected change, or an event has not finished processing. Start with the visible record and work outward. A work item does not need to be recreated just because a link or state update is delayed.

The following tables describe member-level checks first. Administrator checks are identified explicitly. They refer to this repository's implementation, especially `src/parse/references.ts`, `src/app/pr.ts`, `src/app/push.ts`, `src/github/smart-commits.ts`, `src/sync/mirror.ts`, `src/queue/workers.ts` and `src/ui/dev-panel.ts`. An administrator can use the [operations manual](../manual/user-guide.md) for setup and operational procedures.

> Tip: Separate three questions: “Is the code linked?”, “Did the event arrive?”, and “Was the requested change allowed?” A visible PR link can be correct even when the workflow intentionally leaves the work item state alone.

## 14.1 Check the identifier and the link

| Symptom | Likely cause | What to do |
|---|---|---|
| No PR appears on the work item | The key is absent, misspelled, suppressed, or unresolved | Copy the key from Plane; inspect the branch, title and body; check for `skip` or `ignore` in the body. |
| `web-42` in a prose paragraph does not link | Bare free-text references are uppercase-only | Use `WEB-42`, or an explicit configured magic phrase such as `Refs web-42`. |
| A branch ending `WEB-42_fix` does not link | An underscore immediately after the sequence violates the key boundary | Use a delimiter such as `web-42-fix`. |
| `X-1` does not link | Project identifiers in this parser need 2–12 characters | Ask the project administrator about a supported project identifier. |
| A key links the wrong work item | The number belongs to a different task or project | Compare the Plane identifier and title before correcting the PR text. |
| A valid-looking key remains unknown | The sequence does not exist or the service cannot see its project | Confirm you can open the item; ask an admin to check service membership and the unresolved-key audit entry. |
| A branch exists only on your laptop | No remote push has occurred | Push the intended branch to the mapped repository. |
| An old remote branch has no new branch link | Initial branch creation delivery was missing or occurred before mapping | Ask an admin to inspect that event; another ordinary push is not guaranteed to recreate the initial branch record. |
| Adding `skip` does not remove an old PR link | Existing stored links are retained | Ask an admin to inspect the association; `skip` controls new parsing, not unlinking. |
| The PR has no git-sync comment | Linkback is disabled or its write is pending | Check Plane Development first; ask an admin about linkback policy if that evidence is needed. |

The key parser checks boundaries to avoid treating part of a larger technical token as a work item. It accepts a letter followed by letters or digits for the project portion, with a hyphen and digits for the sequence. It normalizes recognized project letters to uppercase. Ordinary words such as `step-2` are not automatically Plane references in prose. Some technical prefixes, including `UTF` and `SHA`, are explicitly excluded by this implementation; an administrator should investigate unusual project naming instead of asking members to guess a workaround.

A work item that you can see may still be invisible to the integration's service account. Conversely, GitHub repository access does not prove Plane project access. A `403` or `404` during identifier resolution is reported as unknown rather than exposing inaccessible work. Share the key and repository with your administrator; do not change privacy settings as a troubleshooting experiment.

## 14.2 Check a state transition

| Symptom | Likely cause | What to do |
|---|---|---|
| PR is linked but opening it does not change state | The rule is disabled, customized, or uses a state missing from the project | Ask an admin to inspect the applicable lifecycle rule and target state. |
| A PR contribution completes an item unexpectedly | A bare branch/title key or another closing phrase won over `Refs` | Inspect every source of references; use explicit non-closing wording throughout future partial PRs. |
| Approval does not mark the item Done | Approval has no shipping state transition | Continue the team's merge process; verify the configured completion trigger. |
| Review request does not produce In Review | No review was requested, or policy/state names differ | Confirm a reviewer was requested on GitHub; check the team's configured review rule. |
| A merged PR leaves the item started | Base branch does not match, link is non-closing, or another linked PR is open | Check the merge base, reference tier, and every linked PR. |
| A merged PR on `develop` leaves the item started | Shipping merge rule matches `main` | Ask about the configured merge-base expression; do not assume every base branch completes work. |
| Closing a PR leaves the work item open | Closed without merge has no shipping state transition | Decide whether the work is abandoned, replaced or still needed; update Plane deliberately. |
| A revert does not reopen the old item | There is no automatic inverse of the old merge | Follow the team's reopen or corrective-item policy. |
| A relation link never changes state | `Relates to` is intentionally relation-only | Use the tier that matches the intended outcome, after checking all other reference sources. |

An open linked PR blocks the merge completion transition even when it is only a draft or belongs to another repository. An inaccessible linked PR is treated conservatively as open. This prevents the service from declaring work complete because it could not read part of the evidence. Ask the owner whether an obsolete PR should be closed; ask an administrator to investigate an inaccessible one.

The Development summary and the work item state are different signals. `PRs: OPEN` means at least one linked PR is open. A `MERGED` summary means there is a merged PR and no open PR in the displayed aggregate. It does not prove a particular Plane state rule ran or a production deployment completed. Compare the individual PR rows before diagnosing the aggregate label.

## 14.3 Check Smart Commits

| Symptom | Likely cause | What to do |
|---|---|---|
| Nothing happened after a local commit | Commands run after a push event | Push the branch when ready. |
| Pushed commands have no effect | Smart Commits are disabled, or signature policy rejected the commit | Ask the administrator about the mapping and verified-commit requirement. |
| The identifier is ignored on a command line | It appears after the first command or on another line | Put `WEB-42` before commands on the same line. |
| `#done` appears inside a Plane comment | `#comment` consumes everything after it | Put state and time commands before `#comment`. |
| `#review` fails | Several state names share the prefix, or none matches | Use the complete hyphenated state name, such as `#in-review`. |
| `#time` fails | It has no supported duration | Use a value such as `45m`, `1h 30m`, or `0.5d`. |
| Time appears only as a comment | CE has no worklog API used by this integration | Read the recorded minutes in the comment; do not expect a native timesheet. |
| Pushing the same commit again does not repeat the command | Completed commands are recorded by SHA and workspace | This is expected; ask about recovery if the original result was wrong. |
| Rebasing produced a second time comment | The rewritten commit has a new SHA | Avoid replaying operational commands in rewritten history; explain any duplicated record. |
| A state changed before PR merge | A pushed state command requested that transition | Review command timing; use PR lifecycle completion when that matches team policy. |

Commands are processed independently. A malformed time command does not prove that a valid comment or transition on the same commit was ignored. Read the actual result and any problem report before trying again. Retrying with a new SHA can duplicate actions that already succeeded. An administrator can distinguish a permanent rejected step from a transient failure awaiting retry in the audit log.

> Example: `WEB-42 #comment Tested locally #done` adds comment text containing `#done`. To request both actions, use `WEB-42 #done #comment Tested locally`. Only use a state token if that exact intended state exists in your project.

## 14.4 Check account and repository access

| Symptom | Likely cause | What to do |
|---|---|---|
| “No personal GitHub account connected” | Your workspace identity has not been linked | Open **My GitHub account** and use **Connect personal account**. |
| “Needs re-authorization” | Stored authorization can no longer be used | Use **Reconnect** and complete authorization with the intended GitHub account. |
| “Already linked” during connection | This GitHub account belongs to another Plane member in this workspace | Ask the workspace admin to resolve the identity link. |
| Connection link expired or was already used | Authorization state is single-use and time-limited | Start a fresh connection from the settings page. |
| Changes appear as a service account | No usable personal credential or identity mapping was available | Check your personal connection; ask about service fallback if it persists. |
| Private repository is absent | The App was not granted it, or the workspace mapping is unavailable | Ask the organization owner or workspace admin to check installation repository access. |
| You can read Development but cannot create a branch | Creating needs project member/admin role and a mapped repository | Ask the project admin about your role and mapping. |
| Development says no repository is mapped | No eligible mapping exists for this project | Ask a workspace admin to configure the project-to-repository mapping. |
| Development asks you to sign in | Your Plane session expired | Sign in to Plane again and reopen the work item. |

Your personal GitHub connection identifies you and supports attribution. The workspace installation gives the service repository access. These are separate pieces. Reconnecting your personal account does not grant the App access to a private repository. Disconnecting your personal account does not intentionally disconnect the whole team's repository integration; subsequent eligible writes can use the service identity.

The UI names above come from `src/ui/client/Connect.tsx`. Members should use personal account controls. Workspace installation disconnect controls disable mappings and affect the team; do not use them as a personal reset button.

## 14.5 Check mirrored issues, delays and echo suppression

| Symptom | Likely cause | What to do |
|---|---|---|
| GitHub issue creates no Plane work item | It was not opted in with `plane`, or no enabled repository mapping exists | Confirm the gate label and repository with the admin. |
| Plane item creates no GitHub issue | It lacks the `github` opt-in label, or direction prevents creation | Confirm your team's mirroring workflow before adding the label. |
| A field updates only in one direction | Direction or field policy restricts it | Ask which system owns that field. |
| A PR discussion comment does not mirror to Plane | Issue comment mirroring is for mirrored issue partners | Summarize the review outcome on the work item when needed. |
| Editing a mirrored comment does not update the copy | The mirror handles new comments, not edits/deletes as a shared document | Add a corrective follow-up where both audiences need it. |
| Bot-originated Plane edits do not trigger another round | Service-user writes and recognized echoes are suppressed | This is expected loop prevention; make the intended human edit in the owning system. |
| Sync is slow after a valid action | Queue backlog, API rate limit, or transient network failure | Allow processing time; ask an admin for queue/audit evidence if it persists. |
| An entire event is absent after an outage | GitHub did not successfully deliver it | Ask an admin to inspect webhook deliveries and redeliver the specific failed event. |
| A deleted item leaves a GitHub issue | Plane deletions do not provide the normal deletion webhook | Ask an admin about orphan reconciliation; do not recreate the item blindly. |

Echo suppression prevents an edit sent from Plane to GitHub from bouncing back as a fresh edit forever. The service remembers its own writes and consumes matching echoes. Plane events attributed to the configured service user are also ignored at ingress. This does not mean all GitHub bots are globally ignored: bot senders can use service identity for applicable actions. The distinction matters when diagnosing an automation account's work.

Internal queue retries and GitHub delivery are also different. Once accepted, transient internal failures can be retried. A webhook rejected before acceptance is not guaranteed to arrive again automatically; this repository explicitly documents operator redelivery for failed GitHub webhooks. Repeated browser reloads cannot supply a missing delivery.

## 14.6 Give an administrator a useful report

1. Copy the Plane work item identifier.
2. Copy the relevant GitHub PR or issue URL.
3. Record the commit SHA when a Smart Commit is involved.
4. Record the approximate action time and timezone.
5. Write the result you expected.
6. Write the result you observed.
7. Attach a screenshot with sensitive details removed.
8. Send the report through your team's support channel.

> Example: “WEB-42, PR #123, merged into main at about 14:20 Europe/Berlin. Development shows MERGED, but the item is still In Review. Another linked PR #121 is open. Should it still block completion?” This gives the administrator a specific policy question and usable evidence.

Do not send access tokens, browser cookies, webhook secrets or unfiltered configuration files. Administrators can investigate signatures, installation permissions, service membership, mapping rules, audit outcomes, queue state and reconciliation without your secret credentials. Tell them if you already tried a correction, especially a new commit or a manual state change, so the timeline stays understandable.
