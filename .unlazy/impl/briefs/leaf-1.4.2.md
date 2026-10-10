# Leaf brief: leaf-1.4.2 — B4 Smart Commits, B5 PR automation, B6 mirroring, B7 dev info, B8 operations (implementer B, wave 4)

Read `.unlazy/impl/briefs/COMMON.md` first. Your ledger: `docs/impl/agent-gates/leaf-1.4.2.GATES.md`.

## OWNS

    src/github/**, src/sync/mirror.ts, src/sync/dev-info.ts, src/operations/**, src/ui/**,
    tests/github/**, tests/sync/mirror*.test.ts, tests/sync/dev-info*.test.ts, tests/operations/**,
    tests/ui/**, docs/impl/agent-gates/leaf-1.4.2.GATES.md

Implementer A works concurrently on `src/parse/**` (A5: `parseReferences`, `allLinkedPrsMerged`,
`resolveReferences`), `src/sync/reconcile.ts`, `src/queue/**` and `src/db/**` (adding
`audit_log.workspace_slug`, audited inbound deliveries with `detail.payload`, and
`upsertDevInfoLink` / `getDevInfoLink`). Use those interfaces as specified in
`.unlazy/impl/briefs/leaf-1.4.1.md`; if one is not there yet, wait for it rather than writing your
own. Do **not** touch `src/index.ts` (wave 5 wires every reducer).

**Every Plane write goes through A4's `PlaneWritePath.apply`** and every GitHub write through
`GithubWritePath.apply` (`src/sync/plane.ts`, `src/sync/github.ts`) — never `fetch` or Octokit
directly for writes. That keeps the echo ledger authoritative and the triage ban in one place.

## Driver gates (copy into your ledger exactly)

    - [ ] G1: B4-B8 pass the driver oracle
      CHECK: node scripts/verify-b4-b8.mjs
      EXPECT: B4-B8 verification passed
      EVIDENCE: pending

    - [ ] G2: B3 config API and UI did not regress
      CHECK: node scripts/verify-b3-config-api.mjs
      EXPECT: B3 config API verification passed
      EVIDENCE: pending

    - [ ] G3: own tests run, at least 60 passing, none skipped
      CHECK: node scripts/run-tests.mjs 60 tests/github tests/operations tests/ui
      EXPECT: tests passed
      EVIDENCE: pending

    - [ ] G4: typecheck clean
      CHECK: node scripts/typecheck.mjs "src/github/**/*.ts" "src/sync/mirror.ts" "src/sync/dev-info.ts" "src/operations/**/*.ts" "src/ui/**/*.ts" "src/ui/**/*.tsx" "tests/github/**/*.ts" "tests/operations/**/*.ts" "tests/ui/**/*.ts"
      EXPECT: typecheck passed
      EVIDENCE: pending

    - [ ] G5: no stubs or placeholders
      CHECK: node scripts/verify-no-stubs.mjs src/github src/sync/mirror.ts src/sync/dev-info.ts src/operations src/ui tests/github tests/operations
      EXPECT: stub scan passed
      EVIDENCE: pending

Read `scripts/verify-b4-b8.mjs` in full first; it pins the exact export names and shapes. Return
plain objects that omit absent optional fields (the oracle uses deep strict equality).

## B4 — Smart Commits (spec §7.2, §5, §9) — `src/github/smart-commits.ts`
Exports: `parseSmartCommits(message)`, `durationToMinutes(raw)` (Jira defaults 1w = 5d, 1d = 8h;
decimals allowed; garbage throws), `resolveTransition(states, token)` → `{ok:true,stateId}` |
`{ok:false,reason:"not_found"|"ambiguous"}` (case-insensitive; spaces↔hyphens; exact full
hyphenated name wins over prefixes), `processPush(payload, deps)`.
- Grammar `<ignored> KEY… <ignored> #cmd args`; several keys and commands per line; a command
  never spans lines; a line without a key yields nothing. Commands: `#comment <text>`,
  `#time <duration>` (Plane CE has no worklog API, so it becomes a comment stating the logged
  time), `#<transition>`.
- Attribution **from `sender` only** via B9's `resolveActor`; mapped user with a stored PAT in
  `deps.vault` → write with `actorToken`; ghost/bot/unmapped → service identity **and** an audit row
  (kind containing `identity_fallback`). Never read `pusher` or commit author/committer fields.
- Once per SHA via A3's `claimCommit` (SHA alone), before acting. Per-repo toggle
  (`deps.mapping.smartCommitsEnabled`); `deps.requireVerified` with `deps.getCommitVerified(sha)`
  (push payloads do not carry `verification`, so it is fetched).
