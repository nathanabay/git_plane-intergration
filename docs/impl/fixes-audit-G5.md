# G5 documentation audit fixes

Acceptance gates (written before implementation):
- G1: public user profiles use an unauthenticated client configured for the active GitHub host; manual links retain canonical ID verification.
- G11 (UI/client): repository and user ID lookups use authenticated service routes and the configured host; repository access is workspace allow-listed.
- G12: the unimplemented autolink option is unavailable in the UI, consistent with the spec's shipping scope.
- G14: installation lifecycle changes invalidate or refresh mappings without granting unapproved workspace access; stale installation lookup is refreshed before writes.
- P7: configurable Plane session cookie name is wired through configuration, route authentication, and the environment example.
- P8: workspace membership for slugs containing `instances` checks the same web session identity despite Plane's cookie-selection middleware.
- Regression coverage is written in `tests/ui/audit-g5.test.ts` and is not executed here.
- Only the assigned typecheck is executed; no staging, commit, or push.
- Driver relay 1: verified Plane deliveries can spool to Postgres and maintenance can re-enqueue them.
- Driver relay 2: an optional previous Plane webhook secret is configured and accepted alongside the current secret.
- Driver relay 3: main.ts uses planeItemsPath for item fields and planeItemsPath + links/ for link lookup.
- Driver relay 4: backfill accepts a validated optional cursor; partial results offer Continue with that cursor.

Completed 2026-10-12 after resuming the disconnected G5 session. Reviewed the existing scoped diff and retained its regression coverage; this continuation did not write or run tests.

## Findings

| Finding | Implementation | Existing regression coverage (not executed) |
| --- | --- | --- |
| G1 | `src/app/github.ts:38` creates an unauthenticated Octokit for public profiles using the current credential source's API host, including GHES. `src/app/main.ts:68` wires it into manual user linking. `src/ui/mapping-check.ts:83` retains canonical login/ID verification and propagates outages and rate limits. JWT requests remain limited to App endpoints; automatic email linking retains its installation client. | `tests/ui/audit-g5.test.ts:52` checks the real public client, absent authorization and changing hosts; `:68` checks full cooldowns; `:82` drives composed manual linking and repository lookups. |
| G11 (UI/client) | `src/ui/client/github.ts:5` and `:10` call authenticated service lookup routes. `src/ui/api.ts:198` and `:207` authenticate workspace admins and validate names before lookup; `src/ui/validate.ts:233` shares repository-name validation. `src/app/main.ts:72` checks workspace installation approval before and after the installation-authenticated repository read and verifies repository identity. `src/ui/client/Workspace.tsx:124` and `:596` pass the workspace slug. UI errors preserve GitHub retry deadlines (`src/ui/api.ts:123`). | `tests/ui/audit-g5.test.ts:82`, `:125`, and `:142` cover composed host/authority wiring, browser URLs and credentials, authentication, malformed names, and retry deadlines. |
| G12 | `src/ui/client/Workspace.tsx:177` disables and labels autolinks unavailable. Mapping saves explicitly send `autolinks: false` (`:136`), matching the spec's shipping scope. No Administration permission or autolink reconciliation is introduced. | `tests/ui/audit-g5.test.ts:161` renders the actual form and checks the disabled, unchecked option and absence of the old promise. |
| G14 | `src/app/reducers.ts:16` and `:33` route installation and installation-repository events. Deletion, suspension and removals invalidate only mappings still attached to that installation (`src/app/context.ts:138`); creation, additions, unsuspension and permission acceptance refresh existing mappings only within approved workspaces (`:151`). Refresh verifies current installation and canonical repository identity and guards the database update against concurrent mapping edits or approval revocation. `src/app/github.ts:37` clears cached App/installation clients, and `:51` rejects suspended installations. `src/app/context.ts:115` re-resolves current authority before writes, including Plane-only work, ignoring stale webhook/remembered IDs; permission/not-found failures invalidate stale mappings while rate limits propagate. Existing guarded `src/app/mappings.ts:138` persists the refreshed installation. Explicit instance approval triggers refresh (`src/ui/api.ts:598`, wired at `src/app/main.ts:83`). | `tests/ui/audit-g5.test.ts:221`, `:262`, `:284`, and `:306` cover lifecycle actions, workspace approval, delayed old-installation deletion, repository identity, concurrent revocation, stale-ID repair, permission failures, rate limits and explicit approval. |
| P7 | `src/config/env.ts:15` and `:51` expose and validate `PLANE_SESSION_COOKIE_NAME`, defaulting to `session-id`. `src/app/main.ts:61`, `src/ui/api.ts:93` and `src/ui/plane-auth.ts:64` carry it through browser authentication. `deploy/git-sync.env.example:18` tells operators to match Plane's `SESSION_COOKIE_NAME`. | `tests/ui/audit-g5.test.ts:176` and `:207` cover default/custom configuration and route-level forwarding. |
| P8 | `src/ui/plane-auth.ts:80` aliases the already verified web session into `admin-session-id` for membership requests whose slug contains `instances`. It never forwards a potentially different browser instance-admin session or unrelated cookies, so both identity and workspace role are checked for the same user. | `tests/ui/audit-g5.test.ts:185` reproduces Plane's substring cookie selector and verifies custom web-cookie forwarding, identity consistency and ordinary-slug behavior. |

