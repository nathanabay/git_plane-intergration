# 10 · Magic words and Smart Commits

Magic words describe a code change's relationship to a task. Smart Commits request an immediate action on a task when a commit is pushed. Both put useful intent next to the code, but they run through different paths. A sentence saying `Closes WEB-42` does not behave like the command `WEB-42 #done`.

A **magic word** qualifies an identifier: “this finishes it,” “this contributes to it,” or “this is related context.” A **Smart Commit** contains a hash command, such as `#comment`, on a line that also names its target work item. Magic words support the PR lifecycle; Smart Commits can add comments, record a textual time note, and select a Plane workflow state at push time.

## Default magic-word reference

Administrators can replace any of the three instance-wide word lists. The following is the exact shipped vocabulary in `src/parse/magicWords.ts`. Capitalization does not matter for phrases or the identifier immediately following them.

| Tier | All default phrases | Meaning |
|---|---|---|
| Closing | `close`, `closes`, `closed`, `closing` | Permit completion automation |
| Closing | `fix`, `fixes`, `fixed`, `fixing` | Permit completion automation |
| Closing | `resolve`, `resolves`, `resolved`, `resolving` | Permit completion automation |
| Closing | `complete`, `completes`, `completed`, `completing` | Permit completion automation |
| Closing | `implement`, `implements`, `implemented`, `implementing` | Permit completion automation |
| Non-closing | `ref`, `refs`, `references` | Contribute without merge-state automation |
| Non-closing | `part of`, `contributes to`, `toward`, `towards` | Contribute without merge-state automation |
| Relation | `relates to`, `related to` | Link context without automatic state changes for that reference |

Multiword phrases allow whitespace between their words. The parser prefers the stronger tier if the same configured phrase appears in more than one list. A phrase must be a separate token: letters, digits, or underscores immediately alongside it can prevent a match. A colon is allowed after the phrase, followed by whitespace before the key.

| Example supplied to the parser | Default interpretation |
|---|---|
| `Fixes WEB-42` | Closing |
| `FIXES web-42` | Closing, normalized to `WEB-42` |
| `Completing: WEB-42` | Closing |
| `Part of WEB-42` | Non-closing |
| `Contributes to WEB-42 and API-9` | Non-closing for both |
| `Related to WEB-42, WEB-43` | Relation for both |
| `Closes:WEB-42` | Phrase does not match; a bare key can still match |
| `Refs (WEB-42)` | Phrase does not reach the key; bare-key rules apply |
| `unfixes WEB-42` | `fixes` is not a separate word; bare-key rules apply |
| `See WEB-42` in a PR body | Bare relation; `see` is not a default magic word |
| `Addresses WEB-42` in a PR title | Bare closing key; `addresses` is not a default magic word |

The last two examples matter because unrecognized wording does not automatically mean “ignored.” A valid bare key remains meaningful. In a PR title a bare uppercase key is closing; in a body or commit message it is a relation. A branch key is closing regardless of letter case. Always inspect all occurrences when the outcome seems stronger than intended.

> **Example:** A PR titled `Refs WEB-42` on branch `login-layout-part-one` can remain non-closing. The same title on branch `web-42-login-layout` has a closing reference because the branch contributes the stronger tier.

## What a magic word actually changes

The word establishes the reference tier. The configured rule set supplies the action. A closing reference may let an opened PR move the item to In Progress and a merged PR move it to Done. It does not require those exact state names, and it does not close the item merely because the body was saved.

At merge, closing references still obey the all-linked-PR condition: at least one linked PR must have merged and none can remain open. Closed unmerged PRs neither block nor satisfy the merge requirement. Non-closing references skip merge-state changes. Relation references skip automatic state changes. The current executor gates the `set_state` action this way; configured comments, labels, assignments, links, and time-note actions can still run. An event-level create-item action is also separate. Development links can still show the PR for all three tiers.

For two items on one PR, you can state different intentions on separate lines:

```text
Closes WEB-42
Refs WEB-43
Relates to API-9
```

This allows WEB-42 to participate in merge completion, WEB-43 to represent continuing work, and API-9 to provide context. Before saving, ensure the head branch and title do not independently contain a closing occurrence for the partial or related items.

## Smart Commit command reference

Smart Commits are enabled per repository mapping. An administrator can require signature-verified commits. If either policy prevents execution, valid syntax alone will not perform an action. These commands are evaluated from pushed commit messages; typing them into a PR body or a Plane comment does not invoke the Smart Commit processor.