- A transition whose state does not exist (or is ambiguous) is a loud audit failure (error text
  names the transition) and does not stop the line's other commands or other keys. States come from
  `deps.listStates(projectId)`; issues from `deps.resolveIssue(key)`.

## B5 — PR and branch automation (spec §7.1, §7.5) — `src/github/pr-automation.ts`
Exports: `QLL_DEFAULTS` (the §7.1 table: branch pushed/drafted/opened → In Progress, review
requested → In Review, approved → no change, merged with base `main` → Done, closed unmerged → no
change), `compileLifecycleRules(mapping)` → YAML that A6's `parseRules` accepts (branch rules first,
then lifecycle rules; this is the "presentation sugar compiles to rules" requirement — no second
evaluator), `prEventToRuleEvent(event, payload)` → A6 `RuleEvent` (`pull_request` opened/draft →
drafted/opened, review_requested, ready_for_review → opened, closed+merged → merged, closed → closed_unmerged,
reopened; `pull_request_review` submitted approved/changes_requested; base/head branch, labels,
author, repo filled in), `resolveStateTarget(states, target)` with target syntax `group`,
`group:Name` or `Name` — group first, name as fallback (§7.1: never by name alone across
projects), and `createRuleExecutor({ writer, listStates, issues })` → A6 `ActionExecutor` applying
each action to every linked issue through A4 (so A4's `TriageWriteRejected` propagates). Use A5's
`allLinkedPrsMerged` before applying a merged-state transition (§6).

## B6 — two-way issue mirroring (spec §7.3, §9) — `src/sync/mirror.ts`
Exports: `defaultPolicy(field)`, `shouldApply({ field, from, policy, direction })`,
`onGithubIssue(payload, deps)`, `onPlaneIssue(job, deps)`. Label `plane` on a GitHub issue →
create the Plane item (through A4), upsert a `sync_links` row with `created_by: "label_sync"`, post
a cross-link comment on GitHub; label `github` on a Plane item → the reverse. Auto-create the
gate labels on the target (A4's `upsert_label`). Sync title, description, state, assignees,
labels, comments under the mapping's direction and per-field policy (stored in
`conflict_policies`, defaults per §7.3). Assignees map through `user_map`; unmapped users leave the
field empty.

## B7 — development information (spec §7.4) — `src/sync/dev-info.ts`
Exports: `prRollupTitle(pr)` (PR `OPEN|MERGED|DECLINED`, review `REVIEW|APPROVAL|REJECTED`),
`buildStatus(runs)` (`pass` if all passed, `fail` if any failed, else `pending`),
`detectPreviews({ environmentUrls, body })` (Vercel `*.vercel.app`, Netlify `*.netlify.app`,
Cloudflare Pages `*.pages.dev`, Amplify `*.amplifyapp.com`, and markdown links whose text ends
with "Preview"), `categorisedTitle(category, text)` → `[Category] text`, and
`upsertRollupLink({ db, writer }, target, key, { title, url })` — first time `add_link` and store the
returned id with A's `upsertDevInfoLink`; afterwards `update_link` with the stored id (duplicate
URLs are rejected by Plane, so rollups must update in place). Autolinks stay off by default.

## B8 — operational features (spec §7.6) — `src/operations/tooling.ts` + config API + UI
Exports: `dryRun({ rulesYaml, event, payload })` → `{ actions, dryRun: true, matched }` using A6's
`run(..., { dryRun: true })` and B5's `prEventToRuleEvent` — no writes; `replayDelivery({ db,
enqueue }, auditId)` → reads the audited `inbound_delivery` row, enqueues `{ source, event, payload }`
under a **fresh** delivery id (e.g. `replay-<auditId>-<timestamp>`; reusing the original would be
dropped by the duplicate ledger) and appends an audit row with `replayOf` → `{ auditId }`;
`backfill({ db, github, mapping, resolveIssue })` → lists open PRs and issues
(`github.request("GET /repos/{owner}/{repo}/pulls", …)` / `…/issues`), parses references with A5,
and upserts `sync_links` (PRs `gh_kind: "pr"`, issues `"issue"`, tier from the parse) →
`{ linked }`. Add config API endpoints in `src/ui/api.ts` (same auth and CSRF rules as B3):
`POST /git-sync/api/workspaces/:slug/dry-run`, `POST .../audit/:id/replay`,
`POST .../mappings/:id/backfill`, and the matching UI screens.
