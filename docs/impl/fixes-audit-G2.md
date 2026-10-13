# G2 documentation audit fix pass

Acceptance gates (written before implementation):
- G5: build aggregation consumes all current check-run pages and fails closed beyond the 1,000-suite endpoint ceiling.
- G7/G9: association reads paginate; readiness and fork CI verify current linked PR heads and repository identity.
- G8: compare ranges report completeness at a deliberate 10,000-commit bound, preserve order, deduplicate, and audit truncation.
- G11: CI, branch and fallback deployment links retain the GitHub server's web origin.
- G15: stage changes retain their lifecycle event and reevaluate current readiness afterwards, including continuations (PR caller owned by G3).
- G16: bounded readiness reads fail closed; bounded backfill reports partial progress with a resumable cursor.
- Regression coverage is written in `tests/github/audit-g2.test.ts`; no tests are executed.
- Only assigned files and this required report are edited. No staging, commit or push.
- CHECK: `node scripts/typecheck.mjs src/app/checks.ts src/app/push.ts src/github/pr-automation.ts src/github/smart-commits.ts src/operations/tooling.ts tests/github/audit-g2.test.ts`
  EXPECT: exit 0 and `typecheck passed`.

## Results by finding

The audit uses headings A5/A7/etc.; the driver brief names the same findings G5/G7/etc.

| Finding | Implementation | Regression coverage (written, not executed) |
|---|---|---|
| G5 | `src/app/checks.ts:134` paginates all current check runs with explicit `filter: latest`. It first reads suites and refuses aggregation above the documented 1,000-suite ceiling, recording `build_incomplete`; incomplete run reads throw before any rollup/rule write. | `tests/github/audit-g2.test.ts:53` places a failure on page two; `:72` covers 1,001 suites and asserts no passing rollup. |
| G7 | `src/app/checks.ts:81` completely paginates commit associations. `:89` also enumerates active locally linked PRs, fetches each current PR through the base installation, and checks exact SHA/base identity. `:126` additionally requires open, non-draft, unmerged state for readiness. Deployment association at `:166` deliberately retains GitHub's introducing/associated-PR semantics, including merged PRs; it does not claim all historical PRs containing the commit. | `tests/github/audit-g2.test.ts:84` covers a linked open PR omitted by association, wrong SHA, and wrong base; `:98` covers a deployment PR beyond page one. |
| G8 | `src/app/push.ts:65` reads compare pages beyond the previous 3,000 cutoff, up to the explicit 10,000-commit bound, returning `{ items, complete, nextPage }` and deduplicating in chronological order. `src/github/smart-commits.ts:252` consumes completeness, audits partial ranges explicitly, and avoids falsely calling an exact complete 10,000 range truncated. Payload/compare comments now say 2,048 webhook commits and 100 per page. Legacy injected array adapters remain accepted as complete inputs for compatibility. | `tests/github/audit-g2.test.ts:140` covers 3,101 and 10,001 commits; `:172` covers partial metadata/audit and duplicate commands; `:181` covers exactly 10,000 complete commits. |
| G9 | `src/app/checks.ts:134` resolves empty fork payload associations through complete association reads plus current locally linked PR heads. Base and supplied head-repository identities are checked before build writes or suite rules. `:195` restores base/head branch, labels, and PR template context from the verified PR, including fork suite payloads with no head branch. The same supplied head-repository check applies to readiness. | `tests/github/audit-g2.test.ts:53` covers an empty fork PR array and a base-branch suite rule; `:111` rejects the wrong fork head repository. |
| G11 (owned parts) | `src/github/pr-automation.ts:271` resolves repository web URLs from verified webhook/API repository identity and HTML URLs, with configured API-origin fallback for synthetic paths. `src/app/checks.ts:155` and `:173` use that web URL for CI/deployment fallback links; `src/app/push.ts:96` uses it for branch links. | `tests/github/audit-g2.test.ts:53`, `:98`, `:121`, and `:131` cover GHES CI, deployment, branch and API-resolved URL paths. Browser lookup remains G5's ownership. |
| G15 | `src/github/pr-automation.ts:298` exposes `shouldReevaluatePrReadiness()` for approval and ready-for-review/reopened stage changes. Lifecycle translation keeps stage events distinct; synthetic readiness now checks open state as well as draft/merged guards. G3 has already added caller reevaluation after lifecycle rules at `src/app/pr.ts:346`, and the same reevaluation in fenced continuations at `:419`; G2 did not edit that file. | `tests/github/audit-g2.test.ts:255` covers lifecycle preservation and closed guards; `:265` covers live ready-for-review/reopen, once-per-head and created-item continuation; `:287` covers a delayed stage delivery after the current PR returned to draft. |
| G16 | `src/github/pr-automation.ts:245` returns explicit completeness/next-page metadata at bounds and follows Link/total-count evidence even on short pages, uses the actual fetched count, and fails closed when headers contradict the total. `:304` refuses readiness for incomplete review/suite reads. `src/operations/tooling.ts:197` defines a backfill cursor, `:202` reads lists with explicit bounds, and `:249` consumes/returns independent PR/issue cursors; `:265` records `partial` rather than `done` when unfinished. | `tests/github/audit-g2.test.ts:198` covers Link/total pagination evidence; `:215` covers 2,001 reviews/suites and the complete positive control; `:234` covers 5,000-item partial backfill and cursor resume to item 5,001. |

