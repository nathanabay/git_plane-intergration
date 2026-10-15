# Feature inventory — git-sync for Plane CE v1.4.2

Phase 1 output. Every git-sync row was checked against `src/` and `tests/` on branch `docs/user-manual`
(base commit `e0b3a58` + docs commits `c0da984`, `95cc855`). Section A (Plane basics) is verified by the handbook's
live captures on Plane CE v1.4.2 (`docs/handbook/HANDBOOK_NOTES.md`). Where the brief's catalogue differed from code,
the row states the code behaviour and the difference is logged in `discrepancies.md` (D-numbers).

Abbreviations: **HB** = `docs/handbook/NN-*.md`; **UG** = `docs/manual/user-guide.md` §N; **DG** = `docs/manual/developer-guide.md`.
"Existing screenshot" names a PNG in `docs/handbook/images/` (HB) or `docs/manual/images/` (UG); **GAP** = none exists.
Plane-side effects of git-sync are written by the service (bot) account unless noted (see D-07).

## A. Plane basics (Plane CE v1.4.2 — verified live by the handbook)

| Feature | Audience | UI location / route | Trigger | Effect in Plane | Effect in GitHub | Source | Tests | Existing doc section | Existing screenshot |
|---|---|---|---|---|---|---|---|---|---|
| Accept workspace invitation | Developer | `/onboarding/` | Invitation email/link | Joins workspace | — | Plane CE | — (live) | HB02 | HB 01-workspace-invitation.png |
| Sign in | Developer | `/` | Email → Continue → password | Session | — | Plane CE | — | HB02 | HB 02-sign-in.png |
| Profile (avatar, name, display name) | Developer | Avatar → Settings | Edit + **Save changes** | Profile updated | — | Plane CE | — | HB02 | HB 03-personal-menu.png, 04-profile.png |
| Preferences (theme, timezone, first day of week) | Developer | Settings → Preferences | Select | Display preferences | — | Plane CE | — | HB02 | HB 07-preferences.png |
| Email notification preferences | Developer | Settings → Notifications | Toggle | Email categories | — | Plane CE | — | HB07 | HB 08-notification-preferences.png |
| Workspace switcher | Developer | Sidebar top | Click | Switch workspace | — | Plane CE | — | HB03 | HB 09-workspace-switcher.png |
| Home (Quicklinks, Recents) | Developer | Sidebar **Home** | — | — | — | Plane CE | — | HB03 | HB 06-home.png |
| Your work (Assigned) | Developer | `/<slug>/profile/<userId>/assigned/` | — | — | — | Plane CE | — | HB03 | HB 10-your-work.png |
| Command palette | Developer | Ctrl/Cmd+K | — | Search / create | — | Plane CE | — | HB03 | HB 11-command-palette.png |
| Keyboard shortcuts | Developer | Shortcuts dialog | — | — | — | Plane CE | — | HB03 | HB 13-keyboard-shortcuts.png |
| Join a project | Developer | Projects → **Join Project** | Click | Project membership | — | Plane CE | — | HB02 | HB 05-join-project.png |
| Layouts: List, Board, Calendar, Spreadsheet, Gantt | Developer | Project work items | Layout buttons | View only | — | Plane CE | — | HB05 | HB 12, 14, 15, 16, 17 |
| Display options (properties, Group by, sub-work items, ordering) | Developer | **Display** | — | View only | — | Plane CE | — | HB05 | HB 25-display-options.png |
| Filters | Developer | Filter button | — | View only | — | Plane CE | — | HB05 | HB 26-filters.png |
| Create work item / quick add / Save to Drafts / Drafts | Developer | **Add work item**; inline; `/<slug>/drafts/` | — | Item / draft created | — | Plane CE | — | HB04 | HB 27, 28, 29, 30 |
| Title/description editor | Developer | Work item | — | Content | — | Plane CE | — | HB04 | HB 18, 23 |
| State, priority, assignees, labels, due date, estimates | Developer | Work item properties | — | Properties | — (only state/assignees/labels mirror for mirrored issues, §G) | Plane CE | — | HB04 | HB 19, 20, 31, 32, 44 |
| Attachments, **Add link** | Developer | Work item | — | Attachment/link | — | Plane CE | — | HB04 | HB 22, 33 |
| Relations (Relates to, Blocked by, Blocking, Duplicate of) | Developer | Work item → Add relation | — | Relation | — (never synced) | Plane CE | — | HB04 | HB 21, 54 |
| Sub-work items | Developer | Work item | — | Parent/child | — (never synced) | Plane CE | — | HB04 | HB 18 |
| Comments, mentions | Developer | Work item activity | **Comment** | Comment | Mirrored only on mirrored issues (§G) | Plane CE | — | HB04, HB07 | HB 24-comment-editor.png |
| Archive / delete menu | Developer | Work item menu | — | Archive / delete | Not a close (D-15) | Plane CE | — | HB04 | HB 34-item-actions.png |
| Cycles | Developer | Project → Cycles | — | — | — | Plane CE | — | HB06 | HB 36, 37 |
| Modules | Developer | Project → Modules | — | — | — | Plane CE | — | HB06 | HB 38, 39 |
| Pages | Developer | Project → Pages | — | — | — | Plane CE | — | HB06 | HB 40, 41 |
| Saved views | Developer | Project → Views | — | — | — | Plane CE | — | HB06 | HB 42 |
| Intake (triage) | Developer | Project → Intake | — | — | git-sync never moves items into triage | Plane CE; `src/sync/plane.ts` TriageWriteRejected | smart-commits tests | HB06 | HB 43 |
| Project States / state groups incl. In Review | Admin | Project settings → States | — | — | — | Plane CE | — | HB04/HB06 | HB 50-project-states.png |
| Project analytics | Developer | Project | — | — | — | Plane CE | — | HB06 | HB 51 |
| Inbox / notifications | Developer | `/<slug>/notifications/` | — | — | — | Plane CE | — | HB07 | HB 52-inbox.png |

