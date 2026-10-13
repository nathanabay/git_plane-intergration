# Automated end-to-end suite: harness and scenarios S01–S27, S60 (G3)

The suite drives the real test Plane v1.4.2 (`http://100.85.50.109:8090`) and the real GitHub App on
`nathanabay/gitsync-test`. It lives in `scripts/e2e/` (plain Node ESM, outside `tests/`). The contract is in
`.unlazy/impl/briefs/e2e-suite.md`. G1 owns S28–S52.

## How to run

```sh
node scripts/e2e/run.mjs --list                 # every scenario
node scripts/e2e/run.mjs --only S14             # one scenario (the way the authors run it)
node scripts/e2e/run.mjs --only S05,S06 --keep  # keep what the scenarios created
node scripts/e2e/run.mjs --timeout 600          # per-scenario timeout in seconds (default 300; some scenarios set 600)
```

- Each run writes `docs/impl/e2e-runs/<runId>.md` (table and evidence) and `<runId>.json`. The exit code is non-zero
  when any scenario fails. A failure covered by a known defect is reported as `FAIL (E2E-n)`.
- **Prerequisites:** `gh auth token` works for a user who can write to the test repository; the rootless Docker
  context `rootless` runs `plane-test-*`; `~/plane-test/git-sync/.admin-pat` and `~/plane-test/.admin-credentials`
  exist. On first use the harness creates the fixture user `e2e-member@test.local` (role 15, Member, password in
  `~/plane-test/git-sync/.e2e-member`, 0600) and caches Playwright in `~/.cache/gitsync-e2e/`.
- **Guard:** on import, `lib.mjs` refuses any Plane URL except the test Plane or loopback, and any repository except
  `nathanabay/gitsync-test`. `gh()` also refuses every `/repos/…` path outside that repository.
- **Cleanup:** every created object is named `[e2e <runId>] …`. When a scenario finishes, its cleanups run in reverse
  order: issues are closed, Plane items deleted, the extra workspace deleted. After the final run, no `[e2e` issue was
  open on GitHub and no `[e2e` item was left in Plane.
- **Secrets:** tokens, keys, passwords and session cookies stay in memory or in the `docker run` environment. They are
  never put in argv or printed, and the runner redacts token and cookie patterns from logs.

## Harness (`scripts/e2e/lib.mjs`)

It implements the API in the brief exactly. The additions below are optional and do not change any of its shapes:

| Export | Notes |
|---|---|
| `cfg` | planeUrl, slug, projectId, projectKey, mappingId, repo, owner, repoName, runId, docker container names, outDir |
| `gh(method, path, body?)` | `{ status, data, headers }`; `repo:/issues` is shorthand for `/repos/<repo>/issues`; retries GitHub's secondary rate limits |
| `plane(method, path, body?)` | Plane v1 API with the admin key; path relative to `/api/v1/workspaces/<slug>`; retries 429 (the key is shared with G1) |
| `sql(query, params?)` | gitsync DB through `psql` in `plane-test-plane-db-1`; `$n` are bound as quoted literals; SELECT, WITH and RETURNING give rows |
| `planeOrm(py)` / `planeOrmJson(py)` | Django shell in `plane-test-api-1` |
| `app(body)` | async Node body inside `plane-test-git-sync-1`, with `config, db, tokenKey, credentials, ghClient, planeClient, installationOctokit(id), service` in scope |
| `web(calls, { admin?, as? })` | a Plane session signed in over HTTP (`/auth/sign-in/`, or `/api/instances/admins/sign-in/` for God mode). `as: "member"` uses the non-admin fixture and `as: "anonymous"` sends no cookies. A call is `[method, path, body?, { headers, raw, noOrigin }]`. Like a browser, writes send `Origin`. |
| `web([["SCREENSHOT", path, undefined, { file?, expectText?, textWaitMs? }]])` | headless Chromium (`mcr.microsoft.com/playwright:v1.55.0-noble`). It waits for network idle, then checks the page **and every iframe** for each string. Result: `{ status, file, finalUrl, found: { [text]: boolean }, frames: [{ title, src, width, height, viewportHeight }] }`, where `frames` lists every iframe (nested ones too) at a 1400×900 viewport. Verified on `/gitsync-test/settings/git-sync`: the repository name, which renders only inside the settings iframe, was found, and the frame measured `900×772` against a 900 px viewport. |
| `waitFor`, `scenario`, `name` | as in the brief; `scenario(..., { needs, timeout, defect })`; `ctx` also has `defect(id)` |
| extras | `assert`, `eq`, `sleep`, `planeAll`, `items(id)`, `linksForGh`, `linksForPlane`, `waitForPlaneItem`, `projectStates`, `projectLabels`, `ensurePlaneLabel`, `ensureGhLabel`, `createGhIssue`, `createPlaneItem`, `ensureMemberUser` |

