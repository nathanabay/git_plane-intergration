# Plane ↔ GitHub Sync — Design Spec

**Date:** 2026-10-10
**Status:** Approved design, pending implementation plan
**Target instance:** Plane v1.4.2 Community Edition at `tasks.qelal.et` (host `convpss`, install `/root/plane`)

---

## 1. Purpose and context

Plane's GitHub integration ships as `silo`, a closed-source container available only in the
Commercial edition. The live instance runs Community Edition images (`makeplane/plane-*`, no
`silo` container), so there is no first-party path to GitHub sync and there will not be one
without a license purchase.

This project builds that integration as a standalone service, reaching **feature parity with
Linear's GitHub integration** — which exceeds Plane's own Commercial offering in branch-aware
automation and multi-issue linking — plus Jira's Smart Commits and development-panel data.

**Non-goal:** replacing or patching Plane's API server. Every write to Plane goes through the
public REST API. We never touch Plane's database tables.

### 1.1 Verified instance facts

These were read from the live host and drive the design:

| Fact | Value | Consequence |
|---|---|---|
| Plane version | v1.4.2 CE | No `silo`; API surface confirmed below |
| Domain | `tasks.qelal.et` | Single-origin hosting for the iframe UI |
| Host proxy | Caddy at `/root/caddy`, external `gateway` network, `reverse_proxy plane-proxy:80` | Our service joins `gateway`; one `handle` route added |
| Compose | `/root/plane/docker-compose.yaml` + existing `docker-compose.override.yaml` | Override is the established seam; upstream file untouched |
| Datastores | Postgres 15.7, Valkey 7.2.11, RabbitMQ 3.13.6, MinIO | Reuse all; add zero new infrastructure |
| `API_KEY_RATE_LIMIT` | `60/minute`, set in `plane.env` | Tunable by us — raise it rather than engineering backpressure |
| `WEBHOOK_ALLOWED_IPS` / `_HOSTS` | empty | Public HTTPS webhook URL avoids the question; these are the fallback lever |
| Watchtower | `WATCHTOWER_LABEL_ENABLE=true`, no Plane container labelled | Fork images will **not** be auto-replaced |

### 1.2 Verified Plane v1.4.2 API surface

From `/code/plane/api/urls/` in the running `plane-api-1` container:

- `GET|PATCH /api/v1/workspaces/{slug}/issues/{project_identifier}-{issue_identifier}/`
  — **resolves `PROJ-123` directly by human identifier.** No project-identifier cache needed.
- `GET|POST /api/v1/workspaces/{slug}/projects/{pid}/issues/` and `/{pk}/`
- `.../issues/{issue_id}/comments/` and `/{pk}/`
- `.../issues/{issue_id}/links/` — attach PRs as first-class links, not description text
- `.../issues/{issue_id}/activities/` — read activity
- `.../states/`, `.../labels/`, `.../members/`, `/workspaces/{slug}/members/`
- `GET /workspaces/{slug}/issues/search/`

Auth: `X-API-Key: <PAT>` (Profile Settings → Personal Access Tokens) or
`Authorization: Bearer <token>` for OAuth.

Webhooks: workspace-level (Workspace Settings → Webhooks), one webhook covers all projects,
HMAC-SHA256 in `X-Plane-Signature`, with `X-Plane-Delivery` and `X-Plane-Event` headers. The
secret is downloaded as CSV at creation and never shown again.

### 1.3 Webhook mechanics — verified in the deployed v1.4.2 code

Read directly from `plane-api-1` on the live host, so this is authoritative for this instance,
not inferred from docs.

**REST API writes DO fire webhooks.** `plane/api/views/issue.py` — the *public* API view —
declares `webhook_event = "issue"` / `"issue_comment"` and calls `model_activity` from
`plane/bgtasks/webhook_task.py` for webhook dispatch (lines 92, 186, 262, 529, 671, 731, 818,
1365, 1521). Our own API writes will therefore echo back to us. The §5 machinery is required.

**One webhook per changed field, not one per update.** `model_activity`
(`plane/bgtasks/webhook_task.py:479`) diffs the requested payload against the current instance
and calls `webhook_activity.delay(...)` **once for every key whose value changed**, with:

| field | meaning |
|---|---|
| `event` | model name (e.g. `issue`) |
| `verb` | `created` (when `current_instance is None`) or `updated` |
| `field` | the single changed attribute name |
| `old_value` / `new_value` | that attribute's before and after values |
| `actor_id` | the acting user |
| `event_id` | the model row id |

Two consequences:

1. **Echo detection can be field-granular.** Our `op_hash` is computed over
   `(side, event_id, field, normalized new_value)` — precisely the unit Plane reports — rather
   than a whole-object field-set hash. Cheaper, and exact rather than approximate.
2. **Queue volume scales with changed fields.** A single multi-field update produces N
   deliveries. Sizing and dedupe must assume fan-out, and a burst of N echoes must collapse to
   zero outbound writes.

`actor_id` is present, so bot-actor filtering is available as a cheap first-pass filter. It is
**not** sufficient on its own — see §5 — but it cheaply discards the common case before hashing.

**Event catalog.** `X-Plane-Event` takes one of `project`, `issue`, `module`, `module_issue`,
`cycle`, `cycle_issue`, `issue_comment`; `action` is one of `create`, `update`, `delete`
(`webhook_send_task`). `data` carries the full serialized object via `SERIALIZER_MAPPER`;
`activity` carries `field` / `old_value` / `new_value` / `old_identifier` / `new_identifier`
plus a full `actor` object **including `email`** — which is what makes user mapping (§9)
practical without a separate directory.

**Deletions do not fire webhooks.** Issue `delete`/`destroy` on both the API and the app write
only internal `issue_activity` audit rows; no webhook is emitted. Only *project* deletion
emits one. This is a hard platform limit with three consequences:

1. **Plane → GitHub deletion sync is impossible via webhooks.** A work item deleted in Plane
   leaves its GitHub counterpart and its `sync_links` row orphaned.
2. Mitigation is a **periodic reconciliation sweep** over `sync_links`: re-fetch each linked
   Plane issue, and on a 404 mark the link `orphaned` and optionally comment on the GitHub side.
   Frequency is a config value; this is the only polling in the system.
3. Deletion is therefore **never** treated as a state transition. An unreachable issue is
   `orphaned`, not "closed" — guessing would silently close live GitHub issues.

Everything the full feature set requires exists. Feasibility is confirmed, not assumed.

---

## 2. Research basis

| Product | Model | What we take |
|---|---|---|
| **Linear** | Magic words, branch-aware rules | Trigger vocabulary, three-tier magic words, branch regex rules, multi-issue PRs, preview links, create-issue-from-PR |
| **Plane Pro (Silo)** | Label-gated two-way, bracket-gated PR automation | Field-level sync semantics, label auto-creation, sync-direction modes, per-project repo mapping |
| **Jira** | Smart Commits, development panel | Commit-message command grammar, build/deployment/review rollups, per-repo toggles, the author-spoofing security caveat, fork dedupe |
| **Trello** | Power-Up (display-only) + Butler | Rich attachment metadata on the work item; **Butler's generic trigger→actions rule engine**, which replaces fixed mapping tables |

Twilio was evaluated and rejected: it has no first-party GitHub issue integration, only
Zapier-style glue and GitHub Actions for deploying Twilio Functions. Nothing transferable.

---

## 3. Deployment architecture

One new container, `git-sync`, declared in `/root/plane/docker-compose.override.yaml`:

- Networks: `default` (reach `plane-db`, `plane-redis`) and `gateway` (reachable by host Caddy),
  alias `git-sync`.
- Listens on `:3100`.
- Host Caddy, inside the existing `tasks.qelal.et` block, gains **one** route placed *before*
  the catch-all:

```
tasks.qelal.et {
    handle /git-sync/* {
        reverse_proxy git-sync:3100
    }
    reverse_proxy plane-proxy:80
}
```

Single origin is deliberate: it makes the embedded admin UI same-origin, so no third-party
cookie or frame-ancestor problems.