## B. The four connections

| Feature | Audience | UI location / route | Trigger | Effect in Plane | Effect in GitHub | Source | Tests | Existing doc section | Existing screenshot |
|---|---|---|---|---|---|---|---|---|---|
| 1. GitHub App registered and entered in God mode | Instance admin | `/git-sync/ui/admin` → **GitHub App** | **Save GitHub App** | Credentials stored encrypted | App exists on GitHub | `src/ui/client/Admin.tsx:130-194`, `src/api/github-app.ts` | `tests/ui/instance.test.ts` | UG §10–11 | UG admin-github-app.png |
| 2. Installation connected to one workspace | Workspace admin | **Workspace GitHub connection** → **Connect GitHub** / **Finish connecting** | GitHub install + setup callback `/git-sync/install/github/callback` | `workspace_installations` row; one installation → one workspace (`taken`) | App installed on org/user | `src/ui/install-flow.ts`, `src/ui/client/Connect.tsx:145-182` | `tests/ui/parity2-g3.test.ts` | UG §12 | UG workspace-connection.png (empty state) |
| 3. Repository mapped to a Plane project | Workspace admin | **Map a repository** → **Add mapping** | Save | `repo_mappings` row | — | `src/ui/client/Workspace.tsx:114-197`, `src/ui/api.ts:466` | `tests/ui/workspace.test.ts` | UG §12 | UG workspace-mapping.png (unsaved form); **GAP** for saved mapping |
| 4. Member's personal GitHub link | Every member | **My GitHub account** `/git-sync/ui/workspaces/<slug>/account` | **Connect personal account** (OAuth) | `user_map` (stable numeric `gh_id`) + encrypted OAuth token | Grant on GitHub | `src/ui/client/Connect.tsx:46-75`, `src/ui/oauth-flow.ts` | `tests/ui/parity2-g3.test.ts`, `parity2-g5.test.ts` | HB08 | HB 53-personal-github.png (disconnected only) |
| Admin-created user link (no OAuth) | Workspace admin | **User links** → **Link a user** | **Link account** | `user_map` row | — | `src/ui/client/Workspace.tsx:613-704` | `tests/ui/workspace.test.ts` | UG §12 | **GAP** |
| Auto-link by public email | System | — | Push/PR from an unmapped sender whose public GitHub email matches exactly one member | `user_map` row; audit `identity_email_match` | — | `src/app/identity.ts:35-80` | `tests/queue/fixes-r1.test.ts`, `tests/ui/review-r5-ce.test.ts` | HB08 | — |

## C. Personal GitHub account page

| Feature | Audience | UI location / route | Trigger | Effect in Plane | Effect in GitHub | Source | Tests | Existing doc section | Existing screenshot |
|---|---|---|---|---|---|---|---|---|---|
| Page heading **My GitHub account** | Member | `/git-sync/ui/workspaces/<slug>/account` (also embedded on Repositories and User links tabs) | Open | — | — | `Connect.tsx:73` | parity2-g5 | HB08 | HB 53 |
| State: **No personal GitHub account connected.** + hint "Connect your personal GitHub account to author synced changes as yourself. Changes use the service account until you connect." | Member | same | — | — | — | `Connect.tsx:49-53` | parity2-g5 | HB08 | HB 53 |
| State: connected **GitHub account: <login>** | Member | same | — | — | — | `Connect.tsx:53` | parity2-g5 | HB08 | **GAP** |
| State: **Needs re-authorization. Reconnect your GitHub account to author changes as yourself.** | Member | same | Refresh failed / token rejected (`needs_reauth`) | — | — | `Connect.tsx:51`, `src/db/parity.ts:174` | parity2-g3 | HB08 | **GAP** |
| Buttons **Connect personal account** / **Reconnect** | Member | same | POST `/git-sync/api/workspaces/<slug>/github/account/connect` → GitHub authorize (PKCE) | — | OAuth grant | `Connect.tsx:55`, `oauth-flow.ts:64-67` | parity2-g3 | HB08 | HB 53 (Connect only) |
| OAuth callback `/git-sync/oauth/github/callback` | System | — | GitHub redirect | Link + token stored; tombstone cleared | — | `oauth-flow.ts:69-121` | parity2-g3 | HB08, UG §10 | — |
| Success notice **Your personal GitHub account is connected.** | Member | `…/account?github=linked` | — | — | — | `Connect.tsx:30` | parity2-g5 | HB08 | **GAP** |
| **Disconnect personal account** + confirm "Disconnect your GitHub account? Synced writes will use the service account until you reconnect." | Member | same | DELETE `…/github/account` | Link deleted; tombstone stops email re-matching; local GitHub token deleted | Grant revoked (best effort) | `Connect.tsx:56,68-71`, `oauth-flow.ts:166-205` | parity2-g3 | HB08 | **GAP** |
| Error notices (exact texts in `verified-strings.md`): `state`, `denied`, `exchange`, `already_linked`, `not_configured`, `internal`, `github` | Member | `…/account?github=error&reason=…` | Failed OAuth | — | — | `Connect.tsx:8-22`, `oauth-flow.ts:73-118` | parity2-g5 (connectionNotice) | HB08 (partly) | **GAP** |
| Membership required — "Personal account settings need workspace membership." (API: "Workspace membership is required", 403) | Member | same | Non-member | — | — | `Connect.tsx:74`, `oauth-flow.ts:60` | parity2-g3 | HB08 | **GAP** |
| OAuth not configured — "The instance admin must configure the GitHub App OAuth credentials." (button disabled) | Member | same | No client ID/secret | — | — | `Connect.tsx:54` | parity2-g5 | HB08 | **GAP** |
| What the link is used for | — | — | — | GitHub sender → Plane user (Smart Commit provenance, assignee/mention translation, problem-report gating) | Plane→GitHub mirror writes run **as the user** when their token works (`asUser`), else as the App | `src/sync/mirror.ts:617-626`, `src/sync/github.ts:103` | mirror tests | HB08 | — |
| Plane PAT is separate | — | — | — | GitHub→Plane writes use a stored per-user Plane PAT if one exists, else the service account. **No UI or API stores a per-user Plane PAT in this release** (D-07) | — | `src/app/context.ts:109-122`, `src/app/main.ts:171` loadActorToken | fixes-r2 | HB08 | — |
| Navigation wrinkle | Member | Plane **Workspace settings → GitHub Sync** is admin-only (`/settings/git-sync` access `[ADMIN]`); members use the direct `/account` URL | — | — | — | `packages/constants/src/settings/workspace.ts:69-70`, `apps/web/.../git-sync/page.tsx` | `scripts/verify-fork-patch.mjs` | HB08 | HB 53 |