## Driver relays and shared contracts

- G4 relay implemented at `src/github/smart-commits.ts:172`: `UnknownPlaneState` (including a preserved Error name) is permanent, like the triage rejection. `tests/github/audit-g2.test.ts:188` covers a failed state write that finishes and does not retry on another delivery.
- G1 classifier is imported; the combined-status catch uses it instead of local status/header classification. Signature-verification throttling is rethrown intact at `src/github/smart-commits.ts:331`, so G1's queue/outbox mechanism retains its full retry deadline. Tests at `tests/github/audit-g2.test.ts:223` and `:299` cover headerless secondary limits and signature throttling. No sleeping was added.
- **Exact G5 integration change for resumable backfill:** in `src/ui/api.ts`, change the `/mappings/:id/backfill` handler destructuring from `{ res, slug, params }` to `{ res, slug, params, body }`, and add `...(body?.cursor !== undefined ? { cursor: body.cursor } : {})` to the `backfill()` arguments. The function validates positive integer/null pages; missing fields are rejected. Return/send the existing result so callers retain `complete: false` and `cursor`. The UI can send `{ cursor: previousResult.cursor }` to continue. This file is outside G2 ownership and was not edited; the request was relayed in commentary.
- `readPrReviews()` is exported for G3's review-rollup sharing. G3 currently has its own complete `listPrReviews()` reader in `src/app/pr.ts`. If the driver consolidates readers, retain its rollup failure handling and use `readPrReviews()` for the underlying read; no out-of-row edit was made.
- Legacy CI/readiness fixtures that supplied only webhook or association PR snapshots must now also mock `GET /repos/{owner}/{repo}/pulls/{pull_number}` with the current `number`, `head.sha`, and state. Build fixtures must supply the suite collection too. Production responses have these fields; accepting an unverified snapshot as a live head would defeat G7/G9. G2's new regression fixtures include those reads. Changes to other test files are the driver's ownership.
- No schema or spec wording change is needed. No assigned source fix is deferred. Cross-owner route/UI integration and consolidation are explicitly identified above.

## Context7 evidence

Fetched with `npx ctx7@latest docs` against `/websites/github_en_rest` and `/websites/github_en`; no API behavior was inferred from memory.

