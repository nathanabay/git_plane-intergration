# Discrepancies: brief / existing docs vs code

Rule applied: **code wins**. Each entry gives the claim, where it was made, what the code does (file:line), and what the
manual must say. "Brief" = the catalogue in the manual brief; "HB" = `docs/handbook/`; "UG" = `docs/manual/user-guide.md`.

## D-01 — "Require signed commits for Smart Commits" (God mode) is not enforced  — **HIGH**

- **Claim:** Brief §F/§J and the God mode UI hint "Only commits GitHub marks as verified can run Smart Commit commands
  when enabled." (`src/ui/client/Admin.tsx:384-385`). HB10:60 says "An administrator can require signature-verified commits".
- **Code:** The checkbox saves `requireVerifiedCommits` → `instance_settings.require_verified_commits`
  (`src/ui/api.ts:985`, `src/db/parity.ts:267-272`). It is only **read back** for display (`src/ui/api.ts:313`,
  `readRequireVerifiedCommits` has no other caller). The push path passes the **environment variable** only:
  `src/app/push.ts:55` `requireVerified: ctx.config.REQUIRE_VERIFIED_COMMITS`. The env default is parsed at
  `src/config/env.ts:74` (`1|true|yes`). The setting's form value defaults to the env value when never saved
  (`src/db/parity.ts:259-265`), so the checkbox can *show* the env state but toggling it changes nothing at runtime.
- **Enforcement when on (env):** each commit is checked with `GET /repos/{o}/{r}/commits/{sha}` →
  `commit.verification.verified`; unverified commits are skipped and audited `smart_commit_rejected`; a GitHub/Plane
  notice "This commit is not signature-verified; Smart Commit commands were ignored." is posted when Report problems is on
  (`src/github/smart-commits.ts:407-421,304`).
- **Manual must say:** enforcement = `REQUIRE_VERIFIED_COMMITS=true` in `git-sync.env` + restart. The checkbox is stored
  but not applied by this release (limitation). UG already says this (MANUAL_NOTES line 190); HB10 wording should be tightened.

## D-02 — Menu name: "GitHub Sync" vs "Git Sync"

- Plane fork navigation always says **GitHub Sync**: workspace settings sidebar
  (`apps/web/core/components/settings/workspace/sidebar/item-categories.tsx:77`), page title
  (`apps/web/app/(all)/[workspaceSlug]/(settings)/settings/(workspace)/git-sync/page.tsx` `PageHead title="GitHub Sync"`),
  God mode sidebar (`apps/admin/app/(all)/(dashboard)/sidebar-menu.tsx:32` name "GitHub Sync", description "Manage GitHub synchronization.").
- The embedded git-sync pages say **Git sync: <slug>** (`Workspace.tsx:38`) and **Git sync: instance settings** (`Admin.tsx:23`); the health banner says "the Git sync webhook" (`health.tsx:23`).
- `install.sh:47` help text says "adds Git Sync to Plane's menus" and UG:373 says "Choose **Git Sync**; the patched navigation may label it **GitHub Sync**" — inaccurate: the menu label is always **GitHub Sync**.
- **Manual must say:** menu = **GitHub Sync**; page headings = **Git sync: …**.

## D-03 — `#time` posts a comment, not a worklog

- Brief and HB10:149 are correct. Exact comment: `Time logged: <raw> (<minutes> minutes)` followed by provenance
  `via <sha7> by <login>` (`smart-commits.ts:571-575,474-475`). Rule action `log_time` posts `Time logged: <duration>`
  without minutes or provenance (`pr-automation.ts:528-531`). No discrepancy except that the two formats differ.

## D-04 — `WEB-NEW` casing and scope

- Brief: "uppercase `NEW`". Code: regex `(${PROJECT})-NEW` without `i` flag, PROJECT allows any case
  (`references.ts:53-57`), so `web-NEW` works, `WEB-new` does not. Scanned in **title and body** only (not branch/commit).
  Runs on `opened`, `edited`, `reopened` (`pr.ts:350`). The doc comment at `pr.ts:109` says "in a PR body" — the parser also
  accepts the title. The created item's name is the PR title, state = the project's **started** group (`pr.ts:127-128`), link
  tier = closing. Deny-listed prefixes (e.g. `SHA-NEW`) are ignored. Unknown project → audit `pr_create_request` failed
  "no Plane project has the identifier …". HB09:136 is correct.