**Webhook endpoints:**
- Plane → `https://tasks.qelal.et/git-sync/webhooks/plane`
- GitHub → `https://tasks.qelal.et/git-sync/webhooks/github`

Both are public HTTPS, which sidesteps Plane's SSRF URL validation entirely.

**Storage:** a `gitsync` database on the existing Postgres; BullMQ queues on the existing
Valkey under a `gitsync:` key prefix. No new services.

**Two Plane write semantics worth exploiting rather than reimplementing:**

- `POST .../issues/{id}/links/` **rejects a duplicate URL** on the same issue with `400`
  (`{"error": "URL already exists for this Issue"}`). We do not track link ids to avoid
  duplicates — we post and treat that specific 400 as success.
- `POST .../labels/` returns **`409` with the existing label's id** on a name collision
  (`{"error": "...already exists...", "id": "<existing_id>"}`). That is a free upsert: post
  the label, and on 409 read the id out of the error body. No list-then-create race.

Error envelope is uniformly `{"error": "<message>"}`; `400` validation, `403` permission,
`404` missing, `409` semantic duplicate. List endpoints paginate with cursors
(`next_cursor` / `prev_cursor` / `next_page_results`), not offsets.

---

## 4. Service internals

**Stack: TypeScript + Node.** Rationale, in order of weight:

1. The embedded UI must be React — `apps/admin` is React Router + TypeScript with MobX, SWR and
   `@makeplane/propel`. One language across service and UI, with shared config types.
2. `@octokit/app` handles GitHub App JWT → per-installation token minting and refresh;
   `@octokit/webhooks` handles signature verification and gives fully typed event payloads.
   These are the two largest pieces of boilerplate in the project, and they come for free.
3. BullMQ runs on the Valkey already in the compose.

**Request path does three things only:** verify signature, enqueue, return 200. No business
logic in the handler — both GitHub and Plane retry on slow responses, and a slow handler is a
loop generator.

**Queues**, separated so one side's outage cannot stall the other:
- `inbound:github` — parse and reduce GitHub events
- `inbound:plane` — parse and reduce Plane events
- `outbound:plane` — rate-limited Plane API writes
- `outbound:github` — GitHub API writes

---

## 5. Echo-loop prevention

The core correctness problem of any two-way sync: Plane event → GitHub write → GitHub event →
Plane write → repeat.

**Two tables:**

`sync_links` — the identity map.

| column | purpose |
|---|---|
| `plane_workspace_slug`, `plane_project_id`, `plane_issue_id` | Plane side |
| `gh_repo_id`, `gh_number`, `gh_kind` (`issue`\|`pr`) | GitHub side |
| `tier` | `closing` \| `non_closing` \| `relation` |
| `created_by` | `magic_word` \| `branch` \| `label_sync` \| `manual` |

`applied_ops` — a ledger of mutations **we** caused.

| column | purpose |
|---|---|
| `op_hash` | hash of (target side, target id, **single field name**, normalized new value) — matching Plane's per-field webhook unit (§1.3) |
| `direction` | which way we wrote |
| `created_at` | TTL pruning (minutes) |

Before writing to either side, compute `op_hash` for **each field** the mutation touches;
after the write, record them. When a webhook arrives, hash the incoming change identically — a
match against a recent op means it is our own echo, and we drop it.

Because Plane emits one delivery per changed field (§1.3), a write of N fields produces N
echoes, each matching exactly one recorded op. The dedupe is therefore exact, not heuristic.
Cheap pre-filter: discard events whose `actor_id` is the service user before hashing at all.

**Why not simply ignore events authored by the bot user?** Because that breaks the moment
per-user attribution (§9) lands: writes then come from real users and are indistinguishable
from human edits. Content-hash dedupe is what keeps per-user attribution possible. This is the
most machinery in the design and it is deliberate.

**Separate idempotency keys, not to be conflated:**
- Webhook redelivery → `X-Plane-Delivery` / `X-GitHub-Delivery`, stored and rejected on repeat.
- Commit-message commands → **keyed on commit SHA**, processed exactly once. This fixes two
  documented Jira bugs: fork pushes re-delivering the same commit, and history rewrites
  (rebase, amend) producing "new" commits that re-fire commands.