## Driver relays

1. `src/app/main.ts:56` passes `spool: (job) => spoolInbound(db, job)` to webhook routes. `src/app/main.ts:207` passes `enqueue: (job) => queues.enqueueInbound(job)` into maintenance, activating the existing spool replay schedule.
2. `src/config/env.ts:13` and `:75` add optional `PLANE_WEBHOOK_SECRET_PREVIOUS`; `deploy/git-sync.env.example:27` documents temporary rotation overlap. `src/app/main.ts:53` passes the filtered current/previous secret array to ingress.
3. `src/app/main.ts:137` reads all work-item links using `planeItemsPath(...) + 'links/'`. The former line 140 is an item-field read, so `src/app/main.ts:145` uses the item-detail `planeItemsPath(...)` without a links suffix to retain labels/assignees. Both paths now use the shared work-items helper.
4. `src/ui/api.ts:486` reads an optional backfill body through the existing `body()` helper (aliased as `readBody`), validates the cursor object/pages, preserves bodyless initial requests, and forwards `...(body?.cursor !== undefined ? { cursor: body.cursor } : {})`. `src/ui/client/types.ts:49` re-exports the backend result/cursor types. `src/ui/client/Workspace.tsx:719` offers Continue on a partial result, submits `{ cursor }`, and explains that more items remain. Failed continuations retain the previous result/cursor for retry.

Relay verification was limited to code review and typechecking as requested. No additional tests were written or executed in this continuation.

## Documentation checked

Used Context7 CLI for `/octokit/auth-app.js`, `/websites/github_en_rest`, `/websites/github_en`, `/websites/developers_plane_so`, and `/makeplane/plane`. Relevant primary sources:

- [Octokit App authentication](https://github.com/octokit/auth-app.js/blob/main/README.md): installation authentication requires an installation ID; GHES requests use its configured API base URL.
- [GitHub public user profiles](https://docs.github.com/en/rest/users/users) and [App endpoints](https://docs.github.com/en/rest/apps/apps): public profile reads and JWT installation discovery have distinct authentication requirements.
- [GitHub webhook payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads): installation and repository-access lifecycle payloads.
- [Plane work-item links](https://developers.plane.so/api-reference/link/add-link): the v1 work-items links path.

Context7's Plane documentation does not specify the v1.4.2 session-cookie middleware. Checked the pinned primary [session middleware](https://github.com/makeplane/plane/blob/v1.4.2/apps/api/plane/authentication/middleware/session.py) and [settings](https://github.com/makeplane/plane/blob/v1.4.2/apps/api/plane/settings/common.py): the path substring selects a cookie name, both names use the same session store, and the web cookie name is configurable.

## Verification and handoff

The only executed check was:

```sh
node scripts/typecheck.mjs src/app/github.ts src/app/main.ts src/app/mappings.ts src/app/context.ts src/app/reducers.ts 'src/ui/**/*.ts' 'src/ui/**/*.tsx' src/config/env.ts tests/ui/audit-g5.test.ts
```

Result: exit 0, `typecheck passed (63 project files)`. All six finding gates and four relay gates passed code review; existing regression coverage and the typecheck-only constraint were verified (12 acceptance gates met, 0 unmet, 0 abandoned). No tests, UI builds, staging, commits or pushes were performed. Runtime regression execution remains with the driver under the round's instructions.

No G5 implementation is deferred. G11 checks/push changes remain owned by G2; the shared GitHub classifier/cooldown implementation remains owned by G1. The spool, replay and work-items helper use G4's existing contracts without edits to its files. No spec wording or schema change is needed from G5.

## Test phase

Driver authorized only these test files, one file per capped invocation: `tests/a8/reducers.test.ts`, `tests/app/review-r5-cd.test.ts`, `tests/app/review-r7-ca.test.ts`, and `tests/app/fixes-r3.test.ts`. Acceptance: every listed test passes without weakening replacement refresh, workspace rejection, frozen authority, replay or manual-link ID verification. Transient installation errors must still retry; a confirmed missing installation must invalidate and suppress safely.

Each reported failure was classified before changing its assertions:

| Failure | Classification and change | Proof retained |
| --- | --- | --- |
| `tests/a8/reducers.test.ts`, replacement installation remembered | G14 deliberately changed authority from a potentially delayed payload to GitHub's current repository-installation read. The fixture at `:168` now returns 4242 after first verifying/storing 1; the test name reflects the current-access contract. | The actual issue reducer still has to update the database mapping from 1 to approved replacement 4242. |
| `tests/app/review-r5-cd.test.ts`, composed installation authority | G14 fixture mismatch. The current file exercises installation 123 versus cross-workspace replacement 456; `:74` now makes the installation API report 456 for that rejection and restores 123 afterward. | The replacement is refused, the in-memory mapping stays 123, and all revocation, inventory, composed-health and execution-authority assertions remain. |
| `tests/app/review-r7-ca.test.ts`, F1 push replacement | G14 fixture mismatch. `:97` makes current installation lookup report approved replacement 4242, matching the delivery. | Refresh happens before sender lookup; every admitted intent/profile scope uses 4242; repaired/replayed Smart Commit and branch work remains once-only. |
| `tests/app/review-r7-ca.test.ts`, F1 PR replacement | G14 fixture mismatch. `:126` makes current installation lookup report approved replacement 4242. | Refresh precedes create admission; deferred rules, rollup and linkback retain the frozen installation through repair/replay and run once. |
| `tests/app/review-r7-ca.test.ts`, F1 unlisted replacement | G14 fixture mismatch. `:154` makes the API report the real unlisted replacement 4242 rather than the old approved 1. | Both actual reducers must reject before any registration; no outbound rows appear and the old mapping is not rewritten. |
| `tests/app/fixes-r3.test.ts`, F5 manual-link mismatch | G1 deliberately moved public profile reads away from App JWT. `:26` supplies `publicRequest`; `appRequest` now throws so the original defect cannot return. | Wrong canonical GitHub ID still answers 422 and inserts no user-map row. |
| `tests/app/fixes-r3.test.ts`, F7 installation lookup | **Real G14 integration regression**, plus an obsolete expectation that saved installations bypass lookup. A confirmed 404 clears the mapping, but the Plane reducer then tried to freeze null authority. Fixed the source and strengthened the regression at `:57`. | Helper and actual delivery transient errors retry without losing authority; a confirmed miss disables the mapping, audits suppression, registers no writes/plans, and excludes later deliveries. Explicit verification after restored access admits work with another live lookup. A pending Plane continuation losing access is also audited/suppressed without writes. |

Driver explicitly authorized the narrow G3-owned edit to `src/app/issues.ts`. At `:265`, the Plane reducer now audits `github_not_installed` and skips a missing, invalidated mapping before `withMappingWriterContext` can freeze authority. At `:170`, pending Plane continuations revalidate before entering the mapping scope and likewise audit/return on invalidation; their installation-0 writer also retains the suppression wrapper. Transient and rate-limited errors still propagate before either suppression branch. No changes to G14's current-access lookup, workspace approval, or strict frozen-authority validation were needed.

Rechecked Context7's `/websites/github_en_rest` for [JWT repository-installation discovery](https://docs.github.com/en/rest/apps/apps) and [public profile reads](https://docs.github.com/en/rest/users/users). The installation fixtures now model the current API result rather than giving a delayed delivery authority.

The initial capped `tests/app/fixes-r3.test.ts` run passed 5/6 and reproduced F7's exact null-authority exception. After the source fix, the capped rerun passed 6/6, including the strengthened delivery and continuation assertions. Only the four authorized test files were executed, using these exact invocations:

```sh
NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/a8/reducers.test.ts
NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/app/review-r5-cd.test.ts
NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/app/review-r7-ca.test.ts
NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/app/fixes-r3.test.ts
```

| File | Successful run result |
| --- | --- |
| `tests/a8/reducers.test.ts` | 15 passed, 0 failed, exit 0; includes the real Postgres lock test. |
| `tests/app/review-r5-cd.test.ts` | 6 passed, 0 failed, exit 0 (including nested tests). |
| `tests/app/review-r7-ca.test.ts` | 4 passed, 0 failed, exit 0. |
| `tests/app/fixes-r3.test.ts` | 6 passed, 0 failed, exit 0. |

All four files passed: 31 tests, including nested tests, 0 failed/skipped/cancelled in their successful runs. The final scoped typecheck also passed:

```sh
node scripts/typecheck.mjs src/app/github.ts src/app/main.ts src/app/mappings.ts src/app/context.ts src/app/reducers.ts src/app/issues.ts 'src/ui/**/*.ts' 'src/ui/**/*.tsx' src/config/env.ts tests/a8/reducers.test.ts tests/app/review-r5-cd.test.ts tests/app/review-r7-ca.test.ts tests/app/fixes-r3.test.ts
```

Result: exit 0, `typecheck passed (67 project files)`. Test-phase edits are limited to the four authorized test files, the explicitly approved narrow `src/app/issues.ts` integration fix, and this report. No staging, commit or push. All seven reported failures are resolved; nothing is deferred.
