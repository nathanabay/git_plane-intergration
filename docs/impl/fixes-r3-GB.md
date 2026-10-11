# Round-3 fixes — implementer GB

## F4 Installation allow-list per workspace (UI half)
- **Problem:** Any workspace admin could map any repository the GitHub App reaches because there was no workspace allow-list for installations.
- **Fix:**
  - Added `WorkspaceInstallation` interface to `src/ui/client/types.ts`:
    ```typescript
    export interface WorkspaceInstallation {
      installationId: number;
      workspaceSlug: string;
      accountLogin: string | null;
      createdAt: string;
    }
    ```
  - Added `WorkspaceInstallationsPanel` and `WorkspaceInstallationsTable` to `src/ui/client/Admin.tsx` allowing instance administrators to:
    - View allow-listed installations per workspace loaded via `GET /instance/installations`.
    - Allow-list an installation for a workspace via `PUT /instance/installations/:installationId` with `{ workspaceSlug, accountLogin }`.
    - Remove an allow-list entry via `DELETE /instance/installations/:installationId`.
    - Handles loading states via `Async`, and save/delete busy and error states via `useSaver` and `SaveStatus`.
    - Provides confirmation before deletion.
  - Rebuilt UI bundle via `node src/ui/build.mjs`.
- **Tests:** `tests/ui/client.test.ts` ("F4: buildUi compiles app.tsx including Admin with WorkspaceInstallationsPanel").

## F9 PR readiness firing logic
- **Problem:** In `src/github/pr-automation.ts:169`, `isReadyForMerge` evaluated suites too strictly and missed commit statuses and pagination:
  - Required `checkSuites.length > 0`, breaking repos that rely solely on commit statuses or have no suites.
  - Did not handle `latest_check_runs_count === 0` suites (queued suites from apps with checks:write that never run).
  - Rejected `skipped` suites (produced by path- or `if:`-filtered Actions workflows).
  - Rejected `stale` suites instead of treating them as non-blocking.
  - Completely ignored commit statuses (`GET /commits/{sha}/status`), allowing red commit statuses to pass as ready.
  - Reviews and check suites were fetched without pagination (`per_page: 100` and paging across pages).
- **Fix:**
  - In `src/github/pr-automation.ts`:
    - Updated `CheckSuiteSummary` to include `latest_check_runs_count?: number` and nullable `conclusion?: string | null`.
    - Added `CombinedCommitStatus` interface:
      ```typescript
      export interface CombinedCommitStatus {
        state?: string;
        total_count?: number;
        statuses?: unknown[];
      }
      ```
    - Updated `isReadyForMerge(reviews, checkSuites, commitStatus?)`:
      - Check suites: ignores suites where `latest_check_runs_count === 0`; treats `conclusion === "stale"` as non-blocking; accepts completed suites with `conclusion: "success" | "neutral" | "skipped"`. Allows repos with zero check suites (checks do not block).
      - Commit statuses: requires combined status to be `"success"` or have zero statuses (`total_count === 0`). Red commit statuses (`failure`, `error`, or pending with count > 0) block readiness.
      - Reviews: requires latest actionable review per reviewer to have >= 1 `APPROVED` and zero `CHANGES_REQUESTED`.
    - Updated `checkPrReadiness(octokit, repo, prNumber, headSha)`:
      - Paginated reviews fetching: requests `GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews` with `per_page: 100`, paginating through all pages.
      - Paginated check suites fetching: requests `GET /repos/{owner}/{repo}/commits/{ref}/check-suites` with `per_page: 100`, paginating through all pages.
      - Commit status fetching: requests `GET /repos/{owner}/{repo}/commits/{ref}/status`.
      - Combines all three via `isReadyForMerge(reviews, checkSuites, commitStatus)`.
    - Updated `PrRuleEventOptions` to support `commitStatus?: CombinedCommitStatus | null` and pass through in `prEventToRuleEvent`.
- **Tests:** `tests/github/pr-automation.test.ts`:
  - "F7: isReadyForMerge requires all check suites passed and latest review per reviewer approved"
  - "F7: checkPrReadiness queries GitHub reviews, check-suites, and commit-status endpoints"
  - "F9: isReadyForMerge handles skipped suites, stale suites, ignores 0-run suites, and allows zero suites"
  - "F9: isReadyForMerge evaluates commit status: blocks on failure/pending and passes on success or zero statuses"
  - "F9: checkPrReadiness paginates reviews and check-suites across pages and queries combined commit status"

## F18 support in GB files
- **YAML & comment hash:** In `src/github/pr-automation.ts`, `compileLifecycleRules` and `parseLifecycleMappingFromYaml` now hash the comment JSON together with the YAML body (`computeYamlHash(jsonForHash + "\n" + yamlBody)`). Any manual edit to the comment JSON invalidates the hash and returns `null`, preventing silent table-to-rules divergence.
  - Test: `tests/github/pr-automation.test.ts` ("F18: parseLifecycleMappingFromYaml returns null when comment JSON is edited by hand").
- **Branch-aware rule editor:** In `src/ui/client/Workspace.tsx` and `src/github/pr-automation.ts`, when a branch rule targets `branch_pushed`, the base-branch input is omitted / hidden, since `branch.created` events carry no base branch.

## F10 support for CA (queued guard)
- **Relay from CA (approved by driver):** In `src/github/pr-automation.ts`, `createRuleExecutor` attaches `skipTerminalState: true` to the `update_issue` write produced by `set_state` when `event.trigger === "branch.created"`. All other triggers leave the write unchanged. GA inspects this flag at execution time to skip updating issues that have already moved to `completed` or `cancelled`.
- **Tests:** `tests/github/pr-automation.test.ts` ("F10: createRuleExecutor adds skipTerminalState: true for branch.created set_state writes only").

## F1 support for CB (queued compound mutations)
- **Relay from CB (approved by driver):** In `src/github/pr-automation.ts`, `createRuleExecutor` routes `add_label` and `remove_label` actions through `deps.writer.mutateIssue(base, { kind: "add_label" | "remove_label", name: action.label }, opts)` with the label name directly, instead of awaiting `upsert_label` to return an ID. CB's outbox handles upserting the label and mutating the issue fields under the FIFO target lock. Raw test writers without `mutateIssue` fall back to the existing `needFields` / cache flow.
- **Tests:** `tests/github/pr-automation.test.ts` ("F3: createRuleExecutor routes add_label, remove_label and assign through writer.mutateIssue when provided").

## Cross-owner notes for driver
- **GitHub App permissions:** Reading commit statuses in `checkPrReadiness` queries `GET /repos/{owner}/{repo}/commits/{ref}/status`. The documentation in `docs/research/findings-github.md` should note `Commit statuses: Read-only` under repository permissions.
- **Oracle fixture note (`scripts/verify-b3-config-api.mjs`):**
  The driver updated `scripts/verify-b3-config-api.mjs` to inject `isWorkspaceMember`, matching the review-3 F5 fail-closed requirement in `src/ui/api.ts:306`. The oracle passes 14/14 with fail-closed user links.


