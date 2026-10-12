# Implementation review — round 9

VERDICT: NON-BLOCKING

Reviewed branch `seal`, committed HEAD `651ee394aee1810835a9c0ea8322620a3172c1a6`, using `git show HEAD:` and the committed round-8 diff. Read review-8, fixes-r8-CD.md and the new resolver/tests; checked their integration with reconciliation, ordinary PR linking, backfill, retention and durable authorization against the established spec, plan, HANDOFF and webhook-probe context. Existing uncommitted driver work was excluded.

No BLOCKING or MAJOR defect was found in this confirmation review. Evidence is static source, SQL and test inspection. The only executed check is `node scripts/verify-impl-review.mjs docs/impl/review-9.md docs/impl/review-8.md`; no behavioral tests, database probes, typechecks, heavy gates or deployments were run. PASS denotes the source-review conclusion, not a runtime gate result. Only this report and its ledger were written.

## Task verdicts

- A1: PASS — the non-root runtime and separate persistent credential-state mount remain unchanged from the reviewed deployment fix.
- A2: PASS — signature verification precedes queue admission; unavailable credentials answer 503 and cold database failure does not enable bootstrap fallback.
- A3: PASS — source resolution uses existing durable writes and full link identity; no migration/schema or shared ledger changes were introduced.
- A4: PASS — maintenance stamps the resolved source after installation resolution; the production authorizer still checks the frozen mapping before dispatch and strips metadata before API writes.
- A5: PASS — identifier 403/404 remains unknown/inaccessible with continued parsing; the resolver distinguishes source mapping from a cross-project PR target.
- A6: PASS — the rule engine, compiled lifecycle settings, target-project evaluation and sequential actions are unchanged by this round.
- A7: FINDINGS — F1 [MINOR]; exact project-mirror and retained PR ownership now governs optional notifications, while reconciliation still marks missing partners orphaned and never closes GitHub. Skips for unavailable PR provenance lack diagnostic audit detail.
- A8: FINDINGS — F1 [MINOR]; inspected the new actual-reducer/reconciliation fixtures for opposite toggles, deleted owners, cross-project -NEW provenance and legacy continuation recovery. The optional-skip reason remains untested. UUID label echoes still require zero extra writes.
- B1: PASS — the admin iframe, disabled-mapping inventory and composed live credential health source remain unchanged.
- B2: PASS — the workspace iframe waits for workspaceUserInfo and rejects insufficient permissions before rendering.
- B3: PASS — mirror notifications honor the owning project's linkback setting; retained cross-project PR provenance honors the original mapping rather than the target project's setting.
- B4: PASS — push refreshes installation before capture; frozen Smart Commit execution is independent of completion claims, and explicit replay revives failed steps before SHA shortcuts. #time's duration/provenance comment remains acceptable under the explicit CE/no-worklog contract.
- B5: PASS — PR admission refresh, resumed authority, failed-unlinked event retention and confirmed-orphan replacement remain unchanged; throttled readiness 403s still propagate.
- B6: PASS — label mirrors resolve their orphan source by repository/workspace/project. UUID label lookup, numeric-account assignees, empty-set removal, object locks and same-intent ambiguous-create recovery remain present.
- B7: PASS — workspace-scoped rollups and immutable source authority remain unchanged; the resolver matches complete PR link identity before recovering a create workflow's owner.
- B8: FINDINGS — F1 [MINOR]; replay/Retry and retention behavior are unchanged, but the audit cannot explain optional PR orphan-notification skips when source evidence is absent or pruned.
- B9: PASS — frozen-source authorization, transactional unlink/tombstone/token revocation and durable credential retirement remain unchanged.

## Previous findings

- prev F1: CLOSED — "if (link.gh_kind === \"issue\" && link.created_by === \"label_sync\") return source();" (`src/app/mappings.ts:83`). source() requires a unique authorized repository/workspace/project match (:78-81); main calls this resolver before testing the toggle (`main.ts:210-211`). PR creation provenance must match workspace/project/item/repository/number/kind before its original mapping ID is recovered (:88-124). Missing/deleted/conflicting sources return null, and new notifications freeze the resolved owner (`main.ts:215`). The earlier unrelated project can no longer control the reviewed mirror's notification.

## Findings

### F1 [MINOR] Audit does not explain optional PR orphan notifications skipped for missing provenance
File: src/app/main.ts:211
Spec: §1.3, §7.6
Evidence: An ordinary PR referencing an existing item records a sync_link without an item-create workflow (`pr.ts:250-255`); backfilled PRs do likewise (`tooling.ts:238-247`). On later orphaning, the new resolver finds no matching create row (`mappings.ts:88-91`) and returns null at :124. A completed -NEW workflow can reach the same state after normal outbound retention pruning (`ledgers.ts:81-96`). The callback silently returns at main.ts:211, and reconciliation records only the orphaned outcome (`reconcile.ts:28-34`), with no indication that an enabled notification was skipped for unavailable provenance. Source resolution intentionally refuses to guess ownership; the mandatory orphan mark remains correct and the spec makes this comment optional. The remaining issue is operator visibility into that limitation.
Fix: Record a workspace-scoped notification-skipped audit reason when source provenance is unavailable, distinct from an explicitly disabled linkback setting, and document the retained-provenance requirement. Cover ordinary referenced/backfilled PRs and pruned completed workflows without permitting an unrelated mapping to authorize them.