| Command | Example | Plane effect |
|---|---|---|
| `#comment` | `WEB-42 #comment Added redirect tests` | Adds a plain-text comment with commit provenance |
| `#time` | `WEB-42 #time 1h 30m` | Adds a time-note comment; no CE worklog entry |
| A workflow-state token | `WEB-42 #in-review` | Requests the matching state in that item's project |
| Several commands | `WEB-42 #in-review #time 30m #comment Ready for review` | State change, time-note comment, and text comment |
| Several keys | `WEB-42 API-9 #comment Shared client updated` | Applies the comment to each recognized target |

A command starts with `#` at the beginning of a line or after whitespace. Its name begins with a letter and can contain letters, digits, underscores, hyphens, or apostrophes. The reserved commands `comment` and `time` are case-insensitive. Other names are interpreted as workflow-state tokens, not as an unlimited library of git-sync commands.

The general shape of a useful line is:

```text
Optional text WEB-42 optional text #command arguments
```

The target keys must appear **before the first command on the same line**. Text before and between them can be ordinary prose. Keys inside the comment text do not become extra targets. Bare keys should use uppercase prefixes; an explicit magic phrase can recognize a lowercase key through the shared reference parser, but uppercase keys are clearer for everyday commands.

## Write and push a Smart Commit

1. Confirm the intended work-item identifier in Plane.
2. Make your code changes on the appropriate branch.
3. Stage the intended files.
4. Create a commit with the command on a line naming the target.
5. Push the commit to the mapped repository.
6. Open the Plane item's activity or comments.
7. Check the expected result.

For example:

```bash
git add src/login.ts
git commit -m "Handle expired login sessions" \
  -m "WEB-42 #in-review #time 45m #comment Ready for review"
git push
```

`src/login.ts` is an illustrative path; stage the real file you changed. The first `-m` supplies the subject and the second supplies a body paragraph. There is no requirement that commands appear in the subject. A separate line in the body is often easier to read and review.

Do not select Done merely to show that one commit is finished. A Smart Commit transition can move an item at push time, before review or merge. If the team closes work only after merge, use a comment or a suitable intermediate state in the commit and a closing reference on the PR.

## One line is one command context

A command does not span lines. Every line that performs an action must include its own key before the first hash command. This message has two valid independent command lines:

```text
Improve the checkout flow

WEB-42 #in-progress #comment Started redirect handling
API-9 #comment Client needs the new error shape
```

This message does not carry the key down to the second line:

```text
WEB-42
#comment Started redirect handling
```

The second line has no key before its first command, so it supplies no Smart Commit entry. Similarly, `#comment WEB-42 added tests` has no target key before its first command. Move the key to the front.

`#comment` consumes the rest of its line. That lets a comment contain issue numbers or text resembling commands without unexpectedly executing them:

```text
WEB-42 #comment We discussed #done but need another review
```

The comment text includes `#done`; no Done transition is requested. If you want a transition, write it before `#comment`. A command-looking token before `#comment` is treated as a command, so keep ordinary hashtags inside the comment section.

## Choose an exact workflow-state token

States belong to individual Plane projects. `#done` works only if the target project's states resolve that token. There is no global promise that every project calls its completion state Done. The resolver checks three levels in order, stopping at the first level containing matches:

| Matching level | Example |
|---|---|
| Full state name, lowercase, spaces replaced with hyphens | `In Review` matches `#in-review` |
| Same comparison ignoring hyphens and apostrophes | `Won't Do` can match `#wontdo` |
| Prefix ending at a hyphen-separated word boundary | `#in` can match `In Review` only when it is the sole match at that level |

If one level yields several states, the token is ambiguous and is refused. The resolver does not guess the first item in the state list. For a project containing both In Progress and In Review, `#in` is ambiguous. `#in-review` names the intended state. If the project has a state named In and another named In Review, the exact In match wins before prefix matching is attempted.

Names are case-insensitive after normalization. `#IN-REVIEW` and `#in-review` resolve the same way. Use hyphens for spaces: `#in review` supplies token `in` with trailing text, not the two-word state name. Automation cannot move items into the triage state group. Triage is intake, so an administrator must choose an ordinary workflow destination.

A multi-key line resolves each key against its own project's workflow. `WEB-42 API-9 #in-review` can succeed for WEB-42 and fail for API-9 if only the WEB project has that state. Partial success is possible. Check every target instead of assuming one successful comment proves the entire line worked.

