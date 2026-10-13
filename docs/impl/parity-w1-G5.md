# Parity wave 1 — G5

Scope follows the driver's direct assignment of N6 and N4, which supersedes the brief's older UI-wave exclusion. The signed-commit setting remains explicitly assigned to wave 2.

Acceptance gates before implementation:
- N6 defaults: new forms display the instance Smart Commit default and omit the setting unless changed; existing mappings retain their stored setting.
- N6 autolinks: mapping saves preserve the stored autolinks setting without offering unimplemented configuration.
- N6 versions: scoped rule history includes author/time; Restore creates a new version and updates the editor.
- N6 dry-run: every accepted trigger can be tested, including open trigger families, with conditions and templates evaluated without executing writes.
- N4 names: authenticated, complete Plane lookups resolve project/member/workspace names in lists and pickers.
- N4 pickers: named members replace UUID entry; named workspaces replace slug entry; one state-picker component serves lifecycle and branch/custom rules without discarding missing stored values.
- N4 audit: human event labels and summaries appear by default; raw details remain behind Show raw.
- N4 copy: visible UI text has no spec-section references, and the YAML example matches state-picker values.
- Regression coverage is written only in tests/ui/parity-g5.test.ts; typecheck is the only executed check; no staging, commit, push or signed-commit setting changes.

Completed 2026-10-12. Existing audit/test fixes were retained. Edits in this wave are confined to `src/ui/**`, the Plane-directory dependency in `src/app/main.ts`, this report, and `tests/ui/parity-g5.test.ts`.

## N6

- **Smart Commit default:** `src/ui/api.ts:210` exposes only the non-secret default to authenticated workspace admins. `src/ui/client/Workspace.tsx:91` loads it, displays it when the checkbox is untouched, and blocks initial submission if it cannot be loaded. `src/ui/client/mapping-form.ts:4` omits `smartCommitsEnabled` until a user changes it, so the server's current default applies on create and stored settings survive PATCH. The form resets its override after each new mapping.
- **Autolinks preservation:** the form displays the existing flag as disabled and never includes `autolinks` in its request. PATCH therefore preserves the database value, including concurrent changes; creation retains the server default. The unimplemented feature remains unavailable.
- **Version history and Restore:** `src/ui/api.ts:319` centralizes validated, append-only version creation. `:343` lists versions with author/time; `:348` restores a selected version as a new version authored by the current viewer, with workspace scoping and existing CSRF/auth guards. `src/ui/client/Workspace.tsx:236` loads history, resolves author names and resets the editor to the restored rules; `:263` renders Restore and disables it for the current version.
- **All rule triggers in dry-run:** `src/ui/validate.ts:251` asks the actual engine parser to validate specific triggers, including arbitrary accepted actions in open families and wildcard triggers. Expanded webhook choices cover checks, deployments, issues and comments as well as PRs/pushes. `src/ui/dry-run.ts:9` uses the shared event translator and pure evaluator, evaluates conditions/templates, supplies mapping context, and returns every evaluation for multi-trigger pushes. It never invokes an action executor. `src/ui/api.ts:483` also verifies mapping ownership with custom YAML and infers the source of recorded deliveries when unspecified. `src/ui/client/Workspace.tsx:780` offers webhook/source or specific-trigger input and displays multi-trigger results.
- **Signed commits:** intentionally left for wave 2 under the driver's instruction; no signed-commit UI or configuration change was made.

## N4