## D. References (branches, PR titles/bodies, commits)

| Feature | Audience | UI location / route | Trigger | Effect in Plane | Effect in GitHub | Source | Tests | Existing doc section | Existing screenshot |
|---|---|---|---|---|---|---|---|---|---|
| Key format `PREFIX-123`: prefix = letter + 1–11 letters/digits (2–12 chars); digits; `WEB-0042` → `WEB-42`; not preceded by a letter/digit; not followed by letter/digit/underscore | Developer | Branch, PR, commit text | — | — | — | `src/parse/references.ts:12-14,24-30` | `tests/parse/references.test.ts` | HB09 | — |
| Deny-list prefixes UTF SHA ISO AES RSA CVE CWE RFC TLS SSL MD ES PEP USB HTTP IPV SSH GPT RS CRC UTC WIN | Developer | — | — | Ignored | — | `references.ts:18` | references.test | HB09 | — |
| Head branch: case-insensitive, bare key = **closing** | Developer | PR head ref | PR events; branch push | Link (tier closing) | — | `references.ts:79-81` | references.test | HB09 | HB 45-github-branches.png |
| PR title: uppercase bare key = **closing** | Developer | PR | PR events | Link | — | `references.ts:79-80` | references.test | HB09 | HB 46 |
| PR body: uppercase bare key = **relation** | Developer | PR | PR events | Link | — | `references.ts:79-80` | references.test | HB09 | HB 46 |
| Commit message: uppercase bare key = **relation** — used only by push rules (`push`, `commit.pushed_to_default`) and Smart Commit key discovery; **commits never create PR links** | Developer | Commit | push | Push-rule targets only | — | `src/app/rules.ts:126-129`, `smart-commits.ts:45-49` | rules tests | HB09 | HB 47 |
| Key after magic phrase: phrase case-insensitive, key case-insensitive, gets phrase's tier | Developer | any scanned text | — | — | — | `references.ts:42-48,64-74` | references.test, a8/grammar | HB10 | — |
| PR handler scans branch + title + body only (no PR commit history) | — | — | PR events | — | — | `src/app/pr.ts:318-322` | — | HB09:60 | — |
| Three tiers; strongest wins; tie-break branch > title > body > commit | Developer | — | — | Stored `sync_links.tier` | — | `references.ts:20-21,99-104`, `magicWords.ts:20-25` | references.test | HB09, HB10 | HB diagram-reference-tiers.svg |
| Default magic words (closing 20; non-closing 7; relation 2) | Developer | — | — | — | — | `src/parse/magicWords.ts:6-18` | references.test | HB10 | — |
| Multiple keys after one phrase: `,` `, and` ` and ` `&` or whitespace; optional colon; whitespace **required** after the colon (`Closes:WEB-42` fails) | Developer | — | — | — | — | `references.ts:42-48` | references.test | HB10 | — |
| `skip WEB-42` / `ignore WEB-42` — PR body only, case-insensitive, one key per phrase, suppresses that key from **all** sources of this parse; does not remove a stored link | Developer | PR body | PR events | — | — | `references.ts:58-63,101`; stored links `pr.ts:341-349` | references.test, review-r4-sc | HB09:130-132 | — |
| `WEB-NEW` in PR title or body — `NEW` uppercase, project part any case; on `opened`/`edited`/`reopened`; creates item titled with the PR title in a **started**-group state; closing link; idempotent per PR+project | Developer | PR | PR opened/edited/reopened | New work item + link | Linkback comment (if on) | `references.ts:53-57`, `pr.ts:109-168,350-354` | review-r4-sc, review-r6-cd, review-r7-ca | HB09:136 | **GAP** |
| Unknown key report — "WEB-99 does not match a work item in the linked Plane workspace, so this pull request is not linked to it." (only 404 keys, only for a linked sender, only when Report problems on) | Developer | PR comment | PR event | — | One edited-in-place PR comment | `pr.ts:268-288` | parity2-g1 | — | **GAP** |
| Multi-PR merge guard: ≥1 merged and none open; closed-unmerged neither blocks nor counts; unreadable other PR = open; evaluated only at that merge event | Developer | — | `pull_request.merged` | Closing item advances only if guard passes | — | `references.ts:107-109`, `pr.ts:30-47`, `pr-automation.ts:491-498` | references.test | HB10:46 | **GAP** |
| Linkback comment "Linked Plane work item(s): - WEB-42: <url>" once per new link | Developer | PR | First link | — | Comment by App | `pr.ts:400-405` | pr tests | HB09 | **GAP** |

## E. Branches and the Development panel