## Scenarios and last results

The last results come from runs of 2026-10-13, 15:45–15:54 UTC, one scenario per `--only` run, against the build
redeployed with G4's and G5's fixes. Reports are `docs/impl/e2e-runs/2610131545-6424.md` … `2610131554-522f.md`.

**28 scenarios: 27 PASS, 1 FAIL (known defect E2E-3), 0 SKIP.**

| Id | Scenario | Result | What is checked |
|---|---|---|---|
| S01 | Health endpoint | PASS | `GET /git-sync/healthz` without a session → 200 `{"status":"ok"}`, JSON |
| S02 | Setup checklist | PASS | God-mode `setup-check`: every item has id, title, detail and a valid status; credentials, events, GitHub and Plane delivery pass; permissions may fail only for the missing `members: read` (a known non-defect); `ok` matches the items; a workspace session → 401 |
| S03 | Workspace health card | PASS | database, credentials decrypt, mapping 1 has no disabled reason and has delivery timestamps; `membersLinked` equals the `user_map` rows; `appEventsVerified` true |
| S04 | Instance health | PASS | database, App configured, mapping count equals `repo_mappings`; `disabled-mappings` does not list mapping 1 |
| S05 | Forged GitHub signature | PASS | random, sha1-scheme, truncated and non-hex signatures → 401; no audit, delivery or spool row; no link |
| S06 | Missing GitHub signature | PASS | absent and empty `X-Hub-Signature-256` → 401; nothing stored |
| S07 | Forged Plane signature | PASS | random, absent and `sha256=`-prefixed `X-Plane-Signature` → 401; nothing stored |
| S08 | Oversized body | PASS | 6 MiB through the proxy → 413 (Caddy, 5 MiB limit). Direct to the service above 25 MiB → 413 `{"error":"Payload Too Large"}` (chunked and Plane endpoint) or the connection reset after the 413 (declared length). A 512 KiB forged body → 401, so the limit is about size alone |
| S09 | Config API without a session | PASS | 9 workspace, member and instance routes → 401 anonymously; forged `session-id` / `admin-session-id` and malformed cookies → 401; no internals in the body |
| S10 | Cross-origin / non-JSON writes | PASS | with an admin session: foreign, `null`, look-alike and missing Origin → 403; text/plain, form and multipart → 415; anonymous cross-site DELETE of the mapping → 403; rule version and mapping unchanged |
| S11 | S1 traversal in rules | PASS | six traversal forms of `create_issue.project` (plain, `%2e%2e`, `%2E%2E%2F`, `…/..`, `..`, `KEY/../x`) → 422 naming the project; dry-run also 422; no version or traversal text stored; the valid identifier is accepted by dry-run |
| S12 | Authorization | PASS | Member (role 15): admin routes 403, PUT rules and PATCH mapping 403, instance routes 401, own-account route 200. Workspace admin on a second workspace (created for the run): 403 on all routes, 401 on instance routes; encoded `..%2F` slugs → 404. No identity row or write for the second slug |
| S13 | Static path traversal | PASS | nine traversal paths through the proxy and directly to the service (raw request lines, not normalised): never a file's content; only 400, 404 or the HTML app shell; NUL → 400 |
| S14 | GitHub → Plane content | PASS | `@nathanabay` → `mention-component … user_mention` for the linked Plane user; `#1` and `owner/repo#1` → links; table kept; code block literal and escaped; after settling: exactly one Plane link, one "Mirrored from" comment, one GitHub linkback |
| S15 | Plane → GitHub | PASS | `github`-labelled item → issue by the App with the `plane` label (and not `github`), description and "Mirrored from Plane" footer; exactly one Plane link, one GitHub linkback, one "Mirrored to" comment |
| S16 | GitHub title edit | PASS | the Plane name follows |
| S17 | GitHub description edit | PASS | the Plane description follows, with Markdown rendered and the old body replaced |
| S18 | Plane title edit not applied | PASS | after Plane's delivery is processed, the GitHub title is unchanged and no GitHub title write is queued (`source_of_truth: github`) |
| S19 | Assignee | PASS | assigning `nathanabay` → the linked Plane user is an assignee; unassigning removes them |
| S20 | Labels both ways | PASS | GitHub add/remove `e2e-label-a` ↔ Plane; Plane add/remove `e2e-label-b` ↔ GitHub; the gate label is kept |
| S21 | GitHub comment → Plane | PASS | `<strong>nathanabay</strong> commented on GitHub` with a link to the comment; mirrored exactly once |
| S22 | Plane comment → GitHub | PASS | posted **as `nathanabay`** (user token), "commented in Plane"; one comment each side, no echo |
| S23 | Close / reopen | PASS | close → Plane group `completed`; reopen → `unstarted`; GitHub stays open (no echo close) |
| S24 | Plane cancelled | PASS | GitHub `closed` / `not_planned`; Plane stays cancelled |
| S25 | Rapid title edits | PASS | two back-to-back edits; Plane settles on GitHub's final title |
| S26 | Unlabelled issue | PASS | the `opened` delivery is processed; no link, no Plane item (checked through the ORM), no linkback comment |
| S27 | Echo safety | PASS | after a GitHub edit and a Plane comment, outbound-write counts and both comment counts stay the same for 30 s (GitHub 2 comments, Plane 2); the title is not rewritten; the service's own changes came back as `echo` deliveries |
| S60 | Empty issue body | **FAIL (E2E-3)** | see below |

