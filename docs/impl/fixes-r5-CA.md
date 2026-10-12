# CA — review 5 fixes

Implemented F4, F5, F6 in CA-owned source/tests, plus the F1 replay seam relayed by the driver.
Changed `src/app/pr.ts`, `src/app/rules.ts`, and `tests/app/review-r5-ca.test.ts`.
`src/app/issues.ts` required no change. Added the requested CA gate ledger and this report.
No staging, commits, pushes, or changes to another agent's files.

## F4 — orphaned PR-created partners can be replaced

- `src/app/pr.ts:70` joins the successful request audit to its actual workspace/project PR link.
  An active partner remains guarded; only a confirmed orphan permits a replacement. A missing
  link does not establish remote absence. Repeated original delivery identities remain guarded
  even after orphaning, so replacement requires a new request.
- `src/app/pr.ts:87` retains CC's shared generation/recovery policy. `src/app/pr.ts:95` supplies
  a stable distinct replacement identity from the orphan's retained audit when retention has
  pruned the completed workflow. PR reducers serialize by workspace/repository/number at
  `src/app/pr.ts:160`.
- Proof: `tests/app/review-r5-ca.test.ts:76` runs an actual create, `reconcileOnce` orphaning,
  old-delivery replay, new request, pending duplicate replay and completed duplicate replay.
  `tests/app/review-r5-ca.test.ts:103` also prunes the old workflow and verifies a different
  external create identity and exactly one replacement.

## F5 — same-workspace cross-project targets follow the PR

- `src/app/pr.ts:224` restores active PR targets across the mapping's workspace, regardless
  of default project, and deduplicates them against parsed references.
- `src/app/rules.ts:105` includes those targets in readiness and check/deployment rule lookup;
  issue mirrors retain their existing project restriction. `src/app/rules.ts:45` deduplicates
  targets, filters their workspace and evaluates ordered rules per actual target project.
- Proof: `tests/app/review-r5-ca.test.ts:138` creates `WEB-NEW` through a QLL mapping using the
  real outbox, then sends approval, check-suite and merge events. It verifies readiness/check
  comments, Done and MERGED rollup in WEB, and rejects the QLL-specific rule. A foreign-workspace
  control verifies lifecycle/readiness target isolation.

## F6 — pending creates retain later lifecycle events

- `src/app/pr.ts:164` registers each later event as a result-bound, durable target continuation
  in the pending create's group. Its predecessor follows the latest continuation, including
  the original create continuation. This applies both before linking and while the original
  continuation is still pending after linking.
- `src/app/pr.ts:235` fences after generation lookup, including any workflow it revives.
  `src/app/pr.ts:292` runs each saved event's target rules and rollup, with linkback only for
  the original create; approval readiness follows the approval rules.
- Proof: `tests/app/review-r5-ca.test.ts:174` queues opened, edited, duplicate edited replay,
  approved and merged before draining. It verifies durable event identities, once-only rules,
  In Progress → In Review → Done, edited-title rollup, final MERGED rollup and marker cleanup.
  `tests/app/review-r5-ca.test.ts:208` verifies the post-link/pre-original-continuation race.

## F1 seam — restored original continuations remain once-only

- `src/app/pr.ts:173` checks existing continuations by job source and
  `COALESCE(writeDeliveryId, deliveryId)`. It marks any saved created issue as owned and avoids
  appending another continuation when the same original event is already registered.
- Proof: `tests/app/review-r5-ca.test.ts:50` fails the actual PR create continuation permanently,
  calls CC's `replayDelivery`, and asserts unchanged workflow IDs, preserved successful create
  result, a revived pending continuation, one rule comment and one linkback after draining.

## Verification

Final source typecheck exited 0: `typecheck passed (43 project files)`.

```sh
node scripts/typecheck.mjs src/app/pr.ts src/app/issues.ts src/app/rules.ts tests/app/review-r5-ca.test.ts
NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/app/review-r5-ca.test.ts tests/app/pr-new-plan.test.ts
```

Final capped test run exited 0: **7 tests passed, 0 failed**, including the existing PR plan test.
No oracles, heavy.sh, gate-check, gate-lint, or whole suite ran. The runnable evidence fields in
`docs/impl/agent-gates/fix-r5-CA.GATES.md` remain pending for the driver's checker; all four
declared outcomes passed the directly executed permitted checks.

## Driver handoffs outside CA ownership

1. `src/app/checks.ts:18`: its existing `linkedTargets` rollup query lacks workspace isolation.
   Exact required change: append `AND plane_workspace_slug = $3` to its SELECT and pass
   `[mapping.ghRepoId, number, mapping.workspaceSlug]`. This protects check/deployment rollups.
   CA's F5 test verifies foreign-workspace isolation through owned lifecycle/readiness lookup,
   then removes that control link before invoking the unowned checks rollup path. That external
   query change was relayed in commentary and remains driver-owned.
2. An earlier permitted three-file run included `tests/github/review-r4-sc.test.ts`.
   Its F8 tests at lines 72 and 84 failed because their NULL-installation mappings are now
   rejected by CD's deliberate F3 authorization fix before installation lookup. The first
   expected a throttled lookup rejection; the second expected `github_not_installed` rather
   than the new mapping-authority audit. Update those fixtures to verified mappings if they
   must exercise execution-time lookup, or assert disabled-mapping behavior. CA did not edit
   that unowned file. The earlier PR query-cast regression was corrected and the final two-file
   run above passed.