- [Check runs](https://docs.github.com/en/rest/checks/runs): 100 per page, `filter=latest`, and the most recent 1,000-suite limitation.
- [Check suites](https://docs.github.com/en/rest/checks/suites): paginated `check_suites`/`total_count`; fork pushes may supply no associated PRs/head branch.
- [Commit comparison and associations](https://docs.github.com/en/rest/commits/commits): chronological paginated compare and introducing-PR semantics for commits on the default branch.
- [Reviews](https://docs.github.com/en/rest/pulls/reviews) and [pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api): chronological reviews, `per_page`, and Link next pages.
- [Pull requests](https://docs.github.com/en/rest/pulls/pulls): open list paging with `sort=created`/`direction=asc`.
- [GHES URLs](https://docs.github.com/en/apps/sharing-github-apps/making-your-github-app-available-for-github-enterprise-server): custom REST base/web URL distinction.
- [Rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api): message-only secondary limits and server deadlines.

## Verification and scope

Final allowed check:

```text
node scripts/typecheck.mjs src/app/checks.ts src/app/push.ts src/github/pr-automation.ts src/github/smart-commits.ts src/operations/tooling.ts tests/github/audit-g2.test.ts
typecheck passed (43 project files)
```

All assigned source outcomes were reviewed against the original findings. Nineteen regression tests were written; **none were run**. The driver owns test execution and any fixture changes outside this row. The only check executed was the requested typecheck. Edits were limited to the five assigned source files, `tests/github/audit-g2.test.ts`, and this required report. No staging, commit, or push was performed.

## Round 2

Acceptance gates before implementation:
- Deployment rollups compare deployment creation/id, then status creation/id within that deployment; stale and duplicate statuses cannot register newer rollup replacements or rules. Ordering is durable and serialized.
- Historical Smart Commit commands retain original source, actor, resolved target/write and operation identity across transports/retries.
- Readiness uses `readPrReviews()`, reads past page 20, and rejects explicitly incomplete review reads.
- Only affected CI/readiness fixture setup is changed in the additionally authorized existing test files.
- Add regression cases to the existing G2 audit test file; execute typecheck only, never tests/staging/commit/push.

Round 2 results (these supersede the earlier fixture handoff and affected line references):

| Finding / request | Change | Regression coverage written in `tests/github/audit-g2.test.ts` |
|---|---|---|
| A10 deployment ordering | `src/app/checks.ts:186` extracts deployment/status IDs and creation timestamps. `:203` orders deployments first, then statuses within the same deployment; creation time wins, IDs break ties or supply ordering when time is absent, and an identical source ID is a duplicate. String IDs use `BigInt` without precision loss. `:210` serializes in process and through the existing cross-replica object lock. `:223` reserves the newest version durably in `audit_log` before registering writes, retaining the fence on partial failures; a pending identical version can retry, a registered duplicate is ignored. `:239` applies the guard to deployment and preview rollups, skips stale rules, and gives registrations a stable status scope. Shared preview keys have their own fence across environments. Deployment link errors propagate after audit so the pending version can retry. | `:315` covers old status, old deployment, duplicate transport, timestamp/ID tie-breaking and large IDs; `:340` covers failure/retry fencing; `:359` covers concurrent deliveries; `:436` covers an older deployment in another environment attempting to replace a shared preview URL. |
| A10 historical Smart Commit identities | `src/github/smart-commits.ts:383` retains the original command grammar, commit URL, authenticated actor identity, mapping authority and original logical delivery scope under an immutable workspace/SHA source identity. `:453` retains each resolved issue target. `:408` retains the exact write and actor owner under a SHA/command-position/key identity before registration. Retries reload that snapshot, reuse the original scope and reset occurrence counters, preserving the outbox ID even after a changed transport, actor, URL, target lookup or state list. PATs are reloaded for the original owner and never stored in the snapshots; a revoked original actor credential fails permanently. Existing SHA/step audit IDs and explicit replay recovery remain supported. | `:372` covers a pending command with changed grammar, actor, URL, target and state list; `:392` covers a crash-like receipt audit failure after durable registration and proves another transport leaves one intent. |
| G6/G16 complete readiness reviews | `src/github/pr-automation.ts:292` remains the single review reader used by `checkPrReadiness()`, now reading through page 20 rather than stopping there. Its deliberate 100-page safety bound returns `complete: false`; readiness requires complete reviews and suites before evaluating any decision. Nothing at a bound is reported as a full read. | `:411` places a change request on page 21; the existing G16 incomplete-read test (`:218`, after Round 2 import additions) remains the fail-closed boundary case and includes a complete positive control. |
| G4 relay, item 3 in “Diffs for the driver” | `src/github/smart-commits.ts:178` recognizes an already resolved Plane deadline directly, with the shared classifier for other throttles. The pending write, issue lookup and state-read branches retain the largest deadline; `:364` throws `PlaneRateLimitError` carrying that deadline instead of a plain `SmartCommitRetry`. `requestMade: false` survives when every pending operation was refused before a request, preserving G1's attempt-budget behavior. No sleep was introduced. | `:422` covers multiple command deadlines and budget-only deferral; the parameterized cases at `:453` cover lookup and state-read throttling. |

Existing fixture updates are limited to setup/instrumentation in the additionally authorized files:

- `tests/app/ready-for-merge.test.ts`: current PR resource, complete paged reviews/suites, combined status and empty run collection.
- `tests/app/fixes-r3.test.ts`: current PR/status resources, collection totals, and review-read instrumentation to distinguish readiness from the suite read now required for build completeness. Assertions retain their original behavioral meaning.
- `tests/a8/reducers.test.ts`: current PR head/base, association collection, suite/run totals, and documented deployment/status IDs and creation timestamps.
- `tests/a8/rule-events.test.ts`: current PR head/base, association/review/status collections, suite/run totals, and deployment/status metadata.
- `tests/a8/fixes-r2.test.ts`: current PR/status reads for readiness and current head/collections for CI.
- `tests/app/review-r5-ca.test.ts`: current PR and complete suite/run fixtures for the cross-project checks path.
- `tests/app/review-r6-cd.test.ts`: current PR/suite/run fixtures and deployment ordering metadata.
- `tests/github/review-r5-cb.test.ts`: current PR resource for status-read recovery.

`src/app/checks.ts:143` now filters out PRs without linked rollup targets before requesting CI suites/runs, so the no-linked-item fixture still makes no readiness or build aggregation reads. No existing test assertions were removed or changed by G2. Other agents' existing changes in the shared workspace were preserved.

Context7 was queried again for this round using `/websites/github_en_rest` and `/websites/github_en`: [deployment status semantics](https://docs.github.com/en/rest/deployments/statuses), [deployment ID/creation timestamp response](https://docs.github.com/en/rest/deployments/deployments), [deployment-status webhook payload](https://docs.github.com/en/webhooks/webhook-events-and-payloads#deployment_status), and [commit object identity/message](https://docs.github.com/en/rest/git/commits). The previously fetched review/pagination documentation remains the basis for the complete reader. No new Plane endpoint behavior was assumed; the Plane deadline relay uses G4's provided error contract.

Final Round 2 check:

```text
node scripts/typecheck.mjs src/app/checks.ts src/github/pr-automation.ts src/github/smart-commits.ts tests/github/audit-g2.test.ts tests/app/ready-for-merge.test.ts tests/app/fixes-r3.test.ts tests/a8/reducers.test.ts tests/a8/rule-events.test.ts tests/a8/fixes-r2.test.ts tests/app/review-r5-ca.test.ts tests/app/review-r6-cd.test.ts tests/github/review-r5-cb.test.ts
typecheck passed (65 project files)
```

Round 2 adds ten regression cases (including the two parameterized Plane-read cases). All requested outcomes were implemented and reviewed; no Round 2 source fix or fixture update is deferred. **No tests were run.** Only the named source files, authorized fixture files, existing G2 audit tests, and this report were edited. No staging, commit or push was performed. Existing cross-owner backfill route/UI notes from Round 1 remain the driver's integration responsibility.

## Test phase

Failure: `tests/app/fixes-r2.test.ts:59`, “F14: a push as large as GitHub's payload limit is completed from the compare API through the installation client” expected zero truncation audits and got one.

Classification: **outdated fixture exposed by audit A8/G8, not a source regression**. The fixture returned the entire 2,053-commit comparison for every numbered page, without `total_commits` or an end-of-pagination signal. Under the audit fix's complete-read contract this was an endless collection, correctly reported incomplete at the adapter's safety bound.

Changed only this test at `tests/app/fixes-r2.test.ts:66`: the compare mock now supplies `total_commits` and slices the requested 100-commit pages. The zero-truncation assertion remains unchanged. The test additionally checks the exact 21-page sequence and 100-per-page requests, and puts a Smart Commit command after the webhook's 2,048-commit limit, asserting its single comment and durable processed-SHA claim. This preserves and strengthens the original proof that the installation adapter completes the webhook range. No production source change was needed.

Authorized capped test command:

```text
NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/app/fixes-r2.test.ts
```

Result: **5 passed, 0 failed, 0 cancelled, 0 skipped**; process exit 0. Only the listed test file was executed. `node scripts/typecheck.mjs tests/app/fixes-r2.test.ts` also passed. No staging, commit or push was performed.
