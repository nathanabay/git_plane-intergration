# Round-1 fixes, implementer GB

## F11 Lifecycle mapping table in workspace UI
`src/ui/client/Workspace.tsx` adds the simple lifecycle→state mapping table and branch-aware rules editor in `RulesFields`:
- Maps each §7.1 lifecycle point (`branch_pushed`, `drafted`, `opened`, `review_requested`, `changes_requested`, `approved`, `ready_for_merge`, `merged`, `closed_unmerged`, `reopened`) to a Plane state string target (e.g. `started:In Progress`, `completed:Done`).
- Configures base-branch regex for the merged state (`mergedBaseBranch`, default: `^main$`).
- Configures ordered branch-aware rules (base-branch regex, lifecycle point, target state) evaluated before defaults.
- Dual-mode support: admins can use the simple mapping table or switch to the raw YAML editor for custom rules.
- When no rule set exists (`version === 0`), the editor prefills with shipping defaults (`QLL_DEFAULTS` and compiled YAML).
- Saves as a new version via `PUT /mappings/:id/rules`.
- `src/github/pr-automation.ts`:
  - `compileLifecycleRules`: serialises the mapping configuration into a leading comment (`# gitsync-lifecycle-mapping: <json>\n`) prepended to the generated YAML rules.
  - `parseLifecycleMappingFromYaml`: extracts and parses the embedded JSON comment back to `LifecycleMapping`. If the YAML was edited by hand without the comment, it returns `null` and the UI falls back to the YAML editor.
  - Replaced `references.ts` value import with local `allLinkedPrsMerged` helper to keep `pr-automation.ts` browser-compatible for bundling.
Tests:
- `tests/github/pr-automation.test.ts` ("F11: compileLifecycleRules embeds mapping JSON and parseLifecycleMappingFromYaml parses it back", "F11: parseLifecycleMappingFromYaml returns null for hand-written YAML or missing comment").
- `tests/ui/client.test.ts` ("F11: mapping rules route and default lifecycle mapping round-trip").
- `node src/ui/build.mjs --outdir <dir>` bundles client app cleanly without error.

## F14 The ready_for_merge lifecycle point fires
`src/github/pr-automation.ts` emits `pull_request.ready_for_merge` from `prEventToRuleEvent`:
- Trigger conditions:
  1. `pull_request_review` with `action === "submitted"` and `review.state === "approved"` when the PR is clean / ready to merge (`pull_request.mergeable_state === "clean"`, or `checks_passed === true`, or all check suites in `check_suites` are completed with `success`/`neutral`). If checks have not completed or mergeable state is not clean, it emits `pull_request.approved`.
  2. `check_suite` or `check_run` with `action === "completed"` and `conclusion === "success"` (or neutral) on a PR that is already approved (`approved === true`, `review_state === "approved"`, or `mergeable_state === "clean"`).
  3. `pull_request` with `action === "ready_for_merge"` or `action === "auto_merge_enabled"`, or when the PR is approved and all check suites have passed.
- Payload documentation:
  - `pull_request_review` webhook payloads from GitHub carry `pull_request.mergeable_state: "clean"` once GitHub's mergeability and branch protection checks pass, or include `check_suites` array or `checks_passed: true`.
  - `check_suite` and `check_run` webhook payloads with `action: "completed"` and `conclusion: "success"` carry associated PRs in `check_suite.pull_requests` (or top-level `pull_request`).
  - `pull_request` webhook payloads carry `action: "ready_for_merge"` or `action: "auto_merge_enabled"`.
Tests:
- `tests/github/pr-automation.test.ts` ("F14: ready_for_merge fires when approved and all check suites passed") testing:
  - Review approval with `mergeable_state: "clean"` → `pull_request.ready_for_merge`
  - Review approval with successful `check_suites` → `pull_request.ready_for_merge`
  - Review approval without clean state or passing checks → `pull_request.approved`
  - Check suite completion with success on approved PR → `pull_request.ready_for_merge`
  - Check run completion with success on approved PR → `pull_request.ready_for_merge`
  - PR `ready_for_merge` action → `pull_request.ready_for_merge`
  - PR `auto_merge_enabled` action → `pull_request.ready_for_merge`

## F15 Settings page loader until workspaceUserInfo is loaded
`apps/web/app/(all)/[workspaceSlug]/(settings)/settings/(workspace)/git-sync/page.tsx`:
- Before rendering the iframe or `NotAuthorizedView`, checks `if (!workspaceUserInfo)`:
  Renders `<SettingsContentWrapper><PageHead title="GitHub Sync" /><div className="grid size-full place-items-center px-4"><LogoSpinner /></div></SettingsContentWrapper>`.
- Once `workspaceUserInfo` is loaded:
  - If `!canPerformWorkspaceAdminActions`, renders `<NotAuthorizedView section="settings" className="h-auto" />`.
  - Otherwise renders the iframe pointing to `/git-sync/ui/workspaces/${workspaceSlug}`.
- Regenerated `apps/web/git-sync.patch` against pristine makeplane/plane v1.4.2 cache.
Tests:
- `node scripts/verify-fork-patch.mjs all` passes cleanly (enforces pristine apply, 3-file fork surface, and exact mirror byte-for-byte equality).