## Record time accurately

Plane Community Edition has no worklog API for git-sync to call here. `#time` creates a comment reading **Time logged:** with the supplied duration and its computed minute count. It does not update an estimate, cycle capacity, billed hours, or a dedicated time-tracking report.

| Duration | Conversion used by git-sync |
|---|---|
| `1m` | 1 minute |
| `1h` | 60 minutes |
| `1d` | 8 hours, or 480 minutes |
| `1w` | 5 working days, or 2,400 minutes |
| `1.5h` | 90 minutes |
| `1w 2d 4h 30m` | 3,630 minutes |
| `0.5m` | Rounded to 1 minute |

Units are `w`, `d`, `h`, and `m`, case-insensitively. Decimal numbers are accepted and the total is rounded to minutes. Mixed units can be separated by whitespace. Colon notation such as `1:30`, a negative duration, or words such as `two hours` are not the documented duration form.

The command accepts a leading sequence of duration parts. In `#time 1h 30m investigated redirects`, the recognized time is `1h 30m`; the trailing words do not become a separate free-text comment. Add `#comment investigated redirects` when that explanation should be posted. Several `#time` commands on one line are combined into that line's time note.

Time notes are additive comments. Repeating a duration in a new commit records another note, rather than replacing the old one. To correct a mistake, leave a clear corrective comment according to team practice; do not assume editing git history edits a previous Plane note.

## More worked examples

| Commit message line | Expected result when enabled and authorized |
|---|---|
| `WEB-42 #comment Added a regression test` | One text comment |
| `WEB-42 #time 20m #comment Investigated redirect loop` | Time note and separate text comment |
| `WEB-42 #in-review #comment Ready for Sam` | State transition followed by comment |
| `WEB-42 WEB-43 #time 30m` | A 30-minute note on each item; it is not divided between them |
| `WEB-42 #time 15m #time 20m` | One 35-minute time note for that line |
| `WEB-42 #done #comment Fixed today` | Immediate Done request, then comment |
| `WEB-42 #comment Looks good #time 1h` | One literal comment including `#time 1h` |
| `WEB-42 #time` | Malformed time command is reported |
| `WEB-42 #comment` | Missing comment text is reported |
| `WEB-42 #assign alex-dev` | Attempts to resolve state token `assign`; no built-in assignment command |
| `WEB-42 #close` | Attempts a state named or matching `close`; it is not the magic phrase `Closes` |
| `WEB-42 #in-review` in a PR body | Ordinary PR text; does not invoke Smart Commits |

Malformed commands are not an all-or-nothing transaction. Other valid commands and other valid targets can still complete. A missing state is recorded as a failure, while a valid comment later in the same entry can still be applied. Permanent failures and network retries are treated differently so temporary outages do not require you to create duplicate commits.

## Attribution, signatures, and repetition

The authenticated GitHub webhook `sender` determines the actor. The processor does not trust the commit author, committer, or pusher metadata as permission proof. Changing `git config user.email` or using `git commit --author` cannot make a Smart Commit act with another person's Plane permissions.

Bots, GitHub's ghost account, and unmapped accounts use service attribution. A recognized user without a stored Plane PAT also falls back to the service identity. This explains why a correctly parsed command may be visible under a service user even after you connected your personal GitHub account.

The administrator may enable **Require signed commits for Smart Commits**. In that case the integration checks GitHub's `verification.verified` result and ignores commands in commits that do not pass. The author line in `git log` is not that verification result. If GitHub cannot be reached to check verification, the operation is retried rather than assuming the commit is verified.

Commands are guarded by commit SHA within the workspace. Pushing the same SHA again, including through another branch or fork, does not repeat completed commands. A retry resumes unfinished steps. A rebase, amend, cherry-pick, or squash can produce a different SHA; a new SHA can execute commands again. Remove or deliberately review old commands when rewriting a message. “Already pushed once” is not a reliable guard after history changes.

If the repository's **Report problems** setting is enabled, failed Smart Commits can receive a commit comment explaining the problem, and known work items can receive a Plane notice. The setting defaults off, so absence of a public warning does not establish success. Give an administrator the commit URL, target keys, expected action, and visible result; they can inspect the audit log without needing your tokens.

Implementation references: `src/parse/magicWords.ts`, `src/parse/references.ts`, `src/github/smart-commits.ts`, `src/app/push.ts`, `src/auth/identity.ts`, and `src/github/problems.ts`.