Earlier attempts, now fixed: the first S16 run used an empty issue body and hit E2E-3, so the scenarios now default to
a non-empty body and S60 covers the empty case. The first S25 run sent the two edits concurrently and GitHub itself
kept the earlier one, which was a test bug; the edits are now sequential. S12's first cleanup used the wrong Plane
delete call; it now hard-deletes and verifies the workspace is gone.

## Defect found: E2E-3 — an empty GitHub issue body is never mirrored

**What fails.** Plane v1.4.2 answers `400 {"non_field_errors":["Invalid HTML passed"]}` to `description_html: ""`.
`<p></p>` is accepted, which was checked directly against the Plane API. git-sync sends `""` whenever a GitHub body is
empty or only whitespace:

1. **Create:** a `plane`-labelled issue with no body. The plan's `create_issue` write fails with
   `Plane POST …/work-items/ returned 400`. Every later step fails with it (the "Mirrored from" comment, the link, the
   linkback), so no Plane item or sync link ever appears. Seen on #9 (S16's first run) and in every S60 run.
2. **Edit:** clearing the body of a linked issue. `update_issue` fails with `Plane PATCH …/work-items/<id>/ returned 400`,
   so the Plane description keeps the old text.

The failed outbox rows hold the evidence: `outbound_writes.status = 'failed'`, error `… returned 400`.

**Where.** `src/sync/text.ts:214` `textToHtml("")` returns `""`, because `markdown()` skips blank lines and joins
nothing. Its callers pass that straight to Plane:
- `src/sync/mirror.ts:483`: the create fields in `createPlaneItem`, used by both `planPlaneCreate` and the inline path
- `src/sync/mirror.ts:392`: the `edited` → `description` update

**Suggested fix.** Never send an empty description to Plane. In `mirror.ts`, add a helper such as
`const planeDescription = async (body, ctx) => (await textToHtml(body, ctx)) || "<p></p>";` and use it at lines 392 and
483. A defensive alternative is to normalise `description_html: ""` to `"<p></p>"` in `PlaneWritePath` (`src/sync/plane.ts`)
for `create_issue` and `update_issue`, which also covers any future caller. Regression tests:
- a unit test that a `plane`-labelled issue with `body: null`, `""` or `"  \n"` produces a `create_issue` write whose
  `description_html` is non-empty;
- the same for an `edited` delivery that clears the body;
- S60 in this suite, which should PASS after redeploying.

### E2E-3 fix (code, not yet redeployed)

- **Confirmed in Plane v1.4.2's source:** `plane/api/serializers/issue.py:83-90` parses `description_html` with lxml's
  `html.fromstring`, which raises on an empty or whitespace-only document; Plane answers that with 400 "Invalid HTML
  passed". The empty value Plane stores itself is `<p></p>`, the `Issue.description_html` model default
  (`plane/db/models/issue.py:138`). Context7 (`/websites/developers_plane_so`) says only that content that can't be
  sanitized is rejected with a 400.
- **`src/sync/mirror.ts`:** the new helper `planeDescriptionHtml()` (with the exported constant
  `PLANE_EMPTY_DESCRIPTION = "<p></p>"`) is used for both the create fields (`createPlaneItem`, which also feeds the
  planned create) and the `edited` body update. These are the only places that build `description_html`: the
  `KEY-NEW` and rule creates in `src/app/pr.ts` and `src/github/pr-automation.ts` send no description, and Plane
  comments always start with an attribution paragraph, so they are never empty. Non-empty bodies are unchanged.
- **Regression test `tests/mirror/e2e3-empty-description.test.ts`:** its fake refuses an empty description exactly as
  Plane does. It covers a `null`, `""` or whitespace-only body on create (inline and planned) and on clearing a linked
  issue's body, plus a control with content. With the old behaviour put back temporarily, the three empty-body tests
  fail with the same 400; with the fix, all 4 pass.
- **Checks:** the typecheck is clean. The 18 test files that exercise the mirror were each run under `timeout 300`:
  185 tests, all passing. S60 should PASS once the service is redeployed.
