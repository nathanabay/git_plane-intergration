# Second adversarial review — after the fix-and-commit pass

Reviewed against the current artifacts, not against the agents' reports:
`docs/plan/part-a-service-core.md` (A1–A8) and `docs/plan/part-b-github-ui.md` (B1–B9), with
`docs/plan/review-notes.md` as the checklist and
`docs/superpowers/specs/2026-10-10-plane-github-sync-design.md` as the source of truth.

Method, so the conclusions are checkable: I read both parts line by line, re-derived every
`Depends:` edge into a graph to look for cycles, re-ran all four plan verifiers against the
current scripts rather than trusting the recorded gate evidence, located the spec lines each task
cites, and walked `git log --numstat` commit by commit.

**Headline.** All seven original blockers are genuinely closed in the artifacts — the Part B
author in particular fixed the exact things, in the exact places, rather than mentioning them.
The fix pass then introduced one new defect of the same class as the first blocker (a trust
boundary that no task owns), and Part A's commit history does not mean what the ledger
certifying it says it means.

---

## Adjudication of the seven original blockers

- Blocker 1 (A2, Plane webhook signature unverified): **CLOSED**. A2 now reads *"Integrate
  `@octokit/webhooks` for GitHub signature validation and explicitly implement HMAC-SHA256
  verification of `X-Plane-Signature` for Plane webhooks."* That is §1.2's scheme, named
  explicitly, on the task that owns `src/api/handler.ts`. A2 also picked up the non-blocking
  finding: *"Implement `@octokit/app` for installation-token minting and refresh."*
- Blocker 2 (A4 acceptance inverted the §5 dedupe): **CLOSED**. A4's acceptance is now *"Inbound
  queue workers drop incoming webhook echoes that match recently applied operations."* The word
  that mattered — inbound — is the one that changed, and it now agrees with A4's body ("On the
  inbound side, hash incoming webhooks against this ledger to discard self-echoes (§5)") and with
  §5's "When a webhook arrives ... we drop it".