| Feature | Audience | UI location / route | Trigger | Effect in Plane | Effect in GitHub | Source | Tests | Existing doc section | Existing screenshot |
|---|---|---|---|---|---|---|---|---|---|
| **Development** iframe in work-item sidebar (24rem high, `allow="clipboard-write"`) | Developer | Work item sidebar | Open item | — | — | `apps/web/core/components/issues/issue-detail/sidebar.tsx:252-258` | verify-fork-patch | HB09 | UG plane-work-item.png |
| Direct route `/git-sync/ui/workspaces/<slug>/projects/<projectId>/work-items/<issueId>/development` | Developer | — | — | — | — | `DevPanel.tsx:1-21` | ui/client.test | HB09 | UG development-panel.png |
| Sections **Pull requests, Builds, Deployments, Previews, Branches, Start work**; empty hidden; heading shows `PRs: OPEN/MERGED/DECLINED` rollup | Developer | panel | — | — | — | `DevPanel.tsx:69-86` | parity2-g4 | HB09:144 | UG development-panel.png (historic, no mapping) |
| **No GitHub repository is mapped to this project.** | Developer | panel | No mapping | — | — | `DevPanel.tsx:82` | parity2-g4 | HB09 | UG development-panel.png |
| "You cannot see this work item." (403) | Developer | panel | No access | — | — | `DevPanel.tsx:68` | — | — | **GAP** |
| **Copy branch name** → "Copied" / "Copy failed; select the name and copy it" | Developer | Start work | Click | — | — | `DevPanel.tsx:34` | parity2-g4 | HB09 | **GAP** |
| Branch template `{key}-{title-slug}`; placeholders `{key}` `{title-slug}` `{username}` (viewer's linked GitHub login); no UI/API editor | Admin | DB column `repo_mappings.branch_template` only | — | — | — | `src/sync/dev-info.ts:165-215`, `src/db/parity.ts:221-246` | parity2-g4 | HB09 | — |
| **Create branch** → "Branch created" / "Branch already exists"; from default branch; requires project role ≥ Member (15); errors: "The repository is empty; push a first commit before creating branches", "The GitHub App cannot create branches in this repository (it needs Contents: write)" | Developer | Start work | Click | — | Remote branch created | `DevPanel.tsx:35-43`, `src/ui/dev-panel.ts:186,204-253` | parity2-g4 | HB09, HB12 | **GAP** |
| PR badge `OPEN` / `MERGED` / `DECLINED` | Developer | panel + `[PR]` link title `[PR] #12 Title · OPEN · REVIEW` | PR events | Link title updated in place | — | `dev-info.ts:13-56` | dev-info.test | HB09 | **GAP** |
| Review badge `REVIEW` / `APPROVAL` / `REJECTED` (open PRs only; latest decisive review per reviewer) | Developer | panel | Reviews | — | — | `dev-info.ts:30-44` | dev-info.test | HB09 | **GAP** |
| Build `pass` / `fail` / `pending` (success/neutral/skipped = pass; failure/timed_out/cancelled/action_required/startup_failure/stale = fail; none = pending) | Developer | **Builds** `[CI]` | check_suite / check_run / status | Link | — | `dev-info.ts:58-82`, `src/app/checks.ts` | dev-info.test | HB09 | **GAP** |
| Deployments `[Deploy]` | Developer | **Deployments** | deployment_status | Link | — | `src/app/checks.ts` | audit-g2 | HB09 | **GAP** |
| Preview detection — Vercel `.vercel.app`, Netlify `.netlify.app`, Cloudflare Pages `.pages.dev`, AWS Amplify `.amplifyapp.com` from deployment `environment_url`/`target_url`. Markdown "…Preview" label detection exists in code but is **not wired** (D-11) | Developer | **Previews** `[Preview]` | deployment_status | Link | — | `dev-info.ts:85-111`, `checks.ts:308` | dev-info.test | HB09:162 | **GAP** |
| Branch link `[Branch] <name>` on first push of a new branch containing a key | Developer | **Branches** | push (created) | Link | — | `src/app/push.ts:96-121` | — | HB09 | **GAP** |
| Native Plane link prefixes `[PR]`, `[Branch]`, `[CI]`, `[Deploy]`, `[Preview]`; no Commits list | Developer | Work item Links | — | — | — | `dev-info.ts:279-281` | dev-info.test | HB09:146, HB11:153 | UG plane-work-item.png |

## F. Smart Commits

| Feature | Audience | UI location / route | Trigger | Effect in Plane | Effect in GitHub | Source | Tests | Existing doc section | Existing screenshot |
|---|---|---|---|---|---|---|---|---|---|
| Per-mapping **Smart Commits** checkbox; new-mapping default from **Enable Smart Commits for newly mapped repositories** (instance default true) | Admin | Mapping form | — | — | — | `Workspace.tsx:185-186`, `src/ui/validate.ts:38` | workspace.test | HB10, UG §12 | UG workspace-mapping.png |
| Grammar: per line; keys only before first `#command` on that line; `#` must start the line or follow whitespace; command name starts with a letter | Developer | Commit message | push | — | — | `src/github/smart-commits.ts:43-89` | smart-commits.test, a8/grammar.test | HB10 | HB 47 |
| `#comment <text>` — rest of line; stops parsing further commands; comment ends with provenance "via <sha7> by <login>" | Developer | — | push | Comment | — | `smart-commits.ts:66-71,474-475,577-581` | smart-commits.test | HB10 | **GAP** (Plane result) |
| `#time 1w 2d 4h 30m` — 1w = 5d, 1d = 8h; decimals; rounded minutes; several on a line add up; posted as comment `Time logged: <raw> (<n> minutes)` | Developer | — | push | Comment (no CE worklog) | — | `smart-commits.ts:26-41,73-77,571-575` | smart-commits.test | HB10:149 | **GAP** |
| Any other `#token` = workflow state: exact hyphenated name → ignoring hyphens/apostrophes → unique whole-word prefix (`#in` matches "In Progress" and "In Review" → ambiguous); refused if ambiguous/not found; never into triage | Developer | — | push | State change | — | `smart-commits.ts:94-118,562-568` | a8/grammar.test | HB10 | **GAP** |
| Multiple keys and commands; partial success; malformed commands reported; idempotent per commit SHA (rebase/amend = new SHA = runs again) | Developer | — | push | — | — | `smart-commits.ts:451-596` | smart-commits.test | HB10 | — |
| Actor = webhook `sender` (never pusher/author); unmapped/bot → service identity + audit `identity_fallback` | Developer | — | push | Writes as service account (D-07) | — | `smart-commits.ts:1-3,357-366`, `src/auth/identity.ts` | smart-commits.test | HB10 | — |
| Signed commits enforced only by env `REQUIRE_VERIFIED_COMMITS`; God-mode **Require signed commits for Smart Commits** is stored but **not read** by the push handler (D-01) | Admin | God mode **Defaults** | push | Unverified commit → "This commit is not signature-verified; Smart Commit commands were ignored." | — | `src/app/push.ts:55`, `src/db/parity.ts:258-272` | review-r4-cc | UG, HB10 | UG admin-defaults.png |
| **Report problems as comments on GitHub and Plane** (default off) → commit comment + Plane comment on failure (exact texts in verified-strings) | Admin/Developer | Mapping form | Smart Commit failure | Comment on target item | Commit comment | `smart-commits.ts:297-318`, `src/github/problems.ts`, `push.ts:58-67` | parity-g2 | — | **GAP** |
| Large pushes: >2,048 commits → compare API up to 10,000; incomplete → "This push was incomplete; some Smart Commit commands may not have been processed." | — | — | push | — | — | `smart-commits.ts:148-269` | smart-commits.test | — | — |

## G. Issue mirroring

| Feature | Audience | UI location / route | Trigger | Effect in Plane | Effect in GitHub | Source | Tests | Existing doc section | Existing screenshot |
|---|---|---|---|---|---|---|---|---|---|
| Opt-in label `plane` on GitHub issue (on open or when labelled) | Developer | GitHub issue | issues opened/labeled | Creates item: title, description (Markdown→HTML), labels (except `plane`), mapped assignees, state (closed → closed state; open → chosen open state, else Plane default); comment "Mirrored from GitHub issue owner/repo#N."; link (if linkback); ensures a `github` label exists in the project | Linkback comment "Linked to Plane work item: <url>" (if linkback) | `src/sync/mirror.ts:349-363,491-530` | mirror.test, parity-g3 | HB11 | **GAP** |
| Opt-in label `github` on Plane item | Developer | Plane item | Plane issue webhook | Comment "Mirrored to GitHub issue owner/repo#N." + link | Creates issue: title, description + "---\nMirrored from Plane: <url>" footer, labels (+ `plane`, minus `github`); no assignees/state on create | `mirror.ts:638-690,757-810` | mirror.test | HB11:49 | **GAP** |
| Two-way mapping only; **GitHub to Plane only** ignores all Plane-origin events | Admin | Mapping **Sync direction** | — | — | — | `mirror.ts:17-27,640` | mirror.test | HB11 | — |
| Removing the gate label does not unlink; PRs never mirrored | Developer | — | — | — | — | `mirror.ts:347,410-411` | mirror.test | HB11:47 | — |
| Six fields: title, description, state, assignees, labels, new comments | Developer | — | edits | per policy | per policy | `src/ui/validate.ts:14-25` | mirror.test | HB11 | — |
| Conflict policies `last_write_wins`, `source_of_truth:github`, `source_of_truth:plane`; defaults Title & Description = GitHub; State, Assignees, Labels, Comments = last write wins | Admin | **Conflict policies** tab | — | — | — | `validate.ts:14-25`, `mirror.ts:17-27` | mirror.test | HB11:73, UG | **GAP** |
| State mapping GitHub→Plane: closed → chosen closed state else default completed; reopened → chosen open state else default unstarted; fallback audited `mirror_state_fallback`; never triage | Admin | Mapping **Open state**/**Closed state** | closed/reopened | State | — | `mirror.ts:240-266,398-408` | parity-g3 | HB11:99-103 | **GAP** |
| State mapping Plane→GitHub: completed → closed `completed`; cancelled → closed `not_planned`; others → open (`reopened`) | — | — | Plane state change | — | Issue state | `mirror.ts:268-277` | parity-g3 | HB11 | **GAP** |
| Assignees via user map (stable GitHub id); unmapped GitHub assignee is dropped | — | — | assigned/unassigned | Assignees | Assignees | `mirror.ts:448-462` | mirror.test | HB11:107-109 | **GAP** |
| Mentions: GitHub `@login` of linked user → Plane mention; unlinked → profile link; Plane mention → `@login` or escaped display name ("Unknown user" without a name); `#123`, `owner/repo#123`, issue URLs → links | — | — | comments, descriptions | — | — | `mirror.ts:96-118`, `src/sync/text.ts` | parity-g2, parity-g3 | HB08:60 | **GAP** |
| New comments only: GitHub → "**login** commented on GitHub:"; Plane → "**Name** commented in Plane:"; edits/deletes not mirrored; history not copied on create | Developer | — | comment created | Comment | Comment | `mirror.ts:372-380,646-660` | mirror.test | HB11:123 | **GAP** |
| Never synced: priority, dates, estimates, cycles, modules, parent/sub-items, relations, attachments, views, pages | — | — | — | — | — | (absence) `validate.ts:14` | — | HB11 | — |
| Deleting a Plane item ≠ close: reconciliation marks orphaned and posts "The linked Plane work item can no longer be found, so this link has been marked orphaned. Nothing was changed or closed here."; archive = archived link, no comment | — | — | reconcile cron (default 60 min) | — | Comment | `src/sync/reconcile.ts:18-40`, `src/app/main.ts:255-268` | reconcile.test, e2e2-archive | HB11:183 | **GAP** |
| Echo suppression (field-granular, TTL default 10 min), service-user filtering, dedupe, out-of-order protection (reads current state), queues/retries | — | — | — | — | — | `src/sync/ophash.ts`, `src/db/ledgers.ts`, `src/queue/*`, `mirror.ts:368` | sync tests | HB11, DG | HB diagram-delivery.svg |

## H. PR lifecycle rules

| Feature | Audience | UI location / route | Trigger | Effect in Plane | Effect in GitHub | Source | Tests | Existing doc section | Existing screenshot |
|---|---|---|---|---|---|---|---|---|---|
| Triggers: `pull_request.{drafted,opened,review_requested,changes_requested,approved,ready_for_merge,merged,closed_unmerged,reopened}`, `pull_request.*`, `push`, `commit.pushed_to_default`, `branch.created`, `check_suite.<word>`/`.*`, `deployment_status.<word>`/`.*`, `issue.<word>`/`.*`, `comment.<word>`/`.*` | Admin | Rules YAML | — | — | — | `src/rules/engine.ts:4-24` | rules/engine.test | UG | **GAP** |
| Conditions: `base_branch` (regex), `head_branch` (regex), `labels_any`, `labels_all` (exact), `author`, `repo` (case-insensitive, string or list), `project` (exact) | Admin | — | — | — | — | `engine.ts:255-297` | engine.test | UG | **GAP** |
| Actions: `set_state`, `add_label`, `remove_label`, `assign`, `comment`, `add_link {url,title}`, `log_time` (comment "Time logged: …"), `create_issue {project,title}`; `{{path}}` templates from event context | Admin | — | — | — | — | `src/rules/types.ts`, `engine.ts:200-238`, `pr-automation.ts:500-560` | engine.test | UG | **GAP** |
| First matching rule wins (one rule's actions per event) | Admin | — | — | — | — | `engine.ts:243-305` | engine.test | UG | — |
| Tier gating (`set_state` only): relation never changes state; non-closing changes state except on merge; closing on merge only if guard passes | — | — | — | — | — | `pr-automation.ts:491-498` | pr-automation.test | HB10:46 | — |
| Shipped defaults: Branch pushed (`branch.created`), PR drafted, PR opened → `started:In Progress`; Review requested → `started:In Review`; PR merged into `^main$` → `completed:Done`; others nothing; `branch.created` never moves a completed/cancelled item | Admin | Rules tab | — | State | — | `pr-automation.ts:30-40`, `src/app/rules.ts:18-21`, `pr-automation.ts:509-517` | pr-automation.test | HB09/HB12, UG | **GAP** |
| State target syntax `group`, `group:Name`, `Name`; `group:Name` falls back to the only state of that group, else not found | Admin | — | — | — | — | `pr-automation.ts:404-433` | pr-automation.test | — | — |
| **Ready for merge**: open, non-draft, ≥1 standing approval, no standing changes-requested, check suites completed success/neutral/skipped (empty/stale ignored), combined status success or none; once per head SHA | Developer | — | review approved / check_suite success / stage change | Rule result | — | `pr-automation.ts:185-235,373-390`, `pr.ts:184-200` | audit-g2, review-r5-cb | HB12 | **GAP** |
| Example: merge to `staging` → In QA, merge to `main` → Done (branch-aware rule) | Admin | Rules → **Branch-aware rules** | merged | State | — | `Workspace.tsx:515-571`, `pr-automation.ts:79-98` | client.test | UG | **GAP** |

## I. Workspace admin UI — `/git-sync/ui/workspaces/<slug>`

| Feature | Audience | UI location / route | Trigger | Effect in Plane | Effect in GitHub | Source | Tests | Existing doc section | Existing screenshot |
|---|---|---|---|---|---|---|---|---|---|
| Heading **Git sync: <slug>**; tabs **Repositories**, **User links**, **My GitHub account**, **Audit log** | Ws admin | Plane **Workspace settings → GitHub Sync** (iframe) or direct | — | — | — | `Workspace.tsx:37-44` | workspace.test | UG §12 | UG plane-gitsync-navigation.png, workspace-connection.png |
| **Set up GitHub sync** checklist (connect App; Rules; Conflict policies; **Member accounts** N linked of M; App events) — shown when no mappings | Ws admin | Repositories | — | — | — | `src/ui/client/health.tsx:28-37`, `Workspace.tsx:75-76` | parity2-g5 | UG | UG workspace-connection.png |
| **Workspace GitHub connection**: **Refresh connection**, **Connect GitHub**, **Send a link to an organization owner**, **Pending organization approval**, **Finish connecting**, **Send owner handoff link**, org card **Disconnect**, **Manage repository access on GitHub** | Ws admin | Repositories | — | Installation rows | App install/approval | `Connect.tsx:84-182` | parity2-g3 | UG §12 | UG workspace-connection.png (unconnected) |
| **Map a repository** form: **GitHub repository** (picker), **Refresh repositories**, **Plane project**, **Open state** / **Closed state** (**Project default**), "Choose different states for open and closed.", **Sync direction** (**Two-way** / **GitHub to Plane only**), **Smart Commits**, **Post link-back comments on GitHub** (default on), **Report problems as comments on GitHub and Plane** (default off), **GitHub autolink references (unavailable)** (disabled), **Add mapping** | Ws admin | Repositories | — | Mapping | — | `Workspace.tsx:114-197` | workspace.test | UG §12 | UG workspace-mapping.png |
| **Repository mapped** + **Backfill** offer: **Link existing open PRs and issues now**, **Not now**; on Settings tab **Run backfill**, **Continue**; result "Checked N pull requests and M issues: …" | Ws admin | after Add mapping; Settings tab | — | Links | — | `Workspace.tsx:68-71,791-816` | parity2-g5 | — | **GAP** |
| **Mapped repositories** table (Repository, Plane project, Direction "Two-way"/"GitHub to Plane", Sync health, **Edit**, **Remove** + confirm) | Ws admin | Repositories | — | — | — | `Workspace.tsx:72-103` | workspace.test | UG | **GAP** |
| Mapping tabs **Settings**, **Conflict policies**, **Rules**, **Test rules** | Ws admin | `/mappings/<id>[/policies|/rules|/dry-run]` | — | — | — | `Workspace.tsx:200-226`, `router.ts` | client.test | UG | **GAP** |
| Conflict policies: "Which side wins when both change the same field between syncs." options **Last write wins**, **GitHub is the source of truth**, **Plane is the source of truth**; **Save policies** | Ws admin | policies tab | — | — | — | `Workspace.tsx:228-263` | workspace.test | UG | **GAP** |
| Rules: **Lifecycle mapping table** / **Raw YAML editor**; **Lifecycle points → Plane state**; **Merged base-branch regex**; **Branch-aware rules**, **Base branch (regex)**, **+ Add branch rule**; **Save mapping table**; **Rules (YAML)**, **Rule to update**, **Apply state to selected rule**, **Validate and save YAML**; **Rule versions** table + **Restore** | Ws admin | rules tab | — | — | — | `Workspace.tsx:265-610` | client.test, parity-g5 | UG | **GAP** |
| **Test rules** (dry-run): **Test input** (**Webhook delivery** / **Specific rule trigger**), **Source**, **Event**, **Recorded delivery (audit entry id)**, **Payload (JSON)** / **Rule context (JSON)**, **Rules to test (YAML, optional)**, **Run dry-run**, results "Trigger: …", "No rule matched.", **No actions would run.** | Ws admin | dry-run tab | — | none (dry run) | none | `Workspace.tsx:818-886`, `src/ui/dry-run.ts` | parity-g5 | UG | **GAP** |
| **User links**: **Linked GitHub accounts** table, **Unlink** + confirm; **Link a user**: **Plane member**, **GitHub username**, **Look up id**, **GitHub user id**, **Link account** | Ws admin | `/users` | — | user_map | — | `Workspace.tsx:613-704` | workspace.test | UG | **GAP** |
| Sync health card: **Last GitHub delivery**, **Last Plane delivery**, **Last successful write**, **Errors in the last 24 hours** (link to filtered audit), **Rate-limited until** (only when set), **Disabled** (only when disabled); **Refresh sync health**; auto-refresh every 30 s | Ws admin | Repositories table | — | — | — | `health.tsx:5-18`, `Workspace.tsx:33-34,67` | parity2-g5 | — | **GAP** |
| Health banners (database unreachable; "Plane changes have stopped arriving…"; credentials not decryptable) | Ws admin | top of page | — | — | — | `health.tsx:20-27` | parity2-g5 | — | **GAP** |
| **Audit log**: When/Event/Outcome/Detail, **Show raw**, **Replay** (inbound deliveries; confirm), **Retry**/**Retry scheduled** (failed writes), **Load older entries**; filters only via URL `?mappingId=&errors=1&hours=` (no on-screen filter controls) | Ws admin | `/audit` | — | Replay may write | Replay may write | `Workspace.tsx:707-787`, `audit.tsx` | audit-g5, operations.test | UG | UG workspace-audit.png |

## J. Instance admin (God mode)

| Feature | Audience | UI location / route | Trigger | Effect in Plane | Effect in GitHub | Source | Tests | Existing doc section | Existing screenshot |
|---|---|---|---|---|---|---|---|---|---|
| God mode sidebar **GitHub Sync** (`/god-mode/git-sync/`) → iframe `/git-sync/ui/admin`; heading **Git sync: instance settings**; tabs **Settings**, **Instance audit** | Instance admin | — | — | — | — | `apps/admin/.../sidebar-menu.tsx:25-35`, `Admin.tsx:16-37` | instance.test | UG §11 | UG god-mode-navigation.png |
| **Connection health**: Database, GitHub App, Repository mappings, Last sync activity, Failures in the last 24 hours (link); "GitHub App credentials cannot be decrypted. Save the App secrets again." | Instance admin | Settings | — | — | — | `Admin.tsx:100-120` | instance.test | UG §11 | UG admin-setup.png |
| **Setup checks** / **Check setup again**: App credentials, App permissions, App webhook events, Signed GitHub deliveries, Plane deliveries, Plane request rate — each **Verified** / **Needs attention** / **Not verified** | Instance admin | Settings | — | — | — | `Admin.tsx:122-128`, `src/ui/setup-check.ts` | parity2-g1, parity2-g5 | UG §11 | UG admin-setup.png |
| **GitHub App** form: **App ID**, **Private key (PEM)**, **Webhook secret**, **App slug**, **OAuth client ID**, **OAuth client secret**, **GitHub edition** (**GitHub.com** / **Enterprise Cloud with data residency** + **Enterprise Cloud subdomain** / **Enterprise Server** + **Enterprise Server URL**), **Save GitHub App**; secrets encrypted, blank = keep | Instance admin | Settings | Save | — | — | `Admin.tsx:130-194` | instance.test | UG §11 | UG admin-github-app.png |
| **Workspace GitHub App installations** table + **Allow-list an installation** (**Installation ID**, **Workspace**, **Account / Org (optional)**, **Allow-list installation**), **Remove** | Instance admin | Settings | — | — | — | `Admin.tsx:196-310` | instance.test | UG | **GAP** |
| **Disabled repository mappings** (**Refresh mappings**; reasons "Save the mapping to verify its installation" / "Installation is not allowed for this workspace") | Instance admin | Settings | — | — | — | `Admin.tsx:62-98` | instance.test | — | **GAP** |
| **Manual mapping recovery** (**Workspace**, **Plane project**, **GitHub repository**, **GitHub repository ID**, **Add manual mapping**) | Instance admin | Settings | — | Mapping | — | `Admin.tsx:39-60` | instance.test | — | **GAP** |
| **Magic words** (**Closing words**, **Non-closing words**, **Relation phrases**; one per line; lowercase letters and spaces, ≤40 chars, ≤100 per tier, non-empty, one tier per word) **Save magic words** | Instance admin | Settings | — | — | — | `Admin.tsx:312-354`, `validate.ts:188-208` | instance.test | UG | UG admin-defaults.png (partly) |
| **Defaults**: **Enable Smart Commits for newly mapped repositories** (default on), **Require signed commits for Smart Commits** (not wired, D-01), **Reconciliation interval (minutes)** (60), **Echo-suppression TTL (minutes)** (10), **Save defaults** | Instance admin | Settings | — | — | — | `Admin.tsx:356-396`, `validate.ts:38` | parity2-g5 | UG | UG admin-defaults.png |
| **Instance audit** `/git-sync/ui/admin/audit` (`?scope=all` shows all workspaces; default shows activity with no workspace) | Instance admin | tab | — | — | — | `Workspace.tsx:707-778`, `router.ts` | audit-g5 | — | **GAP** |

## K. Installation and operations

| Feature | Audience | UI location / route | Trigger | Effect in Plane | Effect in GitHub | Source | Tests | Existing doc section | Existing screenshot |
|---|---|---|---|---|---|---|---|---|---|
| Prerequisites; bot service account + Plane PAT | Operator | Plane UI | — | Bot member + token | — | `INSTALL.md` §1, `src/install/main.ts` | install tests | UG §4–5 | UG plane-signup.png, plane-members.png, plane-personal-tokens.png, plane-token-dialog.png |
| `WEBHOOK_ALLOWED_HOSTS=git-sync.internal`; Plane webhook `http://git-sync.internal:3100/git-sync/webhooks/plane`, **Send me everything** | Operator | Plane **Workspace settings → Webhooks** | — | Webhook | — | `INSTALL.md:21-40` | verify-install-real-plane | UG §6–7 | UG plane-webhooks.png, plane-webhook-dialog.png |
| `./install.sh` prompts/output; options `--plane-dir`, `--env-file`, `--public-url`, `--keep-plane-ui`, `--with-plane-ui`, `--proxy plane|external`, `--gateway-network`, `--github-app-id` + `--github-private-key`, `-y/--yes`, `--uninstall`, `--purge`, `-h` | Operator | Terminal | — | Adds `git-sync` service via override | — | `install.sh:5-84`, `src/install/*` | `tests/install/*` | UG §8, INSTALL.md | UG installer-output.png, installer-next-steps.png |
| Plane UI fork image build (10–20 min) | Operator | Terminal | — | Fork web/admin images | — | `INSTALL.md:46` | — | UG §8 | — |
| GitHub App registration URLs: callback `/git-sync/oauth/github/callback`; setup `/git-sync/install/github/callback` + **Redirect on update**; webhook `/git-sync/webhooks/github` | Operator | GitHub **New GitHub App** | — | — | App | `INSTALL.md:57-59`, `src/index.ts` routes | — | UG §10 | UG github-app-urls.svg (Illustration) — **GAP** real form |
| Permissions: Pull requests RW, Issues RW, Contents RW; Checks R, Commit statuses R, Deployments R, Metadata R; Organization Members R | Operator | GitHub | — | — | — | `src/ui/setup-check.ts:7-10` | parity2-g1 | UG §10 | UG github-app-permissions.svg (Illustration) |
| 9 events: pull_request, pull_request_review, push, issues, issue_comment, check_suite, check_run, status, deployment_status | Operator | GitHub | — | — | — | `setup-check.ts:13-16` | parity2-g1 | UG §10 | same |
| Blank iframe fix (`frame-ancestors 'self'`; don't DENY `/git-sync/*`) | Operator | Proxy | — | — | — | `src/ui/static.ts`, UG §9 | ui/static.test | UG §9 | UG plane-gitsync-navigation.png |
| Update `git pull && sudo ./install.sh`; bot PAT rotation; never change `GITSYNC_TOKEN_KEY` | Operator | Terminal | — | — | — | INSTALL.md, `deploy/APPLY.md` | — | UG §14 | — |
| Uninstall / `--purge`; backups | Operator | Terminal | — | — | — | `install.sh`, INSTALL.md:85 | install tests | UG §14 | — |
| Webhook redelivery / **Replay**; `/git-sync/healthz` | Operator | — | — | — | — | `src/index.ts:60`, `Workspace.tsx:744-749` | operations.test | UG §15 | — |
| Env vars: PORT (3100), HOST, DATABASE_URL, REDIS_URL, QUEUE_PREFIX (gitsync), PLANE_BASE_URL, PLANE_SERVICE_PAT, PLANE_SERVICE_USER_ID, PLANE_WEBHOOK_SECRET[_PREVIOUS], PLANE_SESSION_COOKIE_NAME (session-id), PLANE_API_RATE_PER_MINUTE (60), GITHUB_APP_ID, GITHUB_PRIVATE_KEY_PATH, GITHUB_WEBHOOK_SECRET, GITHUB_CREDENTIAL_MARKER_PATH, GITHUB_EDITION, GITHUB_GHE_SUBDOMAIN, GITHUB_GHES_BASE_URL, GITHUB_API_BASE_URL, GITHUB_CLIENT_ID+SECRET (together), GITHUB_APP_SLUG, GITSYNC_TOKEN_KEY, PUBLIC_ORIGIN, REQUIRE_VERIFIED_COMMITS | Operator | `git-sync.env` | — | — | — | `src/config/env.ts` | config tests | DG Configuration reference | — |

## L. Known limitations (verified)

| Limitation | Evidence |
|---|---|
| `#time` and `log_time` are comments only (no CE worklog) | `smart-commits.ts:571-575`, `pr-automation.ts:528-531` |
| GitHub autolink references unavailable (disabled checkbox) | `Workspace.tsx:192` |
| Branch template not editable in UI/API | `src/ui/api.ts:460,517` patch only open/closed/reportProblems |
| No Commits list in Development panel | `DevPanel.tsx:69-86` |
| Deleting a Plane item ≠ closing (orphan comment only) | `reconcile.ts`, `main.ts:255-268` |
| Comment edits/deletes not mirrored | `mirror.ts:374,647` |
| Signed-commit checkbox not wired (env var only) | D-01 |
| Merge guard evaluated only at the merge event | `pr.ts:375-386` |
| Members cannot see **GitHub Sync** in Plane settings | `packages/constants/src/settings/workspace.ts:69-70` |
| No per-member Plane token entry: GitHub→Plane writes appear as the service account | D-07 |
| Markdown "…Preview" body links not detected by live handlers | D-11 |
| Audit filters only by URL, no filter controls | D-12 |