## D-05 — `skip` / `ignore` semantics

- Brief: "PR body only, one key each, doesn't remove an already stored link" — correct (`references.ts:58-63`, stored links
  reloaded at `pr.ts:341-349`). Extra precision: the phrase is case-insensitive and the skipped key is removed from the
  result for **every** source of that parse (branch, title, body), not just the body (`references.ts:101`).

## D-06 — PR handler does not scan the PR's commit history; commits never create PR links

- Brief §D lists "commit message (uppercase, relation)" among PR link sources. Code: the PR handler passes only branch,
  title and body (`pr.ts:318-322`). Commit messages are parsed only by push rules (`src/app/rules.ts:126-129`, triggers
  `push` / `commit.pushed_to_default`) and by Smart Commit key discovery (`smart-commits.ts:45-49`). A key only in commits
  produces **no** Development-panel PR link. HB09:55,60 is correct.

## D-07 — Attribution: Plane-side writes appear as the service account

- UI hint (`Connect.tsx:51-52`): "Connect your personal GitHub account to author synced changes as yourself." Brief §C:
  "fallback to service/App identity".
- Code: GitHub→Plane writes (Smart Commits, rule actions, mirrors) use a per-user **Plane PAT** from the vault if stored
  (`src/app/context.ts:109-122`, `smart-commits.ts:357-363`, `src/app/main.ts:171`), else the service account with audit
  `identity_fallback` reason `no_stored_token`. **No production code path stores a `plane_pat`** (only tests insert one;
  `grep "plane_pat" src` shows reads/deletes only). So in this release every Plane write is by the bot.
- Plane→GitHub mirror writes **do** run as the linked user when their GitHub token works (`asUser`,
  `src/sync/mirror.ts:617-626`, `src/sync/github.ts:103-110`); otherwise as the App.
- **Manual must say:** linking your GitHub account (a) attributes your Plane-originated mirror writes on GitHub to you,
  (b) lets git-sync recognise you as the actor (Smart Commit provenance "by <login>", assignee/mention translation,
  problem reports, repository picker). Plane-side changes still show the bot as the author.

## D-08 — Multi-PR merge guard

- Brief correct. Detail: other PRs are read live from GitHub at merge time; any read error counts as **open**
  (`pr.ts:30-47`). The guard is applied only to `set_state` on `pull_request.merged` for closing links
  (`pr-automation.ts:491-498`) and is **not re-evaluated** later (e.g. when the other PR is later closed unmerged).

## D-09 — Branch template placeholders / suggested branch link

- Brief correct: `{key}`, `{title-slug}`, `{username}`; default `{key}-{title-slug}` (`dev-info.ts:168-170`); `{username}`
  is the viewer's linked GitHub login, dropped with its separator when absent; title slug ≤ 50 characters (cut at a word boundary), branch ≤ 200 characters (`dev-info.ts:172-173`).
  No UI or API edits `branch_template` (`src/ui/api.ts:460,517` only patch open/closed/reportProblems).
- `upsertSuggestedBranchLink` (`[Branch] suggested: <name>`, `dev-info.ts:264-277`) has **no caller** — suggested branch
  links are never written in this release. The Development panel hides suggested branch links anyway (`DevPanel.tsx:79`).

## D-10 — Default conflict policies

- Brief correct: title & description `source_of_truth:github`; state, assignees, labels, comments `last_write_wins`
  (`src/ui/validate.ts:18-25`). UI labels: **Last write wins**, **GitHub is the source of truth**, **Plane is the source of truth**
  (`Workspace.tsx:231-235`). Direction **GitHub to Plane only** ignores every Plane-origin event, including the `github` gate
  label (`mirror.ts:19,640`).

## D-11 — Preview detection: Markdown "…Preview" links are not detected live

- Brief §E and HB09:162 say a Markdown link whose label ends in "Preview" is detected. `detectPreviews` supports it
  (`dev-info.ts:105-109`, case-insensitive), but its only caller passes deployment URLs, never a body
  (`src/app/checks.ts:308`). Live previews therefore come only from deployment statuses whose `environment_url` /
  `target_url` host ends in `.vercel.app`, `.netlify.app`, `.pages.dev` or `.amplifyapp.com`.

## D-12 — Audit log filters