- Blocker 3 (four Part B write paths bypassing A4's ledger): **CLOSED**. Each of the four now
  declares the dependency and the interface. B4 `Depends: A4` with *"All Plane writes are issued
  through A4's client, never directly."* B5 `Depends: A6, A4`, B6 `Depends: A4, A3` and B7
  `Depends: A4, A3` each carry *"Plane writes are issued exclusively through A4's client, never
  directly."* This is the single-write-path interface the blocker asked for, stated per task.
- Blocker 4 (B4 was a second state evaluator with no dependency on A6): **CLOSED**. The task is
  now B5, `Depends: A6, A4`, and reads *"Formats branch names and compiles lifecycle mappings and
  branch-regex rules into A6 engine rules."* Compiling into A6 is §7.1's "it emits a rule";
  nothing in B5 evaluates rules itself, so the prohibited parallel evaluator is gone.
- Blocker 5 (the `triage` prohibition sat in one consumer): **CLOSED**, and moved to the right
  place. A4 now carries *"Ensure the Plane write path firmly rejects any write targeting a
  `triage`-group state (§7.1)."* B5 explicitly delegates — *"It relies on A4's single write path
  to enforce the prohibition against writing into the `triage` group"* — and B4 resolves
  transitions *"scoped by `(project, group)` with name as fallback (§7.1)"*, which closes the
  `#triage` Smart Commit path the first review named.
- Blocker 6 (nobody owned the embedded React app or its persistence): **CLOSED as ownership**,
  with a new authorization gap recorded below as a blocker in its own right. B3 is new and states
  §8 almost verbatim: *"all real UI is one React app in this repo with two entry routes
  (instance-admin and workspace-settings) and a config API"*, enumerating repo↔project mappings,
  state mappings and rule sets, sync direction, conflict policies, the per-repo Smart Commits
  toggle, per-user linking, and the §7.6 operational surfaces. A3 supplies the persistence.
- Blocker 7 (A3 defined two tables while A4, A7 and B7 needed more): **CLOSED**. A3 now defines
  *"separate tables for delivery IDs and processed commit SHAs (§5), an orphaned status column
  (§1.3), the audit log (inbound deliveries, rule matches, outbound calls and results with
  replay) (§7.6), and the configuration tables (repo↔project mappings, state mappings, rule sets,
  conflict policy, per-repo toggles, and user map §9)"*, plus `sync_links` *"with `tier` and
  `created_by` columns"*. Every storage consumer the blocker named now has a table, and A3's
  acceptance was widened to match: *"establishing the mapping, ledger, audit, and config tables."*

Seven of seven closed. The three I tried hardest to break were 3, 5 and 6, because "mentions the
topic" was the failure mode I expected: 3 and 5 survived because the interface is stated per task
and the guard sits on the write path rather than in a consumer; 6 survived as ownership but not
as enforcement.

---

## Part A — residual defects after the fix

### A4 — the acceptance decides one of five behaviours, and cites the wrong section

A4's body now carries five obligations: record the field-granular `op_hash` before writing, drop
inbound echoes, treat a duplicate link `400` as success and a label `409` as an upsert, reject
`triage`-group writes, and dedupe on delivery id and commit SHA. Its acceptance tests only the
second. The `triage` rejection is now the spec's one absolute prohibition, enforced at exactly one
point in the system, with no acceptance criterion and no entry in A8's test list — the strongest
rule in the design is the least checked. A4 also says *"Apply Plane write semantics (§4)"*; the
400/`409` semantics are at spec lines 161–170, inside **§3** ("Two Plane write semantics worth
exploiting rather than reimplementing"), and §4 is Service internals. My first review mis-cited
that same passage as §4, which is probably where the citation came from; the correct reference is
§3.

Nothing specifies what happens to a recorded op whose write then fails. A4 records before writing
(correct — the echo can arrive before the write returns), so a failed write leaves an op in the
ledger that will suppress the matching *human* change for the rest of the TTL. One sentence on
removing the op on write failure would close it.

### A3, A7 — new storage without new retention, and a scope crossing

A3 now provisions delivery-id and commit-SHA tables; A7 prunes only one ledger: *"Also ensure this
task prunes `applied_ops` entries on their TTL."* Delivery ids and commit SHAs grow forever, and
commit SHAs in particular must be retained long enough to survive a rebase re-delivery, so their
retention is a design decision nobody has taken.

A3 also now delivers §8 config tables, the §7.6 audit log and the §9 user map — three sections
assigned to Part B. That is the right place for them (A3 owns the only migration file), but
`docs/plan/agent-gates/commit-a.GATES.md` still verifies Part A against assigned sections
`3,4,5,6,7.5,10`, so the ledger's description of Part A's scope no longer matches Part A.
Integration should record that A3 is the storage owner for Part B's three sections.

No table exists for the per-user PAT and OAuth tokens B9 promises to *"encrypt at rest"* and to
invalidate on revocation. §9 makes per-user credentials phase 2, so this is defensible as deferred
— but B9 states the obligation in present-tense v1 terms, and A3's enumeration is otherwise
exhaustive, so the omission reads as an oversight rather than a decision.

### A8 — still a Part A task testing Part B code

A8 `Depends: A4, A5, A6, A7` and owns `tests/grammar.test.ts`, which tests the Smart Commit
grammar implemented by **B4**, and `tests/echo-loop.test.ts`, which per §10 must "capture the
GitHub write" that B5 or B6 produces. Neither cross-part dependency is declared. This was a
non-blocking finding in the first review and is unchanged. A8's acceptance did improve and is now
decidable: *"The offline test suite passes completely without errors, and a live smoke test
definition is provided separately"*, and the §10 security test is now present — *"the critical
security test to ensure a commit with a forged `--author` must not act as that user."*

### A6 — the engine is now complete; one soft edge

A6 gained the full §7.5 action set (`set_state` through `create_issue`), author and repo
conditions, first-match-wins ordering, the §7.1 compile target and *"a no-write evaluation mode
required for dry-run capabilities."* Every gap the first review named is filled. Remaining soft
edge: rule sets live in A3's config tables, and A6 is `Depends: none`. Harmless if the engine
takes rules as an argument, wrong if it loads them; the plan does not say which.

---

## Part B — residual defects after the fix

### B3 — the config API that accepts mapping writes has no authorization owner

This is the new blocker. §8 requires: "Validate the viewer against Plane's API and check workspace
role (admin/owner) before rendering **or accepting mapping writes**." B2 claims both halves — *"It
validates the viewer via Plane's API and checks workspace role (admin/owner) before rendering or
accepting mapping writes"* — but B2's three files are fork-side client code
(`apps/web/app/(all)/(dashboard)/components/nav.tsx`, the route component, `apps/web/app/routes.ts`).
A route component can gate *rendering*; it cannot gate *accepting*, because our API is a separate
origin path (`/git-sync/*` per §3) reachable without the iframe. B3 owns that API —
*"two entry routes ... and a config API"* — and says nothing about authentication or role checks.

So the write-side authorization is asserted by a task that structurally cannot enforce it and
unclaimed by the task that owns the endpoint. As planned, any party who can reach
`https://tasks.qelal.et/git-sync/` can rewrite repo↔project mappings and rule sets — which is
write access to every mapped Plane project and every connected repository. This is the same
defect class as original blocker 1, reintroduced at a different boundary by the fix that closed
blocker 6.

### B5 — the acceptance got weaker than the one it replaced

B5's acceptance is now *"Compiles PR lifecycle events into A6 rules cleanly."* Nothing decides
"cleanly". The acceptance it replaced — "Transitions states for PR lifecycle events without
entering triage" — named an observable outcome, and it was the only acceptance line in either part
that gated `triage` behaviour. Trading a decidable criterion for an adverb is a regression even
though the body improved.

B5 also still drops two §7.1 behaviours: "optional branch creation via the GitHub API" and
"optionally move the item to its started state when the branch name is copied or the branch is
first pushed". B5 covers only *"Formats branch names"*. No task in either part claims branch
creation, and Part B owns §7.1.

### B3, B9 — the two tasks that did not get blocker 3's treatment

Blocker 3 was fixed in B4–B7 and skipped in the two remaining tasks that touch A-side state:

- B3 `Depends: none` while owning the config API over A3's config tables. It cannot be built before
  the tables exist, and it is the one task that *writes* them.
- B9 `Depends: none` while implementing *"email-based user mapping requiring exactly one match"*
  against A3's user map, with §9's zero-or-several-matches outcome being "a loud audit-log
  failure" into A3's audit table.

B9 did correctly hand back the misplaced work: *"Rate-limit backoff belongs to A4's outbound
workers."* That resolves the first review's seam finding by assignment — but A4 still never
mentions rate limiting, so §4's "`outbound:plane` — rate-limited Plane API writes" and §9's
`X-RateLimit-Remaining` / `X-RateLimit-Reset` handling are now pointed at a task that does not
claim them. The §11 open item "Decide whether to raise `API_KEY_RATE_LIMIT`, and to what" remains
unresolved in both parts.

### B3 and B8 — overlapping ownership of the operational features

B3: *"It also exposes the interfaces for §7.6 operational features like dry-run, audit log with
replay, and backfill UI."* B8: *"Implements dry-run/simulate (using A6's no-write mode) ... it
provides an audit log (using A3's audit table) with manual replay for deliveries ... and a backfill
on connect."* Read generously these are client and server halves, and B8's file is server-side
(`src/operations/tooling.ts`) while B3's are `src/ui/*`. But neither task depends on the other and
both use the verb for owning the feature, so the API contract between them is unwritten. This is
the mildest of the findings here and would be closed by one `Depends:` edge plus a sentence.

### B7 — correctly absorbed the link-mutability problem

Recorded because it is the finding I expected to be hand-waved and was not. B7 now states
*"Since duplicate link URLs are rejected, rollups must be updated in place via `/links/{pk}/`,
retaining link ids and reconciling with A4"*, and fixed the preview-detection garble: previews
*"detected by provider (Vercel, Netlify, Cloudflare Pages, AWS Amplify) and markdown links ending
in \"Preview\". Title prefix is only for categorised links."* That is §7.4 read correctly.

---

## Fork surface: six files confirmed, and the spec is now the thing that is wrong

Part B reflects six. B1 lists three files — `apps/admin/app/(all)/(dashboard)/components/nav.tsx`,
`apps/admin/app/(all)/(dashboard)/routes/git-sync-iframe.tsx`, `apps/admin/app/routes.ts` — and
says *"We modify exactly three files (nav entry, route component, and route registry), limiting the
fork surface to six files total across both apps."* B2 lists the three `apps/web` equivalents and
*"maintaining the six-file fork limit across both apps."* Counted: six, iframe-only, no native
pages. Consistent between the two tasks.

**The spec still needs correcting, in two places.** §8 line 462 still reads "**Four files of fork
surface total.**" and the §11 risk row still reads "4 files, iframe-only; pin `APP_RELEASE`". B1
and B2 both cite §8 while contradicting its stated count, so the plan and its source of truth now
disagree in writing, and `scripts/verify-plan-part.mjs` cannot catch it — it checks only that a
cited section exists, never that the task agrees with it. Correct §8 and §11 to six files and three
per app, and keep the reason in the text (`apps/*/app/routes.ts` is an explicit React Router route
config, so a route cannot be added by dropping in a file).

Two things I could not settle offline and am not counting as defects. First, the driver verified
`apps/admin/app/routes.ts`; B2 assumes `apps/web` mirrors it, and §11 notes `apps/web` "moves
faster", so the six-file figure rests on an unverified assumption about the second app. Second, the
paths mix routing conventions: parenthesised segments like `app/(all)/(dashboard)/` are a Next.js
app-router route-group idiom, while an explicit `routes.ts` registry is React Router. Both can be
true at once only if those directories are ordinary folders. Integration should confirm both
against the actual fork tree before the six-file figure is written into the spec.

---

## Regression check

**Dependency graph: acyclic, verified edge by edge.** A1←none, A2←A1, A3←A1, A4←A2+A3, A5←A4,
A6←none, A7←A3+A4, A8←A4+A5+A6+A7; B1←none, B2←none, B3←none, B4←A4, B5←A6+A4, B6←A4+A3,
B7←A4+A3, B8←A6+A3+A2+A4, B9←none. No cycle, and every named dependency resolves to a task that
exists. A5's dependency moved from `none` to `A4`, which fixes the first review's finding that it
resolved identifiers against a client it did not depend on.

**Renumbering orphaned a live reference.** Part B's ids shifted by one from B3 onward, and the
meanings moved with them: old B3 (Smart Commits) is now B4, old B8 (ops) is now B9's neighbour B8,
and B3 is a new task. Consequences:

- `docs/plan/agent-gates/part-b.GATES.md:13` still attests *"all required sections (7.1, 7.2, 7.3,
  7.4, 7.6, 8, 9) are covered across B1 through B8."* Part B is B1–B9, and that sentence is now
  false as written — it is a manual gate whose human evidence no longer describes the artifact.
- `docs/plan/review-notes.md` (the first review) uses the old numbering throughout. Anyone reading
  it as current will map "B3 Smart Commits" onto today's B3, the React app. Integration should
  carry the mapping, or mark the first review as superseded by this one.
- The commit subjects use the new numbering, so `git log` for "B3" lands on the React app commit,
  not on the Smart Commits revision it is being read as.

**Acceptance decidability: one regression, two improvements.** B5's "cleanly" is the regression
(above). A6 and A8 both improved. B3's acceptance — *"Serves the config UI via two entry routes for
admin and workspace settings"* — is decidable but covers none of the config surfaces, operational
interfaces or authorization its body promises, so the largest new task has the thinnest gate.

**Section citations.** A7's citation is fixed (`§1.3`, correctly, where the first review found
`§4`). A4's `(§4)` for the Plane write semantics is wrong and should be `§3`. All other citations
in both parts resolve to real headings and match their task's content; I checked each against the
spec's heading lines. The joined parts cite every non-context spec section, so the branch coverage
oracle will not trip on citations — it will trip on the missing
`docs/plan/IMPLEMENTATION_PLAN.md`, which integration has yet to write.

**Part A's per-task commits are empty, and a green gate says otherwise.** *(Superseded — see
"Status after the driver's follow-up pass" below; recorded as found, because it is what drove the
fix.)* From
`git log --numstat`: `c7ed35a` ("A1: Setup deployment and container") adds all 57 lines of
part A — every task, A1 through A8 — and the seven commits that follow it (`005ecba` A2,
`1bb95e2` A3, `f73d4fc` A4, `b6a6bca` A5, `990e8c8` A6, `796d1c0` A7, `6ab5633` A8) change **zero
files each**. Part B's history is genuine by contrast: B1–B9 each add 7–12 lines to the part file
in their own commit. `docs/plan/agent-gates/commit-a.GATES.md:G2` nevertheless certifies "every
task in part A has its own distinct commit" with machine-written evidence, because
`scripts/verify-agent-commits.mjs` matches task ids in commit **subjects** and counts distinct
SHAs — it never asks whether a commit changed anything, or whether it touched the plan part. The
gate is green and its English claim is false. Part A's content is complete, so this is not a
content defect; it is a false completion certificate, and the per-task revert and bisect property
integration may rely on does not exist on the A side.

**The graders changed after the parts' gates were recorded.** `be27ddb` ("Fix citations") edits
four verifier scripts, including the spec-heading parser in `verify-plan-part.mjs` and
`verify-plan-coverage.mjs` and a new assigned-sections check. unlazy's evidence digest does not
hash a check's called scripts, so the evidence in `part-a.GATES.md`, `part-b.GATES.md` and both
`commit-*.GATES.md` was measured against older grader code. I therefore re-ran all four against
the current scripts rather than trusting it: `plan part verification passed (8 tasks, 11 spec
refs)` for Part A, `plan part verification passed (9 tasks, 7 spec refs)` for Part B, and
`agent commit verification passed` for both. The structural gates do still hold today. The
verifier edits themselves are strengthening, not weakening — the placeholder match going
case-sensitive is the first review's own recommendation.

---

## What I checked and found sound

- Every `Depends:` edge in both parts resolves and the graph is acyclic (derived above).
- Both parts pass `verify-plan-part.mjs` against the current scripts with their assigned sections,
  and the union of citations covers every buildable spec section.
- The single-write-path interface is stated in all four tasks that produce Plane writes, and the
  `triage` guard sits on that path rather than in a consumer.
- Field-granular `op_hash` survived the edit untouched in both A3 and A4, including "whole-object
  hashing must not be used".
- §7.2 attribution is intact and now complete: `sender` only, with the fallback extended to
  *"`ghost`, a bot, or unmapped"* and recorded in the audit log, plus the second mandatory guard
  — *"A config option requires `verification.verified == true` before honouring commands."*
- §7.3 shipping defaults are now carried in B6, and §1.3's deletion semantics are intact in A7.

---

## Status after the driver's follow-up pass

Re-checked against the repository as it stands now, because both the history and part B changed
underneath this review. Both blockers this review raised are addressed; one new defect, narrower
than either, came in with the fix.

**The commit-history blocker is RESOLVED.** Part A's history is rebuilt into eight real per-task
commits, each touching the plan part: `9a1eb85` A1 (+9 lines), `096ca33` A2 (+7), `8b3e7e3` A3
(+7), `45f2f9d` A4 (+7), `e23314a` A5 (+7), `6e24cd6` A6 (+7), `6513055` A7 (+7), `ac63391` A8
(+6) — 57 lines, the whole part. The rebuild changed no content:
`git diff HEAD -- docs/plan/part-a-service-core.md` is empty, the file is still 57 lines, and the
`X-Plane-Signature` line that closed blocker 1 is still present, so every adjudication above still
rests on the artifact it quoted. The old shas this review cited (`c7ed35a` plus the seven empty
commits) no longer exist. The oracle was tightened in the way this review asked for:
`scripts/verify-agent-commits.mjs` now runs `git show --numstat --format= <sha> -- <part>` per
candidate commit, stating its own reason — "A commit must not only name the task, it must actually
change the plan part. Subject-only matching certifies commit messages, not work." A subject-line
history can no longer pass it. Re-run against part A now: `agent commit verification passed`.

**The config-API authorization blocker is CLOSED.** Commit `7f5b30a` ("B3: authorize config API
server-side on every mapping write") puts the check where it can be enforced. B3 now reads
*"The config API validates the Plane session server-side on every request and re-checks workspace
role (admin/owner) on every write"*, and its acceptance changed from serving routes to the
decidable *"The config API rejects unauthenticated writes or users lacking admin/owner roles."*
B2's overreaching claim was withdrawn in the same commit: it now stops at *"checks workspace role
(admin/owner) before rendering (server-side gating of actual writes belongs to the config API)"*.
`d0dcf7c` then closed the related residual — B3 is `Depends: A3` with *"Its persistence is the A3
configuration tables."*

**New, and the reason the verdict does not flip: the instance-admin surface is gated by a
workspace-level role.** B3 serves both entry routes — *"two entry routes (instance-admin and
workspace-settings)"* — and states exactly one server-side rule for writes: *"re-checks workspace
role (admin/owner) on every write."* The instance-admin route is the surface §8 classifies as
"genuinely instance-wide" and lists as "GitHub App credentials: app id, private key, webhook
secret". A workspace admin or owner is not an instance admin; in Plane, workspace roles are held
per workspace by ordinary users. As written, any workspace owner who can reach the config API can
write the instance GitHub App private key and webhook secret — credentials that control the App
across every installation and every other workspace on the instance.

B1 does say *"This uses Plane's API for auth and role verification before managing global
settings"*, but B1's three files are fork-side client code
(`apps/admin/app/(all)/(dashboard)/components/nav.tsx`, the route component,
`apps/admin/app/routes.ts`) — the identical structural objection that B2 accepted and withdrew one
commit ago. Client-side verification in the admin fork cannot gate a write to our API. The fix is
the same shape as the one just applied: B3 must gate the instance-admin route on Plane's
instance-admin privilege, not on a workspace role, and B1 should hand that responsibility over the
way B2 now does.

**Unchanged residual.** B9 is still `Depends: none` while implementing *"email-based user mapping
requiring exactly one match"* against A3's user map, with §9's zero-or-several-matches outcome
landing in A3's audit log. The dependency graph is still acyclic after all four follow-up commits;
I re-derived every edge in both parts.

---

VERDICT: BLOCKING

- BLOCKER (now CLOSED by `7f5b30a` — see the status section; kept for the record): B3 owned the
  config API that accepts mapping and rule-set writes and specified no
  authentication or role check. §8 requires the workspace-role check "before rendering **or**
  accepting mapping writes"; B2 asserts both halves but its three files are fork-side client code
  that cannot gate a server endpoint on a different path. Authorization for every mapping write in
  the system is therefore owned by no task. Fix by moving the check into B3 explicitly: validate
  the Plane session server-side on every config API request and re-check workspace role on write.
- BLOCKER (now RESOLVED by the history rebuild — see the status section; kept for the record):
  `docs/plan/agent-gates/commit-a.GATES.md:G2` certified "every task in part A has its
  own distinct commit", but `c7ed35a` contained all of part A and the A2–A8 commits were empty
  (`git log --numstat` shows zero files changed for each). The gate passes only because
  `scripts/verify-agent-commits.mjs` reads commit subjects, not diffs. Either re-do part A's
  history as one commit per task, or withdraw the gate's claim; and tighten the verifier to require
  that each task's commit actually modifies the plan part, since as written it certifies subject
  lines.

- BLOCKER: B3's only server-side authorization rule is "re-checks workspace role (admin/owner) on
  every write", but B3 serves both entry routes, and the instance-admin route writes the §8
  instance-wide settings — "GitHub App credentials: app id, private key, webhook secret". A
  workspace-level role therefore authorizes writing credentials that control the GitHub App for
  every workspace on the instance. B1's countervailing claim of "auth and role verification" is
  fork-side client code, which is the objection B2 conceded in `7f5b30a`. Gate the instance-admin
  route on Plane's instance-admin privilege.

All seven original blockers remain closed. Of the two this review raised, both are now fixed in
the artifacts; the one blocker left is the privilege-scope defect introduced by the authorization
fix itself, and it is a one-sentence change to B3.