- **Project/member names:** `src/ui/plane-directory.ts:8` supplies complete, normalized project labels, human member names and project states. New authenticated lookup routes live at `src/ui/api.ts:211`; production wiring is `src/app/main.ts:62`. Mapped-repository rows, project dropdowns, linked-user rows and rule-version authors show names. Missing entities display an unavailable/former-member label instead of raw UUIDs, with visible lookup errors and reload actions.
- **Member picker:** `src/ui/client/Workspace.tsx:628` replaces Plane-user UUID entry with `MemberPicker` from `src/ui/client/pickers.tsx:21`. Active human members are selectable by name/email, while their stable IDs remain request values. Existing server-side membership and canonical GitHub-ID checks remain in place.
- **Workspace picker:** `src/ui/plane-auth.ts:105` loads all pages of the v1.4.2 instance-admin workspace list using only the admin cookie; malformed/repeated cursors fail rather than return partial choices. `src/ui/client/Admin.tsx:150` replaces slug entry with `WorkspacePicker` (`pickers.tsx:30`), shows workspace names in allow-list rows and resolves project/workspace names in disabled mappings. Workspace approval writes retain their existing authority checks.
- **One state picker:** `src/ui/client/pickers.tsx:7` is used for every lifecycle row, branch rule and custom-YAML state action. It displays state/group names, emits the engine's `group:Name` target syntax, excludes triage choices and preserves stored values when a state disappears. The optional ID-value mode is available for later mapping-state controls. `src/ui/client/rule-editor.ts:5` updates the selected custom rule's final state action while preserving its conditions and other actions. New branch rules require an explicit state selection.
- **Audit and copy:** `src/ui/client/audit.tsx:19` translates known event kinds and humanizes unknown kinds/outcomes. `AuditDetail` at `:25` puts the entire raw entry/payload inside a closed **Show raw** disclosure. User-facing lifecycle copy no longer includes spec-section numbers; the YAML example uses the same `completed:Done` syntax as the picker.

## Context7 evidence

Applied [find-docs](</home/claudeuser/.claude/skills/find-docs/SKILL.md>) as explicitly requested. For each library, ran `npx ctx7@latest library <name> <query>` before its `docs` queries. IDs below identify the Context7 source for each API fact. Plane's current documentation describes newer APIs; the pinned v1.4.2 source decides target-specific paths, shapes and permissions.