---

## 6. Linking and reference parsing

A Plane work item is referenced as `{PROJECT_IDENTIFIER}-{SEQUENCE}` (e.g. `WEB-344`), resolved
through the identifier endpoint in §1.2.

**Sources scanned:** branch name, PR title, PR body, commit messages.

**Magic words — three tiers** (Linear's model, chosen over Plane Pro's `[WEB-344]` bracket
gating, which is worse ergonomics for the same outcome):

| Tier | Words | Effect |
|---|---|---|
| Closing | `close` `closes` `closed` `closing` `fix` `fixes` `fixed` `fixing` `resolve` `resolves` `resolved` `resolving` `complete` `completes` `completed` `completing` `implement` `implements` `implemented` `implementing` | Full automation **including** the on-merge state |
| Non-closing | `ref` `refs` `references` `part of` `contributes to` `toward` `towards` | Advance through workflow states, **skip** the final merge state |
| Relation | `relates to` `related to` | Link only, no state change |

**Opt-out:** `skip WEB-344` or `ignore WEB-344` in the PR body suppresses linking.

All three word lists are configurable (§8, instance scope).

**Multi-issue:** one PR may close several items (`Fixes WEB-1, WEB-2, API-9`); keys separated by
whitespace or commas. One item may have several PRs — **all linked PRs must merge** before the
item advances to its merged state.

**Create issue from PR:** `{IDENTIFIER}-NEW` in a PR body creates a new work item in that
project, links it, and sets it to the configured started state.

---

## 7. Feature set

### 7.1 PR and branch automation

Lifecycle points, each mappable to a Plane state:
`drafted` · `opened` · `review_requested` · `changes_requested` · `approved` ·
`ready_for_merge` · `merged` · `closed_unmerged` · `reopened`

**Branch-aware rules**, ordered, first match wins — merging to `staging` → *In QA*, merging to
`main` → *Deployed*. Matched by regex against the PR's **base** branch. Plane Commercial has no
equivalent.

**Verified state model and concrete defaults.** Read from the live instance: Plane uses six
state groups — `backlog`, `unstarted`, `started`, `completed`, `cancelled`, and **`triage`**
(a sixth beyond the usual five, used by intake). Each project has exactly one `default` state.

The live projects are `QLL` and `DSAFDSF`. `QLL`'s workflow is Backlog *(default)* / To Do /
In Progress / In Review / Done / Won't Do, with **In Review** already in the `started` group,
which maps cleanly onto PR review events. Shipping defaults for `QLL`:

| Trigger | Default target state |
|---|---|
| branch pushed, PR drafted, PR opened | In Progress |
| review requested | In Review |
| approved | In Review (no change) |
| merged, base `main` | Done |
| closed without merge | *no change* |

Two rules the implementation must respect:

- **Never move a work item *into* the `triage` group.** Triage is an intake state; automation
  writing into it would hide items from the normal board flow.
- Resolve states by `(project, group)` with the name as a fallback, never by name alone —
  `DSAFDSF` says "Todo" and "Cancelled" where `QLL` says "To Do" and "Won't Do". Name-only
  matching would silently fail across projects, which is also why Smart Commit transition names
  (§7.2) resolve per project.

**One mechanism, two surfaces.** There is exactly one runtime engine: the rules of §7.5. The
simple lifecycle→state mapping table is *presentation sugar* that compiles down to ordered
rules, so an admin who only wants "merged → Done" never sees rule syntax, while an advanced
user edits the compiled rules directly. The implementation must not grow a second, parallel
state-mapping evaluator — if the mapping UI cannot express something, it emits a rule.

**Issue → branch:** copyable formatted branch name (configurable format, e.g.
`{username}/{identifier}-{slug}`), optional branch creation via the GitHub API, and optionally
move the item to its started state when the branch name is copied or the branch is first pushed.

### 7.2 Smart Commits (Jira grammar)

Grammar: `<ignored text> <ISSUE_KEY> <ignored text> #<command> <args>`