- Brief §I: "Audit log: filters (mapping, errors only, hours)". Code: filters exist only as URL query parameters
  `?mappingId=<id>&errors=1&hours=<n>` (and `scope=all` for instance audit) (`router.ts:20-24`). There are no filter
  controls on the page; the filtered views are reached from the **Errors in the last 24 hours** / **Failures in the last 24 hours** links.

## D-13 — ready_for_merge

- Brief correct. Detail: computed from GitHub state (`isReadyForMerge`, `pr-automation.ts:185-235`): check suites with
  `latest_check_runs_count === 0` and `stale` are ignored; combined status `pending` with zero statuses counts as success;
  review states considered are APPROVED, CHANGES_REQUESTED, DISMISSED (latest per reviewer). Fired once per head SHA
  (`pr.ts:184-200`). It is reached from a review approval, a successful/neutral check suite, or a stage change
  (ready-for-review, reopened). There is **no default rule** for it — the shipped table leaves it empty.

## D-14 — Tier gating covers `set_state` only

- Brief correct. Precisely (`pr-automation.ts:491-498`): relation → never changes state (any trigger); non-closing →
  changes state on every trigger **except** `pull_request.merged`; closing → on merge only when the merge guard passes.
  Other actions (comment, labels, assign, link, log_time) run for every tier; `create_issue` runs once per event.

## D-15 — Deleting/archiving a Plane item

- Brief correct. Detail: reconciliation (default every 60 minutes) marks a deleted item's links **orphaned** and posts on
  GitHub "The linked Plane work item can no longer be found, so this link has been marked orphaned. Nothing was changed or
  closed here." (`src/app/main.ts:255-268`). Archived items/projects are recorded as archived, no comment
  (`src/sync/reconcile.ts:18-40`).

## D-16 — Assignee translation for unmapped users

- HB08:60 says "An unmapped GitHub login becomes a profile link instead" — true for **@mentions** in text. For **assignees**
  an unmapped GitHub account is simply dropped (`mirror.ts:448-462`); HB11:107 states this correctly.

## D-17 — "Sync health cards" contents

- Brief §I lists "**Member accounts**, **Disabled**" among health cards. **Member accounts** is a link in the **Set up GitHub
  sync** checklist (`health.tsx:33`), shown only when the workspace has no mappings. **Disabled** appears inside a mapping's
  health card only when the mapping is disabled (`health.tsx:8`). **Rate-limited until** appears only when set.

## D-18 — Mapping form field names

- Brief says "**Direction**". Field label is **Sync direction** (`Workspace.tsx:180`); the mappings table column is
  **Direction** with values "Two-way" / "GitHub to Plane" (`Workspace.tsx:78,84`). Repository field label is
  **GitHub repository**; save button is **Add mapping** (new) or **Save changes** (edit).
- Brief says rules section "**Lifecycle points → Plane state**" — correct as a heading; mode buttons are
  **Lifecycle mapping table** / **Raw YAML editor**; the regex field is **Merged base-branch regex**.

## D-19 — Magic words validation

- Brief: "one per line, one tier per word". Code also requires: lowercase letters and single spaces only, ≤ 40 characters,
  1–100 entries per tier, no tier empty (`src/ui/validate.ts:188-208`). A word listed in two tiers is rejected with
  `"<word>" is in both <tier> and <tier>`.

## D-20 — State target fallback in rules

- Not in brief. `started:In Review` resolves by name inside the group; if no such name exists but the group has exactly one
  state, that state is used; otherwise the rule fails "state … does not exist" (`pr-automation.ts:411-433`). Projects
  without an **In Review** state and with several started states will see the review-requested default fail (audited).

## D-21 — Branch created rule never reopens finished work

- `branch.created` set_state writes carry `skipTerminalState` (`pr-automation.ts:509-517`): pushing a new branch for a
  completed/cancelled item does not move it back.

## D-22 — Installer help text says "Git Sync"

- `install.sh:47`: "adds Git Sync to Plane's menus" — menus say **GitHub Sync** (see D-02).

## D-23 — Smart Commit state resolution "unique word-boundary prefix"

- Brief wording is right; precisely the token must equal the leading whole hyphen-separated words of the state name
  (`hyphenate(name).startsWith(token + "-")`, `smart-commits.ts:107`). `#in` → ambiguous between "In Progress" and
  "In Review"; `#prog` → not found.
