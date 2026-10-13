# Parity wave 2, G4: N3 branch helpers and the Development panel

Status: code written; typecheck passes (`node scripts/typecheck.mjs src/sync/dev-info.ts src/ui/dev-panel.ts
src/ui/client/DevPanel.tsx tests/ui/parity2-g4.test.ts`: 62 project files, no errors). Tests written,
**not run**. The web fork patch was checked with `git apply --check` against pristine v1.4.2 and the
mirrored file matches the patched result; `verify-fork-patch` was not run (its web limit is still 4).
Nothing staged or committed.

Wave-1 follow-up 2 (`credentials.ts` edition wiring) moved to G1's wave-2 row, so I did not touch it.

## Fork surface: web 4 → **5 files** (admin unchanged at 3; total 7 → **8**)

New fork file: `apps/web/core/components/issues/issue-detail/sidebar.tsx` (mirrored in this repo and
added to `apps/web/git-sync.patch`, in path order).

- **Seam (Plane v1.4.2 source):** `IssueDetailsSidebar` in
  `apps/web/core/components/issues/issue-detail/sidebar.tsx`, rendered by `issue-detail/root.tsx:256`
  on the full work-item page. It already receives `workspaceSlug`, `projectId` and `issueId`, so the patch
  is **8 added lines, no new imports, no new files**: an `<iframe>` after the properties list, inside the
  existing scroll container, with
  `src=/git-sync/ui/workspaces/<slug>/projects/<projectId>/work-items/<issueId>/development`,
  `allow="clipboard-write"` (for **Copy branch name**) and a fixed 24rem height.
- **Not covered:** the peek overview (side peek / modal) uses its own properties component; adding the
  panel there would be a sixth web file. Left out to keep the patch minimal.
- **Driver:** raise `scripts/verify-fork-patch.mjs` web `maxFiles` to 5 and update spec §8's "seven files".
  `apps/README.md`'s fork-surface list is also stale already: it names `apps/web/app/routes.ts`, but the
  patch edits `apps/web/app/routes/extended.ts` and `.../settings/workspace/sidebar/item-categories.tsx`.
  It should list the five patch files. I did not edit it because it is outside my row.

## Files

| File | Change |
|---|---|
| `src/sync/dev-info.ts` | branch template rendering and validation, git ref-name check, suggested-branch link, rollup-link parser |
| `src/ui/dev-panel.ts` (new) | panel data endpoint and Create branch, exported as `createDevPanelRoutes(deps)` |
| `src/ui/client/DevPanel.tsx` (new) | iframe page: PR roll-up, builds, deployments, previews, branches; per repository **Copy branch name** and **Create branch** |
| `apps/web/git-sync.patch`, `apps/web/core/components/issues/issue-detail/sidebar.tsx` | fork patch (above) |
| `tests/ui/parity2-g4.test.ts` (new) | regression tests |

## Behavior