| Command | Syntax | Notes |
|---|---|---|
| `#comment` | `WEB-34 #comment corrected indent issue` | Posts a Plane comment |
| `#time` | `WEB-34 #time 1w 2d 4h 30m logged` | Decimals allowed; comment attached automatically |
| `#<transition>` | `WEB-90 #done #comment fixed today` | Matches a Plane state name; spaces → hyphens; ambiguity resolved by full hyphenated name |

Multiple commands and multiple keys may combine on one line
(`WEB-1 WEB-2 #done #time 2d 5h #comment shipped`). A command **must not span lines**; each
line needs its own key.

Deviations from Jira, each deliberate:

- **Attribution keys off the authenticated actor, never git-supplied identity.** Jira's own
  docs warn that git permits attributing a commit to another user, which under email-matching
  grants that user's permissions to anyone who can push. GitHub's payloads make the distinction
  explicit, and it is **not** the one the field names suggest:

  | Field | Source | Trust |
  |---|---|---|
  | `sender` | the authenticated GitHub account that triggered the event | **use this** |
  | `pusher.name` / `pusher.email` | GitHub documents these as "metaproperties for Git author/committer information" | do not trust |
  | `head_commit.author` / `.committer` | commit metadata, forgeable via `git commit --author` | do not trust |

  We therefore attribute from `sender`. Two mandatory guards:

  - GitHub's docs warn **"don't assume `sender` always identifies the person who caused an
    event"** — it may be the `ghost` user, a bot, or an app. When `sender` is `ghost`, a bot,
    or unmapped, fall back to the service identity and record that in the audit log. Never
    guess an actor.
  - A config option requires `verification.verified == true` on the commit before honouring
    Smart Commit commands, for installations that want cryptographic assurance.
- **Once per commit SHA** (§5), fixing the fork and rebase duplication Jira documents.
- A command whose target state does not exist in the Plane project **fails loudly** into the
  audit log (§7.5) rather than silently, which is Jira's documented behaviour for required
  fields.

Per-repository enable toggle plus an account-level default for newly added repositories,
matching Jira's DVCS settings.

### 7.3 Two-way issue mirroring

Opt-in by label, following Plane Pro: a GitHub issue labelled `plane` creates a Plane work item;
a Plane item labelled `github` creates a GitHub issue. Both labels are auto-created on the
target if absent. A cross-link comment confirms the connection.

Synced fields: title, description, state (open/closed → mapped states), assignees, labels,
comments.

**Sync direction** per mapping: `bidirectional` or `github_to_plane` (GitHub authoritative).

**Conflict policy** — stated explicitly rather than Plane's blunt "GitHub overwrites": each
field is configured `last_write_wins` or `source_of_truth:<side>`. Default
`source_of_truth:github` for title/description, `last_write_wins` for state and assignees.

Assignee and mention mapping uses the user map (§9); unmapped users leave the field empty and
mentions degrade to a profile link, as Plane Pro does.

### 7.4 Development information on the work item

Jira's development panel, delivered through Plane's links and comments endpoints: linked
branches, commits, PRs, plus **build/check status and deployment status** — which neither Plane
Commercial nor Linear surfaces natively.

Rollups follow Jira's vocabulary: PR status `OPEN` / `MERGED` / `DECLINED`; review status
`REVIEW` / `APPROVAL` / `REJECTED`; build status pass if all runs passed, fail if any failed.

**Preview link detection** (Linear): Vercel, Netlify, Cloudflare Pages, AWS Amplify, and custom
markdown links ending in "Preview" are surfaced as named shortcuts on the work item.

**Categorised links.** Jira exposes typed remote links (`security_vulnerability`, `test_coverage`,
`alert`, `feature_flag`). Plane's links endpoint is a plain title+URL pair and **we cannot extend
Plane's schema** — we do not own it. The achievable version is a reserved title prefix
(`[CI] Build #42`, `[Deploy] production`) that our UI renders with an icon, degrading to readable
plain text in Plane's native UI. Anything richer requires a Plane fork, which §8 deliberately
limits to six files.

