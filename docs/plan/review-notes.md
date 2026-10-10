# Adversarial review — implementation plan parts A and B

Reviewed: `docs/plan/part-a-service-core.md` (A1–A8) and `docs/plan/part-b-github-ui.md` (B1–B8)
against `docs/superpowers/specs/2026-10-10-plane-github-sync-design.md`.

Both parts are plausible at a glance and both pass their own structural verifiers. They do not
survive being read against each other. The dangerous defects are not inside either part; they
are in the seam, where four Part B tasks own Plane-write behaviour while declaring no dependency
on the Part A write path that makes writing safe, and where the single largest deliverable in §8
(the UI the forks exist to embed) is owned by nobody.

---

## Part A — service core and Plane side

### A2 — Plane webhook signature verification is absent, and the acceptance line hides it

A2's acceptance: *"Incoming requests are signature-verified and placed onto BullMQ queues without
synchronous processing."* The body names exactly one mechanism: *"Integrate `@octokit/webhooks`
for GitHub signature validation."* Octokit verifies `X-Hub-Signature-256` on the GitHub route
only. §1.2 requires Plane's own scheme — HMAC-SHA256 in `X-Plane-Signature`, with a secret
"downloaded as CSV at creation and never shown again". No task in either part implements it. §3
makes `https://tasks.qelal.et/git-sync/webhooks/plane` a public HTTPS endpoint precisely so that
Plane's SSRF validation is sidestepped and `WEBHOOK_ALLOWED_IPS` stays empty, so as planned the
Plane ingress is a public, unauthenticated endpoint that enqueues attacker-chosen jobs into
`outbound:plane`. The plural "requests" in the acceptance line makes the gap invisible to a
reviewer who only reads acceptance criteria.

### A4 — the dedupe is inverted: it drops outbound writes, not inbound echoes