**Branch template** (`repo_mappings.branch_template`, NULL = `{key}-{title-slug}`). Placeholders `{key}`
(required), `{title-slug}` (lowercase ASCII words, at most 50 characters, cut at a word boundary),
`{username}` (the viewer's linked GitHub login from `user_map`). `validateBranchTemplate` refuses
unknown placeholders, characters other than `A–Z a–z 0–9 . _ - /` outside placeholders, templates over
120 characters, and templates whose rendering is not a valid git branch name. It also renders two
samples and **parses the key back with our own branch parser** (`parseReferences`), so `{key}_{title-slug}`
or `x{key}` is refused: a branch made from them would never link to the item. A missing `{username}` is
dropped with its separator (the suggested link has no viewer), and so is an empty title slug.

**Suggested link.** `upsertSuggestedBranchLink(deps, target, …)` adds `[Branch] suggested: <name>`.
It uses push.ts's rollup key (`branch:<repoId>:<branch>`) and URL (`<repo>/tree/<branch>`). The first push
of that branch therefore edits the same Plane link into `[Branch] <name>` instead of adding a second one.
A test reads `push.ts` to guard that coupling.

**Development panel data** (`GET /git-sync/api/workspaces/:slug/projects/:projectId/work-items/:issueId/development`).
Every call is authorized by Plane with the viewer's session (Plane v1.4.2 web API):
- `users/me`;
- the work item: 403/404 becomes 404. Plane applies its guest rule (`role=5`, no
  `guest_view_all_features`, not the creator → 403);
- the project, for `identifier`, so the key is `<identifier>-<sequence_id>`;
- `project-members/me`, for `role`;
- the item's `issue-links/`.

The response holds:
- PRs parsed from the `[PR]` rollup titles, with the Jira roll-up (OPEN > MERGED > DECLINED);
- `[CI]`, `[Deploy]`, `[Preview]` and `[Branch]` links;
- for each **allow-listed** mapping of the project (`mappingsForProject`), the rendered branch name and URL;
- `canCreateBranch` (project role ≥ 15).

Links with other titles or non-http(s) URLs are dropped.

**Create branch** (`POST …/work-items/:issueId/branches`, body `{ "mappingId": n }`, nothing else accepted):
- **Request checks:** same-origin and JSON are required (CSRF, the same rule as the config API). The work item must be visible and the viewer must have project role member or admin.
- **Mapping:** it must be allow-listed for the workspace. The branch name is computed on the server; the caller cannot choose the name or the base.
- **GitHub calls, all with the installation token:**
  1. `GET /repos/{owner}/{repo}` for `default_branch`;
  2. `GET /repos/{owner}/{repo}/git/ref/heads/<default>` for `object.sha`;
  3. `POST /repos/{owner}/{repo}/git/refs` with `{ ref: "refs/heads/<name>", sha }`.
- **Responses:**
  - 201 when created;
  - 422 with the branch present → 200 `{ created: false }`, so a double click or retry is harmless;
  - missing default ref or 409 → 409 "repository is empty";
  - 403/404 → 403 (App lacks access);
  - anything else → 502.
- **Audit and link:** every outcome is audited (`branch_created`, `applied` or `skipped`). The optional `linkBranch` dep then records `[Branch] <name>` with push.ts's key.

## Seams (for the driver, G5, G2/G3)

1. **G5, route registration:** `createDevPanelRoutes(deps)` returns full-path `Route`s, so register them
   beside `createConfigRoutes` in `main.ts`, not through `api.ts`'s `add`. Deps:
   - `db`, `planeInternalUrl`, `planeSessionCookieName`, `publicOrigin`;
   - `githubWebOrigin`: G1's `hosts.ts` `webOrigin`;
   - `githubFor(mapping)`: `ghClient.installationOctokit(await installationFor(ctx, mapping))`;
   - `linkBranch(target, mapping, link)`: `upsertRollupLink({ db, writer: ctx.plane, findLinkId }, { ...target, _authority: freezeMappingAuthority(mapping) }, link.key, link)`.
2. **`src/ui/app.tsx` (G5 or the driver):** before `parseLocation`, add
   `const dev = parseDevPanelPath(pathname); if (dev) return <DevPanel route={dev} />;`
   (both exported from `client/DevPanel.tsx`). Without it the iframe shows "Page not found".
3. **G5, mapping form:** validate `branchTemplate` with `validateBranchTemplate` (from `src/sync/dev-info.ts`)
   and store it with `updateMappingParity`. The database CHECK only enforces `{key}`.
4. **G3/G2, suggested link call site:** call `upsertSuggestedBranchLink` when the mirror creates a Plane
   item from a GitHub issue (pair creation in `mirror.ts`), gated by the mapping's linkback toggle.
   PR- and push-linked items already have a real branch, so they need no suggestion.

## Context7 and source citations

Library ids resolved with `npx ctx7@latest library` (find-docs skill).

- `/websites/github_en_rest` (Git references): `POST /repos/{owner}/{repo}/git/refs` takes `ref`
  (fully qualified, must start with `refs` and contain two slashes) and `sha`. It answers 201 Created,
  409 Conflict, or 422 for a failed validation; refs cannot be created in an empty repository.
  `GET /repos/{owner}/{repo}/git/ref/{ref}` takes `heads/<branch>` and returns `object.sha` (40 characters).
  `default_branch` is a repository field (repos API). Both endpoints accept installation tokens.
- **Permission caveat:** Context7 lists `POST …/git/refs` under the repository **Workflows** (write)
  category with "Additional permissions: Required". It did not surface the Contents listing. The plan
  assumes the App's existing **Contents: write**. I kept that assumption and map a 403 to a clear message.
  The end-to-end run should confirm that the test App creates a branch with Contents: write alone. GitHub
  needs Workflows write only for refs whose commits change workflow files.
- `/git/htmldocs` (git-check-ref-format): the ref-name rules implemented in `isValidGitBranchName`.
  Plus our own rule: no leading `-`.
- `/websites/developers_plane_so` (links): a work-item link is `title` + `url`. That public API paginates;
  the v1.4.2 session API used here does not (below).
- Plane **v1.4.2 source** (`raw.githubusercontent.com/makeplane/plane/v1.4.2/…`):
  - `apps/api/plane/app/urls/issue.py`: `issues/<pk>/` and `issues/<issue_id>/issue-links/`;
  - `urls/project.py`: `projects/<pk>/` and `project-members/me/`;
  - `views/issue/base.py`: `retrieve`, including the guest 403 rule;
  - `serializers/issue.py`: `IssueSerializer` has `name`, `sequence_id`, `project_id`;
  - `serializers/project.py`: `fields="__all__"`, which includes `identifier` and `role`;
  - `views/issue/link.py` and `settings/common.py`: no default paginator, so the link list is a plain array;
  - `permissions/base.py`: `ROLE` ADMIN 20, MEMBER 15, GUEST 5;
  - `apps/web/core/components/issues/issue-detail/sidebar.tsx` and `root.tsx`: the fork seam.

## Tests (`tests/ui/parity2-g4.test.ts`, not run)

- **Naming:** title slugs; git ref-name rules; rendering, including a dropped username and an empty slug.
- **Template validation:** valid templates, and ten invalid ones each refused with its reason.
- **Suggested link:** push.ts key and URL compatibility, and the suggested link's exact key, title and URL.
- **Parsing:** rollup-link parsing (unknown categories and `javascript:` URLs dropped); PR roll-up order; panel path parsing.
- **Fork patch:** five files, and the mirror contains the iframe.
- **Endpoints**, against a fake Plane and a fake GitHub on PGlite:
  - session required; hidden item → 404; guest sees no Create branch; template with the linked login;
  - create, then a second click (200, `created: false`); link and audit rows;
  - cross-site refused (403); guest refused (403); missing session (401); bad body (400); extra field such as a caller-chosen sha (400); unknown mapping (404);
  - de-allow-listed installation (404); empty repository (409); App without access (403); nothing linked after a failure.

## Follow-up W2b (driver-assigned)

- `scripts/verify-fork-patch.mjs`:
  - **Limits:** web limit 4 → 5; total 7 → 8 ("eight"); header comment updated.
  - **Prefixes:** web prefixes narrowed to the actual fork surface: `apps/web/app/`,
    `apps/web/core/components/settings/workspace/sidebar/`,
    `apps/web/core/components/issues/issue-detail/sidebar.tsx` and `packages/constants/src/settings/`.
  - **New Development panel check:**
    - the patch must touch the sidebar file;
    - `IssueDetailsSidebar` must render an `<iframe>` whose template-literal `src` is
      `/git-sync/ui/workspaces/<x>/projects/<x>/work-items/<x>/development`, built from `workspaceSlug`,
      `projectId`, `issueId` in that order, with `allow="clipboard-write"`;
    - the service UI must have the matching route (`parseDevPanelPath` in `src/ui/client/DevPanel.tsx`).
- **Spec:** §7.4 ("eight files"), §8 mechanism (eight files: admin 3, web 5, naming the sidebar file),
  the §10 risk row ("8 files"), and §12.8 N3 (built; fork is eight files and the oracle enforces it).
- **`apps/README.md`:** the web list now names the five patch files. Two earlier entries were wrong: it named
  `apps/web/app/routes.ts` instead of `routes/extended.ts`, and it left out `item-categories.tsx`.
- **Oracle run (once):** `sh scripts/heavy.sh node scripts/verify-fork-patch.mjs all` → **`fork patch
  verification passed (all)`**, exit 0.

## Follow-up W2c (driver-assigned): three driver oracles

- **`scripts/verify-a4-writepath.mjs`:**
  - **URLs:** the fake Plane answers `work-items/` and `issues/` item paths; the PATCH and link URL assertions accept both.
  - **429 check:** it now asserts the deferral contract. Each 429 throws `PlaneRateLimitError` (status 429, `requestMade: true`), with `retryAt` at the Retry-After deadline (3 s) and then at `X-RateLimit-Reset`. There is no inline sleep, no retried PATCH, and the op is forgotten. The client's budget pauses, so the next request on that key is refused unsent (`requestMade: false`, `retryAt` ≥ the deadline).
  - **Unchanged sub-checks:** 5xx backoff and no retry for other 4xx.
  - **Clients:** they run with `rateLimitPerMinute: 0`, so `sleeps` records only retry backoff; the budget is A5's subject. The 429 sub-checks use fresh clients with a large real budget (a budget of 0 also ignores pauses).
- **`scripts/verify-a5-a7.mjs`:** the reconcile check is rewritten for A2 and becomes two sweeps. The fake Plane serves the project, the item list, the item reads and the activities, under `work-items/` and `issues/`.
  - **Sweep 1:** a deleted item (activities show `deleted`) is orphaned at once, and is the only item reported. An archived item stays active, gets `plane_archived_at`, and is not reported. One unexplained 404 is kept active with `missing_since` (`awaiting_confirmation`). A 500 is an error and changes nothing. Only GETs are sent.
  - **Sweep 2:** the unexplained 404 is orphaned (`not_found_twice`) and reported. The archived item is still active and unreported, its archived audit is not repeated, and it gets one read with no activities call. Orphaned links are not re-checked. Applied-ops pruning is still checked.
- **`scripts/verify-wiring.mjs`:** the fake Plane matches `work-items/` and `issues/` for the identifier lookup, the item read, the PATCH, the link and the comment checks. The fake GitHub is unchanged.

### Results (each run once via `sh scripts/heavy.sh node scripts/<name>.mjs`)

| Oracle | Result |
|---|---|
| verify-a4-writepath | **passed (15 checks)** |
| verify-a5-a7 | **passed (13 checks)** |
| verify-wiring | **FAILED**: the first check stops at the UI build: `Could not resolve "node:crypto"` at `src/github/pr-automation.ts:608` (`reportGithubProblem`, N2, `await import("node:crypto")`). `src/ui/client/Workspace.tsx` imports `pr-automation.ts` into the browser bundle, so the service never starts and the other five checks fail with it (timeout / fetch failed / exit timeout). It is not caused by these oracle edits, and my wiring changes were not exercised. **The fix belongs to G2 (`src/github/**`):** move `reportGithubProblem` (or its hashing) out of the module the client imports, or use a browser-safe hash. Then re-run verify-wiring. |

## C4 UI (driver-assigned)

**Done (`src/ui/client/Workspace.tsx`, `MappingForm` only).**
- **Pickers:** "Open state" and "Closed state" use G5's `StatePicker` with `valueKind="id"`, which already drops triage states. Choices come from the project's states (`GET /workspaces/:slug/projects/:projectId/states`).
- **Project change:** changing the project clears both choices.
- **Validation:** the same state for open and closed blocks Save with an error.
- **Save:** both fields are sent on POST and PATCH as `openStateId` / `closedStateId`, with `null` for empty (empty = project default).
- **Hints:** they describe the mirror's fallback (`src/sync/mirror.ts` `mirrorStateFor`): the default completed state when closed, and the default unstarted state when reopened. A new open issue keeps Plane's default state.
- **Not done:** no other part of the file was touched, and the typecheck passes.

**Needed from G5 (not edited; G5's files).** Until then the server refuses the new keys with 400, so **saving a mapping from the form fails**. Apply this before the UI ships.

1. `src/ui/validate.ts`:
   - `MappingInput` gains `openStateId: string | null; closedStateId: string | null;`;
   - `MAPPING_KEYS` gains `"openStateId", "closedStateId"`;
   - in `parseMappingInput`:
   ```ts
   for (const k of ["openStateId", "closedStateId"] as const) {
     if (!has(k)) continue;
     const v = body[k];
     if (v === null || v === "") { out[k] = null; continue; }
     const id = text(v, k, 64);
     if (!PLANE_ID.test(id)) throw new ValidationError(`${k} contains invalid characters`);
     out[k] = id;
   }
   if (out.openStateId && out.openStateId === out.closedStateId) throw new ValidationError("openStateId and closedStateId must differ");
   ```
   (`has` treats `null` as present, since it tests `!== undefined`, so null clears.)
2. `src/ui/api.ts`:
   - `mappingDto` gains `openStateId: (r.open_state_id ?? null) as string | null, closedStateId: (r.closed_state_id ?? null) as string | null`;
   - in `updateMapping`'s `columns`, add `open_state_id: input.openStateId, closed_state_id: input.closedStateId` (undefined is skipped, and null clears, because the loop only skips `undefined`);
   - in `createMapping`'s INSERT, add the two columns with `input.openStateId ?? null, input.closedStateId ?? null`.
   - **Server check (the UI is not trusted):** when either id is non-null, load the project's states with `directoryRead((plane) => listStates(plane, slug, projectId))`. Use the effective project, `input.planeProjectId ?? current.plane_project_id`. Refuse with 422 any id that is not in the list or whose group is `triage`. In PATCH, also re-check the stored ids when `planeProjectId` changes without new state ids; or clear them (`open_state_id = NULL, closed_state_id = NULL`) on a project change, which matches the form, since it resets them.
   - **Unset vs. different:** the DB CHECK `repo_mappings_open_closed_differ` (migration 010) rejects equal ids; map its `23514` error to 400 if it is reached. The mirror already falls back when a stored state is later deleted.
3. `src/ui/client/types.ts`: `Mapping` gains `openStateId?: string | null; closedStateId?: string | null;`. The form then no longer needs its local cast (`stored`), which can be replaced by `existing`.
4. Optional, `src/ui/client/pickers.tsx`: an `emptyLabel` prop on `StatePicker`. Its empty option reads "No state change", which is wrong here; it should read "Project default". The form's hints explain it meanwhile.