**Autolinks are optional and off by default.** Turning `WEB-344` into a clickable link in GitHub
uses `POST /repos/{owner}/{repo}/autolinks`, which requires repository **`Administration: Write`**
— a high-privilege permission to request across an org for a convenience feature, and adding it
later forces re-consent on every existing installation. Ship without it; offer it as a separately
consented upgrade for orgs that want it.

Linkback comments on the GitHub side are toggleable, as in both Linear and Trello.

### 7.5 Rule engine (the Butler contribution)

Rather than a fixed PR-state → Plane-state mapping table, automation is expressed as ordered
rules:

```yaml
- when: pull_request.merged
  if:   { base_branch: "^main$", labels_any: ["hotfix"] }
  then:
    - set_state: Deployed
    - add_label: shipped
    - comment: "Deployed via {{pr.url}}"
```

Triggers cover the §7.1 lifecycle plus `push`, `commit.pushed_to_default`, `check_suite.*`,
`deployment_status.*`, `issue.*`, `comment.*`. Conditions cover base/head branch regex, labels,
author, repo, target project. Actions cover `set_state`, `add_label`, `remove_label`, `assign`,
`comment`, `add_link`, `log_time`, `create_issue`.

This subsumes state mappings, branch regex rules, labelling and commenting into one surface, and
is strictly more expressive than any of the four researched products. Per §7.1, the simple state
mapping table in the UI compiles into these rules rather than being evaluated separately.

### 7.6 Operational features (not present in any researched product)

- **Dry-run / simulate.** Replay a recorded or live webhook against the current rule set and
  render what *would* happen, with no writes. This is the difference between config debugging
  taking minutes and taking a day.
- **Audit log with manual replay.** Every inbound delivery, every rule match, every outbound
  call and its result. Failed deliveries are replayable from the UI. Neither Plane Commercial
  nor Linear gives the operator a repair tool.
- **Backfill on connect.** On first mapping a repo, optionally scan existing open PRs and
  issues and establish links. Linear requires a separate importer for this.

---

## 8. Configuration surface and UI

Split across the two Plane frontends, per the approved decision:

**Instance admin** (`apps/admin` fork) — genuinely instance-wide:
- GitHub App credentials: app id, private key, webhook secret, optional GHE base URL
- Installation and connection health
- Global magic-word lists and Smart Commits default-for-new-repos

**Workspace settings** (`apps/web` fork) — per-workspace:
- Repo ↔ project mappings
- State mappings and rule sets — one surface, mappings compile to rules (§7.1, §7.5)
- Sync direction and per-field conflict policy
- Per-repo Smart Commits toggle
- Per-user GitHub account linking
- Audit log, dry-run, backfill

**Mechanism:** each fork adds a nav entry and a route component that renders an `<iframe>`
pointing at our proxied UI. Both frontends use an *explicit* React Router route config
(`app/routes.ts` imports `index`/`layout`/`route` from `@react-router/dev/routes`), so each app
also needs its `routes.ts` edited: **three files per app, six files of fork surface total**
(nav entry, route component, route registration). At v1.4.2 the workspace-settings nav entries
are defined in `packages/constants/src/settings/workspace.ts` and the admin nav in
`apps/admin/app/(all)/(dashboard)/sidebar-menu.tsx`; the exact files are recorded with the fork
patches. All real UI is one React app
in this repo with two entry routes, shipping on our schedule rather than Plane's release cycle.

Chosen because Plane has **no plugin or extension system** — no route seam, no hook API — so
there is no version of in-nav UI that avoids a fork. The iframe keeps the conflict surface to a
nav array and a route stub, which survives upstream rebases; native pages using `@plane/*` and
propel would be pixel-identical but put a fast-moving frontend app's internals in the diff.

**Auth:** the UI is served from Plane's own origin. Validate the viewer against Plane's API and
check workspace role (admin/owner) before rendering or accepting mapping writes. No second auth
system, no separate user store.

---

## 9. Attribution, identity and rate limits

**v1:** Plane writes use a service PAT; GitHub writes use the GitHub App installation token.
Everything is bot-attributed — the same behaviour Plane Commercial gives for unmapped users.

