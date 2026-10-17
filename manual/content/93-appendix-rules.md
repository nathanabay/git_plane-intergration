# Appendix D · Rule reference: triggers, conditions, actions

Each mapping has a list of rules, stored as YAML in versions. Every event is checked against the list from the top. **The first rule whose trigger and conditions match is the only one that runs.** If no rule matches, nothing happens.

The **Rules** tab writes this YAML for you: its lifecycle table and branch-aware rules compile to it. You can also edit the YAML directly in **Rules (YAML)**. The `yaml` and `example` blocks in this appendix were checked with the real parser (`parseRules` in `src/rules/engine.ts`).

```yaml
- name: Merged into staging moves to QA     # optional, shown in the audit log
  when: pull_request.merged                 # one trigger, or a list of triggers
  if:                                       # optional; every condition must hold
    base_branch: "^staging$"
  then:                                     # one or more actions, run in order
    - set_state: started:In QA
```

## Shipped defaults

A new mapping uses the lifecycle table below until an admin saves something else.

| Lifecycle point | Trigger | Plane state |
|---|---|---|
| Branch pushed | `branch.created` | `started:In Progress` |
| Draft PR opened | `pull_request.drafted` | `started:In Progress` |
| PR opened / ready for review | `pull_request.opened` | `started:In Progress` |
| Review requested | `pull_request.review_requested` | `started:In Review` |
| Merged (base branch matches `^main$`) | `pull_request.merged` | `completed:Done` |
| Changes requested, approved, ready for merge, closed without merge, reopened | — | no change |

## Triggers

| Trigger | When it fires | Which work items it acts on |
|---|---|---|
| `pull_request.drafted` | A PR is opened as a draft or converted to draft | Items linked to the PR |
| `pull_request.opened` | A PR is opened, or a draft is marked ready for review | Items linked to the PR |
| `pull_request.review_requested` | A reviewer is requested | Items linked to the PR |
| `pull_request.changes_requested` | A review asks for changes | Items linked to the PR |
| `pull_request.approved` | A review approves, but the PR is not yet ready for merge | Items linked to the PR |
| `pull_request.ready_for_merge` | The PR is open and not a draft, has at least one standing approval and no standing change request, and all checks and statuses passed. Fires once per head commit. | Items linked to the PR |
| `pull_request.merged` | The PR is merged | Items linked to the PR (merge guard applies) |
| `pull_request.closed_unmerged` | The PR is closed without merging | Items linked to the PR |
| `pull_request.reopened` | The PR is reopened | Items linked to the PR |
| `pull_request.*` | Any of the above | — |
| `branch.created` | The first push of a new branch (not the default branch, not a `revert-…` branch) | Keys in the branch name; finished or cancelled items are never moved back |
| `push` | Any push | Keys in the branch name and commit messages |
| `commit.pushed_to_default` | A push to the repository's default branch | Keys in the commit messages |
| `check_suite.<conclusion>`, e.g. `check_suite.success`, `check_suite.failure` | A check suite completes; `check_suite.*` matches all | Items linked to the PR of the checked commit |
| `deployment_status.<state>`, e.g. `deployment_status.success` | A deployment status is reported; `deployment_status.*` matches all | Items linked to the PR of the deployed commit |
| `issue.<action>`, e.g. `issue.closed`, `issue.labeled` | An event on a mirrored issue (GitHub or Plane) | The mirrored work item |
| `comment.<action>`, e.g. `comment.created` | A comment on a mirrored issue or linked PR | The mirrored or linked work item |

## Conditions (`if:`)

| Key | Value | Matches when |
|---|---|---|
| `base_branch` | regular expression | The PR's target branch matches, for example `^main$` or `^release/` |
| `head_branch` | regular expression | The source branch matches, for example `^hotfix/` |
| `labels_any` | list of label names | The GitHub object has at least one of the labels |
| `labels_all` | list of label names | It has all of the labels |
| `author` | login or list | The GitHub user who caused the event (case-insensitive) |
| `repo` | `owner/name` or list | The repository (case-insensitive) |
| `project` | Plane project ID or list | The work item's project (exact) |

An event that has no value for a condition, such as a push with no base branch, does not match a rule that needs it.

## Actions (`then:`)

| Action | Example | Effect in Plane |
|---|---|---|
| `set_state` | `set_state: started:In Review` | Moves the item. The target is `group:Name`, a group alone (`completed`), or a state name. If the name is missing but the group has exactly one state, that state is used. |
| `add_label` / `remove_label` | `add_label: needs-qa` | Adds or removes a project label; a missing label is created |
| `assign` | `assign: sam-reviews` | Assigns the Plane member linked to that GitHub login |
| `comment` | `comment: "Deployed to {{deployment.environment}}"` | Adds a comment |
| `add_link` | `add_link: {url: "{{deployment.url}}", title: Staging}` | Adds a link |
| `log_time` | `log_time: 30m` | Adds the comment `Time logged: 30m` (Plane CE has no time tracking) |
| `create_issue` | `create_issue: {project: WEB, title: "Follow up {{issue.title}}"}` | Creates one new item in that project (ID or identifier only) |

Text values can use `{{…}}` placeholders from the event:

- `deployment.environment` and `deployment.url` for deployment triggers.
- `issue.number`, `issue.title` and `issue.url` for `issue.*` and `comment.*` triggers.
- `comment.body` and `comment.url` for `comment.*` triggers.

If a placeholder is missing, the rule fails and the failure is written to the audit log.

## Tier gating

How strongly a work item is linked limits **only** `set_state`:

- **Relation** links never change state.
- **Non-closing** links (`Refs WEB-41`) change state on every trigger except `pull_request.merged`.
- **Closing** links change state on merge only when at least one linked PR merged and **no** linked PR is still open. A PR that cannot be read counts as open. This merge guard is checked only at the moment of the merge.

All other actions run for every tier.

## Examples

Branch-aware delivery (staging first, then main):

```yaml
- name: Merged into staging moves to QA
  when: pull_request.merged
  if: {base_branch: "^staging$"}
  then: [{set_state: "started:In QA"}]
- name: Merged into main is done
  when: pull_request.merged
  if: {base_branch: "^main$"}
  then: [{set_state: "completed:Done"}]
```

Note a failing build and a deployment on the work item:

```yaml
- when: check_suite.failure
  then: [{add_label: build-failing}, {comment: "CI failed on this work item's pull request."}]
- when: deployment_status.success
  if: {head_branch: "^release/"}
  then: [{add_link: {url: "{{deployment.url}}", title: "Release candidate"}}]
```

Hotfixes skip review:

```yaml
- when: [pull_request.opened, pull_request.drafted]
  if: {head_branch: "^hotfix/", labels_any: [urgent]}
  then: [{set_state: "started:In Review"}, {assign: jordan-acme}]
```

> **Note:** Saving YAML replaces the whole list, including the defaults. Copy the default rules you still want into your YAML, or build the rules with the lifecycle table, which compiles them for you.

## Source files

- `src/rules/engine.ts`, `src/rules/types.ts`
- `src/github/pr-automation.ts` (defaults, lifecycle compiler, executor, ready-for-merge)
- `src/app/rules.ts`, `src/app/rule-events.ts`
- `src/ui/dry-run.ts` (**Test rules**)
