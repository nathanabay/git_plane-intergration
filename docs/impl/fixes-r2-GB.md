# Round-2 fixes — implementer GB

## F3 Read-modify-write of Plane label/assignee lists against a queue
- **Problem:** In `src/github/pr-automation.ts`, `createRuleExecutor` re-fetched remote fields (`getIssueFields`) on every action execution (`add_label`, `remove_label`, `assign`). Because outbound writes to Plane are queued asynchronously, successive actions within a single rule execution (or event) re-read stale remote state before queued writes landed, causing earlier label/assignee additions on the same item to be overwritten by later actions.
- **Fix:** In `src/github/pr-automation.ts`:
  - When the writer exposes `deps.writer.mutateIssue(target, { kind: 'add_label' | 'remove_label' | 'assign', id }, opts)` (provided by `OrderedOutbox` via CB's F6 implementation), `createRuleExecutor` routes `add_label`, `remove_label`, and `assign` directly to `deps.writer.mutateIssue`. This ensures the read-modify-write occurs under the worker's FIFO target lock, preventing race conditions against delayed or concurrent writes.
  - When running against raw test writers without `mutateIssue`, `createRuleExecutor` falls back to maintaining an in-memory `fieldsCache` keyed by `${issue.slug}/${issue.projectId}/${issue.issueId}` across action executions for the lifetime of the executor. The first field lookup initializes the cache from `getIssueFields`; successive actions update the local cached state in memory and emit the full accumulated array in `update_issue`.
- **Note on mirror/issues sync:** Cases (b) and (c) noted in review-2 reside in `src/sync/mirror.ts` (owned by CB) and `src/app/issues.ts` (owned by SA). Within GB's OWNS, the rule executor routes through `mutateIssue` when available and falls back to `fieldsCache`.
- **Tests:** `tests/github/pr-automation.test.ts` "F3: successive add_label actions within an executor retain all labels (no queued-read clobber)" and "F3: createRuleExecutor routes add_label, remove_label and assign through writer.mutateIssue when provided"; and CB's `tests/writers/compound.test.ts` (passes end-to-end).

## F7 ready_for_merge firing logic
- **Stable signature for SA wiring:**
  ```typescript
  export async function checkPrReadiness(
    octokit: { request<T = any>(route: string, params?: Record<string, unknown>): Promise<{ data: T }> },
    repo: { owner: string; repo: string },
    prNumber: number,
    headSha: string
  ): Promise<boolean>
  ```
  Also exported: `isReadyForMerge(reviews: ReviewSummary[], checkSuites: CheckSuiteSummary[]): boolean`.
- **Problem:** `prEventToRuleEvent` relied on non-existent fields (`pr.approved`, `pr.review_state`, `pr.reviews`, `mergeable_state`, `checks_passed`, `check_suites`) and invented action cases (`auto_merge_enabled`, `ready_for_merge`). Auto-merge enabled can be set before approvals or green checks (even on draft PRs), incorrectly triggering lifecycle transitions prematurely.
- **Fix:**
  - Removed invented `case "auto_merge_enabled"` and `case "ready_for_merge"` from `prEventToRuleEvent`.
  - Removed payload heuristics (`isPrApproved`, `allCheckSuitesPassed`).
  - Added and exported `isReadyForMerge(reviews, checkSuites)`: requires all check suites to be completed with `success` or `neutral` (>= 1 suite), and latest actionable review per reviewer (`APPROVED`, `CHANGES_REQUESTED`, `DISMISSED`) to have >= 1 `APPROVED` and zero `CHANGES_REQUESTED`.
  - Added and exported `checkPrReadiness(octokit, repo, prNumber, headSha)` to fetch actual GitHub reviews (`GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews`) and check suites (`GET /repos/{owner}/{repo}/commits/{ref}/check-suites`).
  - Updated `prEventToRuleEvent(event, payload, options?: PrRuleEventOptions)` to emit `pull_request.ready_for_merge` only when readiness is verified, and never for draft or merged PRs. On standard payloads without pre-evaluated readiness, review approvals emit `pull_request.approved`.
- **Tests:** `tests/github/pr-automation.test.ts` "F7: isReadyForMerge requires all check suites passed and latest review per reviewer approved", "F7: checkPrReadiness queries GitHub reviews and check-suites endpoints", and "F7: prEventToRuleEvent emits ready_for_merge only on verified readiness, not auto_merge_enabled".

## F11 Stale embedded mapping comment divergence detection
- **Problem:** `parseLifecycleMappingFromYaml` parsed the `# gitsync-lifecycle-mapping:` comment anywhere in the YAML without checking whether the YAML body had been modified by hand. Hand-written custom rules were silently hidden on UI reload and lost upon saving the table.
- **Fix:**
  - Implemented `computeYamlHash(text)`: computes a deterministic hash of the compiled YAML body.
  - In `compileLifecycleRules`, embeds the body hash inside the `# gitsync-lifecycle-mapping: {"hash": ...}` comment.
  - In `parseLifecycleMappingFromYaml`, verifies that the YAML body without the comment hashes to `data.hash`. If diverged or manually edited, returns `null` so the UI falls back to raw YAML mode rather than table mode.
  - In `src/ui/client/Workspace.tsx`, added confirmation dialogs to `switchToTable` and `submitTable` before replacing custom YAML rules with defaults.
- **Tests:** `tests/github/pr-automation.test.ts` "F11: compileLifecycleRules embeds mapping JSON and parseLifecycleMappingFromYaml parses it back", "F11: parseLifecycleMappingFromYaml returns null for hand-written YAML or missing comment", "F11: parseLifecycleMappingFromYaml returns null when hand-written YAML diverged from comment"; `tests/ui/client.test.ts` "F11: mapping rules route and default lifecycle mapping round-trip".

## F5 support for CA
- **Relay from CA (approved by driver):** CA emits a distinct trigger `branch.created` on the first push of a non-default branch, and emits `check_suite.success` / `check_suite.failure` for completed suites.
- **Changes:**
  - In `src/github/pr-automation.ts`, updated `TRIGGER.branch_pushed` to `"branch.created"` instead of `"push"`.
  - `compileLifecycleRules` now compiles the "branch pushed" lifecycle point to `when: branch.created`.
  - In `src/ui/client/Workspace.tsx`, added trigger guidance in the YAML editor hint explaining `branch.created` (first branch push), `push` (every push), and `check_suite.success`, `check_suite.failure`.
- **Tests:** `tests/github/pr-automation.test.ts` "F5: compiled QLL table fires In Progress for branch.created and does nothing for a plain push".