**Per-user attribution (phase 2):** a user map of `plane_user_id ↔ github_login`, with
per-user Plane PATs and GitHub OAuth tokens. When a mapping exists, write as the acting user;
otherwise fall back to the service identity. Safe only because of content-hash dedupe (§5).

**Security constraint on PATs, verified in source:** `APIKeyAuthentication` authenticates the
request **as the token's owning user**, so a PAT carries that user's *full* permissions. There
is no scope reduction, and a token may optionally be workspace-bound but is always user-bound.
Therefore:

- The service PAT must belong to a dedicated, least-privileged service account — never a human
  admin's token, whose compromise would hand over that admin's full access.
- Per-user PATs are full-privilege credentials. Encrypt at rest, never log them, and give the
  UI a revocation path. A user revoking their mapping must invalidate the stored token.

**User mapping is practical** because `activity.actor` and the member endpoints both expose
`email` (`UserLiteSerializer`: `id`, `first_name`, `last_name`, `email`, `avatar`, `avatar_url`,
`display_name`). Match GitHub accounts to Plane users by email, requiring exactly one match as
in §7.2; zero or several matches is a loud audit-log failure, never a guess.

Identity resolution rules:
- GitHub → Plane actor: from the event `sender`, **never** a commit author field (§7.2).
- Email matching, where used, must resolve to exactly one Plane user; zero or multiple matches
  is a loud audit-log failure, following Jira's one-match requirement.

**Rate limits:** `API_KEY_RATE_LIMIT=60/minute` lives in `/root/plane/plane.env` and is ours to
raise. Raise it rather than building elaborate backpressure against a self-imposed number. Keep
the queue for ordering, retries and GitHub's own secondary rate limits; honour
`X-RateLimit-Remaining` / `X-RateLimit-Reset` with exponential backoff.

---

## 10. Testing

- **Fixture-driven reducer tests.** Recorded webhook payloads for every GitHub and Plane event,
  run through the rule engine, asserting the exact set of outbound API calls. No live GitHub.
- **The echo-loop test, which is the one that earns its keep.** Feed a Plane event, capture the
  GitHub write, synthesize the GitHub webhook that write would produce, assert it is dropped.
  Then the reverse direction.
- **Idempotency tests.** Same delivery ID twice → one effect. Same commit SHA via two branches
  and again after a rebase → one effect.
- **Grammar tests.** Smart Commit parsing across multi-key, multi-command, hyphenated
  transitions, and malformed input.
- **Security test.** A commit with a forged `--author` must not act as that user.
- **One live smoke test** against `tasks.qelal.et` with a throwaway project and repo.

---

## 11. Risks and open items

| Risk | Mitigation |
|---|---|
| Fork maintenance across Plane releases | 6 files, iframe-only; pin `APP_RELEASE`; rebuild fork images on upgrade. `apps/web` moves faster than `apps/admin` — expect the nav array to be the recurring conflict. |
| AGPL-3.0 obligations | Internal use of a fork is fine; publishing source becomes required if offered to third parties. |
| No upstream plugin seam | Accepted and designed around; revisit if Plane ever ships an extension API. |
| Plane Commercial may later make this redundant | A license buys ~80% of this, maintained by someone else. Flagged to the user; decision made to own it. The rule engine, dry-run, audit replay and deployment data are not in the Commercial product. |
| Per-user PAT storage | Encrypted at rest; scoped tokens; revocation path in the UI. |

**Open items for the implementation plan:**
- ~~Confirm whether API writes fire webhooks~~ — **RESOLVED, see §1.3: they do.**
- ~~Confirm the full `X-Plane-Event` value set and per-event action vocabulary~~ —
  **RESOLVED, see §1.3.**
- ~~Confirm whether `.../issues/{issue_id}/links/` enforces URL uniqueness~~ — **RESOLVED:
  it does, with a 400; see §4.**
- ~~Confirm Plane's state group vocabulary~~ — **RESOLVED from the live DB: six groups
  including `triage`; see §7.1.**
- Decide whether to raise `API_KEY_RATE_LIMIT`, and to what.