| API fact used | Context7 library ID and primary evidence |
| --- | --- |
| Project lists provide ID, name and identifier; the target's project list is under `/api/v1/workspaces/{slug}/projects/`. | `/websites/developers_plane_so`; [project documentation](https://developers.plane.so/api-reference/v2/projects/list-projects), pinned [v1.4.2 project routes](https://github.com/makeplane/plane/blob/v1.4.2/apps/api/plane/api/urls/project.py) and [serializer](https://github.com/makeplane/plane/blob/v1.4.2/apps/api/plane/api/serializers/project.py). |
| Workspace member-lite lists expose the user's ID, display/first/last names, email, role, active and bot flags; the target route is `/api/v1/workspaces/{slug}/members-lite/` and requires workspace-admin authority. | `/websites/developers_plane_so`; [member fields](https://developers.plane.so/api-reference/members/overview), pinned [routes](https://github.com/makeplane/plane/blob/v1.4.2/apps/api/plane/api/urls/member.py), [view](https://github.com/makeplane/plane/blob/v1.4.2/apps/api/plane/api/views/member.py), and [flattened serializer](https://github.com/makeplane/plane/blob/v1.4.2/apps/api/plane/api/serializers/member.py). |
| Project states have ID, name and group; the target list uses `/api/v1/workspaces/{slug}/projects/{projectId}/states/` and filters triage states. | `/websites/developers_plane_so`; [state documentation](https://developers.plane.so/api-reference/v2/states/list-states), pinned [routes](https://github.com/makeplane/plane/blob/v1.4.2/apps/api/plane/api/urls/state.py) and [view](https://github.com/makeplane/plane/blob/v1.4.2/apps/api/plane/api/views/state.py). |
| Target pagination uses `results`, `next_cursor` and `next_page_results`, and must be exhausted to offer complete picker choices. | `/websites/developers_plane_so`; [v1 migration example](https://developers.plane.so/api-reference/v2/migrating-from-v1), pinned [paginator](https://github.com/makeplane/plane/blob/v1.4.2/apps/api/plane/utils/paginator.py). |
| The target has a separately authenticated, paginated instance-admin workspace endpoint at `/api/instances/workspaces/`; it lists all workspaces and defaults to ten per page. | `/websites/developers_plane_so` provided general API context but does **not** document this session endpoint; confirmed the exact target behavior in pinned [instance routes](https://github.com/makeplane/plane/blob/v1.4.2/apps/api/plane/license/urls.py), [workspace view](https://github.com/makeplane/plane/blob/v1.4.2/apps/api/plane/license/api/views/workspace.py) and [session middleware](https://github.com/makeplane/plane/blob/v1.4.2/apps/api/plane/authentication/middleware/session.py). |
| GitHub webhook event families carry action/subject payloads; completed check suites and issue comments have their documented payload objects. Preview delegates this translation to the existing runtime adapter. | `/websites/github_en`; [webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads). No new Octokit calls were added. |
| Controlled selects use value/onChange; checkbox handlers read checked; async effect cleanup ignores obsolete responses; changing a component key resets its editor state. | `/reactjs/react.dev`; [select](https://react.dev/reference/react-dom/components/select), [input](https://react.dev/reference/react-dom/components/input), [effect cleanup](https://react.dev/learn/synchronizing-with-effects), [state reset](https://react.dev/reference/react/useState). |
| React's server renderer creates static component HTML, which is suitable for the written rendering assertions. | `/reactjs/react.dev`; [renderToStaticMarkup](https://react.dev/reference/react-dom/server/renderToStaticMarkup). These assertions were not executed. |
| YAML parse/stringify convert between source and JavaScript values; the state-action helper validates through the engine before/after editing. | `/eemeli/yaml`; [parse/stringify API](https://github.com/eemeli/yaml/blob/main/docs/02_parse_stringify.md). |
| Esbuild's build API supports stdin TSX, bundling, node/ESM output and external packages for the written component tests. | `/evanw/esbuild`; [build API](https://esbuild.github.io/api/), [package externalization](https://esbuild.github.io/api/#packages). No build was executed. |
| PGlite query supports parameterized SQL and returns rows; existing test setup supplies its in-memory database/migrations. | `/electric-sql/pglite`; [API](https://github.com/electric-sql/pglite/blob/main/docs/docs/api.md). |
| Node's test runner supports async test callbacks and strict assertions; temporary-directory and symlink APIs are promise-based. | `/websites/nodejs_latest-v24_x_api`; [test](https://nodejs.org/docs/latest-v24.x/api/test.html), [assert](https://nodejs.org/docs/latest-v24.x/api/assert.html), [filesystem](https://nodejs.org/docs/latest-v24.x/api/fs.html). |

## Regression coverage and verification

Nine regression tests are written in `tests/ui/parity-g5.test.ts`:

- `:29`: UI request omission, changing instance defaults, explicit Smart Commit override and autolinks preservation through actual API writes.
- `:58`: append-only Restore, author/time, workspace isolation, role checks, CSRF and missing-version errors.
- `:86`: accepted engine trigger grammar, open family actions, conditions/templates and zero writes in previews.
- `:109`: webhook previews for checks, deployments, GitHub/Plane issues/comments and multi-trigger pushes.
- `:130`: authenticated directory reads and complete two-page project/member/state results.
- `:157`: workspace cursor completion/failure and forwarding only the admin session.
- `:178`: production `composeRoutes` wiring for named Plane projects.
- `:201`: custom YAML state edits preserve conditions/unrelated actions and change the final state action.
- `:210`: actual rendered member/workspace/state pickers, missing-state retention, all lifecycle/custom state controls, rule history, stored autolinks, expanded dry-run choices and collapsed raw audit details.

Only this scoped check was executed (repeated after adding coverage):

```sh
node scripts/typecheck.mjs 'src/ui/**/*.ts' 'src/ui/**/*.tsx' src/app/main.ts tests/ui/parity-g5.test.ts
```

Final result: exit 0, `typecheck passed (70 project files)`. All nine implementation acceptance gates are met by code review and the scoped typecheck. Regression tests and their internal component bundle/render steps remain **unrun** for the driver. No UI build, tests, staging, commit or push was performed in this wave.

N6's signed-commit setting is the explicitly requested wave-2 handoff. All other assigned N6/N4 work is implemented; no schema or other-owner edit was needed.