A4's acceptance: *"Outbound queue workers process tasks and correctly drop messages that match
recently applied operations."* §5 drops on ingress: "When a webhook arrives, hash the incoming
change identically — a match against a recent op means it is our own echo, and we drop it."
Dropping *outbound* messages that match a recent op is a different and incorrect behaviour: a
human who sets a state to Done, reverts it, and sets it to Done again inside the `applied_ops`
TTL produces an outbound write whose `op_hash` matches a recent op, and A4 as accepted discards
it. The work item then silently diverges from GitHub with no failure anywhere. A4's own body
contradicts its acceptance ("On the inbound side, hash incoming webhooks against this ledger to
discard self-echoes"), so an implementer building to the acceptance line ships the wrong system
and still passes the gate.

### A3 — the schema covers two tables; four consumers need more than two

A3 is scoped to *"the `sync_links` table ... [and] the `applied_ops` table"* and owns the only
migration file in either part (`src/db/migrations/001-init.sql`). Downstream tasks require
persistence A3 never defines:

- A4: *"Implement deduplication based on delivery IDs and restrict processing of commit commands
  to exactly once per commit SHA."* §5 requires these be stored and *"not to be conflated"* with
  `op_hash`. A4's file list is `src/sync/plane.ts`, `src/sync/github.ts`, `src/queue/workers.ts` —
  no migration, so the delivery-id and commit-SHA ledgers have no owner.
- A7: *"mark 404 responses as orphaned"* — A3 defines no status column to mark. A7 declares
  `Depends: A3`, so this is a live contract between two tasks in the same part that does not close.
- B7 audit log (§7.6 requires "Every inbound delivery, every rule match, every outbound call and
  its result" with replay) — no table.
- A3 also omits `tier` and `created_by`, which §5 lists as `sync_links` columns and which the
  §6 tier model (closing / non_closing / relation) needs at merge time.

A3's `Depends: none` is additionally wrong in the other direction: the `gitsync` database it
migrates into is created by A1's compose work (§3 "a `gitsync` database on the existing Postgres").

### A4 — the two Plane write semantics §4 tells us to exploit are missing from the task that claims them

A4 is titled *"Implement Plane write semantics and queue consumers"* and then never mentions
either semantic §4 singles out: the duplicate-link `400` ("We do not track link ids to avoid
duplicates — we post and treat that specific 400 as success") and the label `409` carrying the
existing id ("That is a free upsert"). B5 ("Both labels are auto-created on the target if absent")
and B6 both depend on this behaviour and neither restates it, so the free upsert is at risk of
being re-implemented as the list-then-create race §4 explicitly rules out.

### A5 — a scanned source and two §6 behaviours are dropped

A5: *"Scan branch names, pull request bodies, and commit messages."* §6 lists four sources:
"branch name, PR title, PR body, commit messages". **PR title is missing**, which is the most
common place a `Fixes WEB-1` actually lives. Also unclaimed by A5 or any B task:

- `{IDENTIFIER}-NEW` create-issue-from-PR (§6), including setting the configured started state.
- §6's multi-PR rule: "One item may have several PRs — **all linked PRs must merge** before the
  item advances to its merged state." B4 handles PR lifecycle and does not mention it either, so
  the first PR to merge will advance the item.

A5's `Depends: none` also contradicts its own body — *"resolve identifiers against the Plane API
endpoint"* needs A4's Plane client.

### A6 — the engine is narrower than §7.5 and has no compile target or dry-run mode

A6 outputs *"discrete actions such as state transitions, label modifications, and issue
creation."* §7.5's action set is `set_state`, `add_label`, `remove_label`, `assign`, `comment`,
`add_link`, `log_time`, `create_issue`. `log_time` is what B3's `#time` needs and `add_link` is
what B6 needs; neither exists in A6's output. Conditions are likewise short: A6 covers "branch
regexes, labels, and target projects", §7.5 adds author and repo. A6 never mentions the §7.1
compiler ("the simple lifecycle→state mapping table is *presentation sugar* that compiles down to
ordered rules"), never states first-match-wins ordering, and never provides the no-write
evaluation mode B7's dry-run requires. A6's acceptance — *"returns correct target actions"* — is
not decidable without a named fixture set; "correct" is the reviewer's opinion, not a check.

### A7 — right behaviour, wrong citation, missing config knob

A7 correctly refuses to treat a Plane deletion as a transition, which is the §1.3 rule that
matters. Two smaller defects: it cites "(§4)" for the sweep, which is §1.3 consequence 2 — §4 is
service internals; and it omits "Frequency is a config value", the only polling knob in the system.
Nobody in either part prunes `applied_ops` on the TTL A3 provisions, despite A7 owning the only
cron file (`src/queue/cron.ts`).

### A8 — the test task cannot pass, and omits the §10 security test

A8's acceptance: *"All defined automated tests pass completely without errors."* Its file list
includes `tests/smoke.test.ts`, and §10's smoke test is "One live smoke test against
`tasks.qelal.et` with a throwaway project and repo" — a live-instance test that cannot be a
precondition for an offline gate, and A8's body downgrades it to "a live smoke test *definition*",
contradicting the acceptance. §10's security test — "A commit with a forged `--author` must not
act as that user" — appears in neither the file list nor the body, and it is the one test that
proves the §7.2 attribution rule the whole Smart Commit design turns on. A8 also owns
`tests/grammar.test.ts`, which tests the Smart Commit grammar implemented in B3, while declaring
`Depends: A4, A5, A6, A7` — no Part B dependency at all.

---

## Part B — GitHub side, UI forks, attribution, ops

### B1, B2 — the fork surface is correct; the UI it embeds does not exist in the plan

Checked and sound: B1 and B2 together touch exactly four files (`apps/admin/components/nav.tsx`,
`apps/admin/pages/git-sync-iframe.tsx`, `apps/web/components/nav.tsx`,
`apps/web/pages/git-sync-iframe.tsx`), matching §8's "Four files of fork surface total", and each
adds one nav entry plus one iframe route rather than native pages. The failure is what is on the
other side of the iframe. §8: "All real UI is one React app in this repo with two entry routes."
No task in either part builds that app, its two entry routes, or the config API behind it, so
every §8 workspace-settings capability — repo↔project mappings, state mappings and rule sets,
sync direction and per-field conflict policy, per-repo Smart Commits toggle, per-user GitHub
account linking — has a nav entry pointing at nothing and no persistence (see A3). B7 names
`src/operations/tooling.ts` for dry-run, audit log and backfill, which are §8 UI surfaces, and a
single server-side tooling file is not the React app.

B2 also drops the §8 auth requirement that matters most. B1 says "This uses Plane's API for auth
and role verification"; B2's text contains no equivalent, yet §8 requires validating the viewer
and checking "workspace role (admin/owner) before rendering **or accepting mapping writes**" —
and B2 is the surface that accepts mapping writes.

### B3 — attribution is right; both mandatory §7.2 guards are incomplete

Checked and sound: *"it strictly trusts `sender`, never `pusher` or the commit author"* is exactly
§7.2, including the correct rejection of `pusher.name` / `pusher.email`. What is missing:

- The fallback covers only one of three cases: *"gracefully falling back to the service account
  when `sender` is `ghost`"*. §7.2 requires the same fallback when `sender` is "a bot, or
  unmapped", and requires that the fallback be recorded in the audit log. "Never guess an actor"
  is unmet when `sender` is an app.
- The second mandatory guard is absent: "A config option requires `verification.verified == true`
  on the commit before honouring Smart Commit commands."
- B3 adopts `#<transition>` from §7.2, where it "Matches a Plane state name", and adds no project
  scoping of its own. §7.1 requires resolution by `(project, group)` with name as fallback "never
  by name alone", and says
  explicitly that "Smart Commit transition names (§7.2) resolve per project" because `DSAFDSF`
  spells its unstarted state without the space and says "Cancelled" where `QLL` says "Won't Do".
- The §7.2 loud-failure rule ("A command whose target state does not exist in the Plane project
  **fails loudly** into the audit log") is not stated.
- Nothing in B3 restricts a transition target. Since §7.2's `#<transition>` resolves against
  Plane state names and B3 narrows that for neither project nor group, `WEB-1 #triage` on a
  project carrying a triage state writes a work item into the `triage` group — the one thing
  §7.1 forbids outright.

### B4 — a second state evaluator, declared independent of the engine it is supposed to compile into

B4: *"Implements branch-regex rules and formats branch names ... it evaluates lifecycle states and
ensures we never write into the `triage` group. It complies with the constraint that mappings
compile to rules."* Branch-regex matching and lifecycle→state evaluation are A6's job; §7.1 is
unambiguous — "There is exactly one runtime engine: the rules of §7.5 ... The implementation must
not grow a second, parallel state-mapping evaluator." A task that both evaluates lifecycle states
in `src/github/pr-automation.ts` and claims `Depends: none` cannot be compiling into A6: either it
is the prohibited second evaluator, or the dependency on A6 is missing. One of the two is true and
the plan does not say which.

B4's own sentence also contradicts §7.1 twice over: *"mapping PR events to the six state groups
cleanly"* — the six groups include `triage`, the group the same sentence promises never to write,
and §7.1 maps lifecycle points to *states* (In Progress, In Review, Done), not to groups. B4
further drops the §7.1 issue→branch behaviours beyond formatting: "optional branch creation via
the GitHub API" and "optionally move the item to its started state when the branch name is copied
or the branch is first pushed". Neither is claimed anywhere.

### B5, B6 — defaults and link mutability

B5 enforces "the per-field conflict policy" without carrying §7.3's shipping defaults
(`source_of_truth:github` for title/description, `last_write_wins` for state and assignees), and
omits §7.3's "A cross-link comment confirms the connection". Its `Depends: none` is false: label
gating needs `sync_links` (A3) and every mirrored field is a Plane write (A4).

B6 states the §7.4 rule correctly — *"Autolinks remain off by default because they need the
`Administration: Write` permission"* — which I checked against §7.4 and against B1's permission
list, where it is correctly fenced as "only if autolinks are enabled". The defect is mechanical:
B6 surfaces mutable rollups ("PR status `OPEN` / `MERGED` / `DECLINED`", build status) as links
with reserved title prefixes, but §4 establishes that `POST .../links/` rejects a duplicate URL on
the same issue with `400`. A PR's rollup link must therefore be *updated* in place via
`/links/{pk}/`, which requires retaining the link id — the exact thing §4 discards ("We do not
track link ids to avoid duplicates"). Neither A4, which owns Plane writes, nor B6 reconciles those
two positions, so every rollup transition either fails with a 400 or silently stops updating. B6 also garbles detection: "preview links and categorised links are
detected via title prefix", where §7.4 detects previews by provider (Vercel, Netlify, Cloudflare
Pages, AWS Amplify) and markdown links ending in "Preview", and uses the title prefix only for
categorised links.

### B7 — depends on a nav stub rather than on anything it needs

B7 declares `Depends: B2`, an iframe route component. Its three deliverables depend on Part A:
dry-run needs A6's rule engine plus the no-write evaluation mode A6 does not provide, the audit
log needs a table A3 does not define, and replay needs A2's ingress and A4's outbound workers.
As ordered, B7 is dispatchable the moment a nav entry exists and cannot be built.

### B8 — the right rules in a file that cannot hold them

B8 covers §9's email matching ("requiring exactly one match") and the service-account PAT
correctly. Two defects:

- *"Rate limit headers are respected with backoff strategies"* in `src/auth/identity.ts`. Rate
  limiting is a property of the `outbound:plane` and `outbound:github` workers, which are A4's
  `src/queue/workers.ts` (§4: "`outbound:plane` — rate-limited Plane API writes"). B8 owns one
  identity file and cannot implement it; A4 never mentions rate limiting. The capability falls
  between the two.
- §9's PAT handling is reduced to *"Manages credentials securely"* and *"per-user PATs are
  full-privilege"*. The concrete obligations are unclaimed: "Encrypt at rest, never log them, and
  give the UI a revocation path. A user revoking their mapping must invalidate the stored token" —
  no task owns the encryption, and the revocation path belongs to a UI that does not exist (B1/B2).
  The §11 open item "Decide whether to raise `API_KEY_RATE_LIMIT`, and to what" is unresolved in
  both parts, so the 60/minute default stands against a design whose §1.3 fan-out guarantees N
  deliveries per multi-field update.

Also unowned across both parts: `@octokit/app` installation-token minting. §4 names it as one of
"the two largest pieces of boilerplate in the project"; A2 integrates only `@octokit/webhooks`,
A4 writes GitHub via `src/sync/github.ts` with no token source, and B1 covers the permission set
and installation UI, not token minting and refresh.

---

## What I checked and found genuinely sound

- §5 field-granular echo ledger: A3 is correct and explicit — "track a field-granular `op_hash`
  ... Whole-object hashing must not be used", and A4 restates the tuple `(target side, target id,
  single field name, normalized new value)`. This is the spec's hardest requirement and both tasks
  hold the line.
- §7.4 autolinks off by default: stated in B6, and B1's permission list gates
  `Administration: Write` behind it.
- §7.2 `sender`-only attribution: stated in B3 and nowhere contradicted; no task reads
  `pusher` or a commit author field.
- §8 four-file fork surface: counted file by file across B1 and B2 — exactly four, iframe only.
- §1.3 deletions: A7 marks links orphaned and forbids inferring a state transition, which is the
  correct reading of a platform limit that has no webhook.

One tooling hazard integration should know about, found while writing this review: both
`scripts/verify-review.mjs` and `scripts/verify-no-placeholders.mjs` reject a case-insensitive
word match on the four deferred-work markers anywhere in `docs/plan/*.md`. One of those markers is,
letter for letter, `DSAFDSF`'s unstarted state name from §7.1, so no plan artifact can quote the
state name that the §7.1 per-project name-resolution rule exists to handle. Either the checkers
need a narrower pattern or every plan file must paraphrase it, as this review does.

One residual §8 risk I could not resolve from the plan and am not counting as a defect: §4
describes `apps/admin` as "React Router + TypeScript", while B1 and B2 both add a file under
`pages/`. If route registration requires editing a router array rather than dropping in a file,
each fork touches a third file and the four-file budget is exceeded. Integration should confirm
against the actual fork tree.

---

VERDICT: BLOCKING

- BLOCKER: A2 implements GitHub signature verification only; Plane's `X-Plane-Signature`
  HMAC-SHA256 (§1.2) is verified by no task, leaving the public `/git-sync/webhooks/plane`
  endpoint unauthenticated while its acceptance line claims "Incoming requests are
  signature-verified".
- BLOCKER: A4's acceptance inverts the §5 dedupe — "Outbound queue workers ... drop messages that
  match recently applied operations" discards legitimate repeat human writes inside the TTL;
  §5 drops inbound echoes, and A4's own body says so.
- BLOCKER: B3, B4, B5 and B6 each declare `Depends: none` and each produces Plane writes, with no
  stated interface forcing those writes through A4's `op_hash` record-before-write path. Four
  independent write paths reintroduce the echo loop §5 exists to prevent.
- BLOCKER: B4 "evaluates lifecycle states" and "Implements branch-regex rules" in
  `src/github/pr-automation.ts` with no dependency on A6 — either the second parallel state
  evaluator §7.1 forbids, or a missing dependency; the plan does not say which.
- BLOCKER: the `triage` prohibition (§7.1) is asserted only in B4 ("ensures we never write into
  the `triage` group"). B3 inherits §7.2's state-name matching with no exclusion, and B5's state
  mirroring and A6's `set_state` carry no guard at all, so three paths can write into `triage`. The guard must sit on the single
  Plane write path (A4), not in one consumer.
- BLOCKER: no task owns the embedded React app §8 requires ("All real UI is one React app in this
  repo with two entry routes") or the persistence behind it. Repo↔project mappings, rule sets,
  conflict policy, per-repo toggles and the §9 user map have no table in A3 and no UI anywhere;
  B1/B2's iframes point at nothing.
- BLOCKER: A3 defines two tables while A4 ("deduplication based on delivery IDs ... exactly once
  per commit SHA"), A7 ("mark 404 responses as orphaned") and B7 (audit log with replay, §7.6)
  all require storage A3 does not define, and A3 owns the only migration file in the plan.
