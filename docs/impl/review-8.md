# Implementation review — round 8

VERDICT: BLOCKING

Reviewed branch `seal`, committed HEAD `8c59007af9ff3d416c0240a8ee19b7cc09c02cbf`, using `git show HEAD:` and the committed diff from round 7. Read review-7 and all three round-7 fix write-ups; checked the changed admission, continuation, orphan-generation and maintenance paths against the design spec, plan tasks, HANDOFF, the measured webhook probe and the established frozen-authority contract. Existing uncommitted driver files were excluded.

Evidence is static source, SQL and regression-test inspection. The only executed check is `node scripts/verify-impl-review.mjs docs/impl/review-8.md docs/impl/review-7.md`. No behavioral tests, database probes, typechecks, heavy gates or deployments were run. Only this report and its ledger were written.

## Task verdicts

- A1: PASS — the non-root runtime and separately provisioned persistent credential-state mount remain unchanged from the reviewed deployment fix.
- A2: PASS — signatures precede queue admission; unavailable credentials answer 503 and cold database failure does not enable bootstrap fallback.
- A3: PASS — registration preserves first-insert authority and saved results; migration 008's credential-retirement trigger and workspace identity locks remain unchanged. No SQL runtime pass is claimed.
- A4: PASS — installation refresh now precedes push/PR authority capture, continuations authorize by source mapping, and dispatch removes authority metadata before sending API writes.
- A5: PASS — identifier 403/404 remains unknown/inaccessible with continued parsing; confirmed PR orphans can reach replacement generation while ambiguous/unlinked failed creates retain their original identity.
- A6: PASS — lifecycle settings still compile to the shared first-match engine with target-project evaluation and sequential actions; label mutations receive authority on their dependent plans.
- A7: FINDINGS — F1; reconciliation marks missing Plane partners orphaned without closing GitHub, but its comment callback selects an unrelated project mapping.
- A8: FINDINGS — F1; inspected the new installation-refresh, orphan-replacement and source-deletion fixtures. The maintenance fixture has identical linkback settings and omits the link's project, so it misses source selection. UUID label echoes still require exactly zero extra writes.
- B1: PASS — the admin iframe, disabled-mapping inventory and composed live credential health callback remain present.
- B2: PASS — the workspace iframe waits for workspaceUserInfo and rejects insufficient permissions before rendering.
- B3: FINDINGS — F1; verified installation persistence, distinct-workspace inference and source-deletion refusal remain present, but maintenance does not honor the orphan's own mapping settings.
- B4: PASS — push refreshes and authorizes the installation before identity lookup and command admission; frozen commands execute without a completion claim, while explicit replay revives failed steps before SHA shortcuts. #time's duration/provenance comment remains acceptable under the explicit CE/no-worklog contract.
- B5: PASS — PR admission refreshes before freezing; nested readiness and repaired PR continuations preserve admitted authority. Failed-unlinked event retention and confirmed-orphan replacement are now distinguished. Throttled readiness 403s still propagate.
- B6: PASS — issue/mirror scopes preserve delivery identities and dispatched authority; UUID labels resolve to names, numeric account IDs govern assignees, empty mapped sets reach removal, and object locks plus same-intent recovery prevent ordinary duplicate creates.
- B7: PASS — workspace-scoped check/deployment targets retain source authority; PR/push rollups use the admitted snapshot, and durable rollups retain/update link IDs without sending authority metadata remotely.
- B8: PASS — replay/Retry preserves immutable writes and successful results; later failed-create events remain held for explicit repair. The reviewed scope wrappers preserve original write-delivery identities.
- B9: PASS — email lookup now follows refreshed push/PR admission; transactional unlink/tombstone/token revocation and durable credential retirement remain intact.

## Previous findings

- prev F1: CLOSED — "await assertInstallationAllowed(ctx.db, await installationFor(ctx, mapping, p), mapping.workspaceSlug);" (`src/app/push.ts:31`). PR performs the same refresh/authorization at `pr.ts:173`, before capture at :175; nested readiness reuses admitted scope authority (:127), and resumed PR/issue work explicitly enters scopes with the dispatched snapshot. No stored authority is rewritten.
- prev F2: CLOSED — "AND NOT EXISTS (SELECT 1 FROM outbound_writes c JOIN sync_links l" (`src/app/pr.ts:207`). The exclusion requires an orphaned PR link matching the saved successful Plane create's ID, workspace, project, repository and PR number, plus a failed member of that exact root (:208-213). Fresh -NEW requests reach replacement generation; ambiguous/unlinked failures remain fenced, and original-delivery creation stays guarded.
- prev F3: CLOSED — "_authority: freezeMappingAuthority(mapping)," (`src/app/main.ts:214`). New maintenance comments now store the selected mapping's authority after installation resolution (:211); execution/Retry cannot substitute another mapping when that selected source is deleted. Selecting the correct mapping in the first place is the separate F1 below.

## Findings

### F1 [MAJOR] Orphan notifications use the first repository mapping instead of the orphan's source mapping
File: src/app/main.ts:209
Spec: §1.3, §7.4, §8
Evidence: The supported config API permits repository R to map to projects QLL and WEB in the same workspace (`api.ts:194-196`), with independent linkback_enabled values. Create QLL's mapping A first with linkback disabled, then WEB's mapping B with linkback enabled; both use the same allowed installation. A WEB item labelled github creates its GitHub partner and a label_sync link in WEB (`mirror.ts:559-568`). Deleting that Plane item makes reconciliation pass its full SyncLinkRow, including plane_project_id, to the callback (`reconcile.ts:22,34`). linkbackOnOrphan discards the project/source distinction: mappingsForRepo returns rows ordered by ID (`mappings.ts:55`), and :209 selects A solely by workspace. The callback returns at :210 because A's linkback is disabled, so B's enabled orphan notification is never registered. Reconciliation has already marked the link orphaned, so later sweeps do not retry it. Reversing the two toggles emits a comment despite B disabling it; the new stamp at :214 also binds that comment to A rather than B. The new maintenance fixture gives both mappings linkback true and supplies no plane_project_id (`tests/app/review-r7-cd.test.ts:13-14,22`), which verifies snapshot retention but cannot verify source selection.
Fix: Resolve the orphan's actual source mapping before checking its toggle or freezing authority. For project-scoped label mirrors, carry and match plane_project_id from SyncLinkRow; retain/recover originating mapping provenance for cross-project PR links so their source is not guessed from the target project. Skip notification when that source mapping is gone. Cover actual reconciliation of a WEB mirror with an earlier QLL mapping, opposite linkback settings, and deletion of the owning mapping while the unrelated mapping survives.
