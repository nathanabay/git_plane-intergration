# Parity wave 1 — G3 report (C0 spec amendment, C4, C5 server side)

Status: done. Typecheck only, as the brief says (`node scripts/typecheck.mjs src/sync/mirror.ts
tests/mirror/parity-g3.test.ts` → passed, 45 project files). **No tests were run.** Nothing staged,
committed or pushed.

## Files changed (my row only)

| File | Change |
|---|---|
| `docs/superpowers/specs/2026-10-10-plane-github-sync-design.md` | New **§12 Amendment A1 (PROPOSED)**, appended. No earlier text was edited. Covers C0/C8 (App settings, edition), C1 connect + owner handoff, C2 personal linking, C3 picker, C4, C5, C6/C7, N1–N7, migration 010 contents, new risks. Written as a proposal for the user to approve before UI wave 2. |
| `src/sync/mirror.ts` | C4 and C5 (below). |
| `tests/mirror/parity-g3.test.ts` | New: 14 regression tests. |
| `src/app/pr.ts`, `src/app/rules.ts` | **Unchanged.** No C4/C5 server work lives there: the PR rollup link already exists and is keyed, and the state choice is the mirror's. |

## C4 — per-mapping open/closed states

- `loadMirrorSettings`: takes `linkbackEnabled`, `openStateId`, `closedStateId` from `MirrorMapping`
  when the caller sets them (new optional fields), otherwise reads the live row as
  `to_jsonb(repo_mappings)`. Reading it as JSON means the mirror works before and after
  migration 010 lands. A missing `linkback_enabled` counts as on (column default is true).
- `mirrorStateFor(states, closed, settings)` (exported): the chosen state wins while it exists and
  is not in the `triage` group; otherwise the default *completed* / *unstarted* state, as before.
  A chosen state that is gone is audited as `mirror_state_fallback` (detail: mapping, side,
  chosen and used state ids).
- GitHub → Plane `closed`/`reopened` uses it. Creates: a closed issue lands in the closed state; an
  open one in the chosen open state only if one is set (otherwise Plane's default, as today).
- Plane → GitHub: `githubStateForGroup` (exported): completed → `closed` + `state_reason:
  completed`; cancelled → `closed` + `not_planned`; other groups → `open` + `reopened`.

## C5 — cross-links per mirrored pair

- On pair creation, and only while linkback is on: one Plane `add_link` to the GitHub issue (title
  `GitHub issue owner/repo#N`) and one GitHub comment linking the Plane item.
  - GitHub → Plane: link URL is the delivered `issue.html_url`, so it is right for every edition.
    The existing GitHub "Linked to Plane work item" comment is now gated by linkback; before, it
    was always posted.
  - Plane → GitHub: new link (URL `<githubWebOrigin>/owner/repo/issues/<created number>`) and a new
    GitHub comment on the created issue. `MirrorDeps.githubWebOrigin` is new and optional; it
    defaults to `https://github.com` until it is wired in.
- Durable path: both are steps of the create generation's outbox plan, so a replayed delivery
  never registers them twice (the plan registers once per generation key). A retried link POST is
  harmless: Plane v1.4.2 rejects a duplicate URL with 400 "URL already exists for this Issue",
  which `PlaneWritePath` already treats as success.
- The direct (non-plan) path does the same with `apply`.
- The Plane-side "Mirrored from/to GitHub issue" comment is unchanged and not gated.

## Context7 / source citations

- GitHub REST `/websites/github_en_rest` (resolved with `ctx7 library "GitHub REST API"`):
  "Update an issue" body parameters: `state_reason` is one of `completed`, `not_planned`,
  `duplicate`, `reopened`, `null`, and "Ignored unless state is changed". "Create an issue comment"
  `POST /repos/{owner}/{repo}/issues/{issue_number}/comments`. `GET
  /user/installations/{installation_id}/repositories` (per_page max 100) and `GET
  /app/installation-requests` (both cited in the spec amendment).
- GitHub docs `/websites/github_en` (resolved library `/github/docs`; the `/websites/github_en`
  id the plan uses answered the queries): App registration URL parameters (`callback_urls`,
  `setup_url`, `setup_on_update`, `request_oauth_on_install`); user access token code exchange
  with `code_verifier`, response fields `expires_in`, `refresh_token`,
  `refresh_token_expires_in`; refresh with `grant_type=refresh_token`; ghe.com API host
  `api.SUBDOMAIN.ghe.com`.
- Plane `/websites/developers_plane_so` (resolved with `ctx7 library Plane`): "Create link":
  `url` required, `title` optional.
- Plane v1.4.2 source (newer docs describe a newer API): `apps/api/plane/api/serializers/issue.py`
  (duplicate link URL → `{"error": "URL already exists for this Issue"}`, http/https only);
  `apps/api/plane/db/models/state.py` (`triage` group; default manager excludes triage states);
  `apps/api/plane/bgtasks/notification_task.py` (`mention-component` with `entity_name=
  "user_mention"` and `entity_identifier`, for the amendment's C6 text).
- Not verified through Context7: the GHES `<base>/api/v3` form. The Context7 query returned only
  migration examples that use `/api/v3` paths on a GHES host. G1 owns host derivation.

## Requests for the driver (outside my row)

1. **`src/sync/github.ts`:** add `state_reason?: "completed" | "not_planned" | "duplicate" |
   "reopened" | null` to `update_issue.fields`. Until then `mirror.ts` casts at one place (commented).
   Optionally leave `state_reason` out of the echo op hashes: it is recorded today but nothing
   consumes it, so it only sits there until TTL pruning removes it.
2. **`src/app/issues.ts` (`mirrorDeps`, wave 2):** pass `githubWebOrigin` from G1's
   `src/github/hosts.ts`. Once G4 adds the columns to `Mapping`, optionally pass `linkbackEnabled`,
   `openStateId` and `closedStateId` on `MirrorMapping` to save the row read.
3. **G4 / migration 010:** the mirror reads `repo_mappings.open_state_id` and `closed_state_id`
   (Plane state UUIDs as text). Please keep those names.
4. **Existing tests that will need updating** because the behavior changed on purpose (not my files):
   - `tests/mirror/mirror.test.ts:211` and `tests/mirror/review-r1.test.ts:81`: a completed-group
     Plane state now writes `{ state: "closed", state_reason: "completed" }`. The started-group
     case in mirror.test.ts only checks `.state`, so it is unaffected.
   - `tests/mirror/review-r5-cc.test.ts` fixture: `h.mapping(...)` defaults to `linkback: false`
     in the a8 harness, and its F1 tests rely on the GitHub cross-link comment, which linkback now
     gates. Add `linkback: true` to that fixture.
   - Other harness-based tests that expect a GitHub comment after a GitHub → Plane create with the
     harness default (linkback off) would fail the same way. I found none besides review-r5-cc by grep.
   - `tests/a8/echo-loop.test.ts:49/177` map only `params.state`, so they are unaffected.
5. **N2's `pr.ts` / `rules.ts` parts** (an unresolved PR key gets a comment; a failed automation
   gets a Plane comment) are in files I own but not in my tasks. Assign them in a later wave.

## Tests written (`tests/mirror/parity-g3.test.ts`)

C4: chosen/triage/gone/fallback resolution; closed and reopened use chosen states read from the
row; mapping values override the row; a deleted chosen state falls back and is audited; no
choice keeps the defaults with no audit; completed → `completed`, cancelled → `not_planned`,
others → `reopened`; the state on create (closed, open with a choice, open with no choice).
C5, direct path: GitHub → Plane gets one link with the right URL and title and one comment;
linkback off → neither; Plane → GitHub links on a custom GHES origin and comments on the created
number; linkback off → neither.
C5, through the real ordered outbox and a8 harness: GitHub → Plane gives exactly one link and one
comment after a pending replay and a completed replay; linkback off registers nothing;
Plane → GitHub gives one link to the created issue number and one comment after a replay.
The test file adds the two state columns with `ADD COLUMN IF NOT EXISTS`, so it runs whichever
order it and migration 010 land in.

## Follow-up round 2 (driver-assigned)

Typecheck only (`node scripts/typecheck.mjs` over every file below → passed). No tests were run;
nothing staged, committed or pushed.

1. **`src/sync/github.ts`:** new exported `GithubStateReason = "completed" | "not_planned" |
   "duplicate" | "reopened" | null`, added as `state_reason?` on `update_issue.fields`. The PATCH
   still sends it, but it is **left out of the echo op hashes**: no webhook field change carries it,
   so the row would never be consumed. A `fields` object holding only `state_reason` is a no-op,
   which matches GitHub ignoring it unless `state` changes. Values re-checked through Context7
   `/websites/github_en_rest` ("Update an issue": `completed`, `not_planned`, `duplicate`,
   `reopened`, `null`; "Ignored unless state is changed").
2. **`src/sync/mirror.ts`:** the cast and the `GithubIssueFields` alias are gone;
   `githubStateForGroup` now type-checks against `GithubWrite` directly.
3. **Existing tests updated, fixture or expectation only:**
   - `tests/mirror/mirror.test.ts:211`: completed → `{ state: "closed", state_reason: "completed" }`.
     The started-group follow-up now asserts the whole object `{ state: "open", state_reason:
     "reopened" }` instead of only `.state`, so it is stricter than before.
   - `tests/mirror/review-r1.test.ts:81`: `{ state: "closed", state_reason: "completed" }`.
   - `tests/mirror/review-r5-cc.test.ts` fixture: `linkback: kind === "mirror"`. The mirror cases
     get back exactly the GitHub cross-link comment they exercised before C5 gated it. The PR
     cases keep the harness default (off), so their PR linkback comment counts are unchanged.
   - Checked and left alone: `tests/a8/echo-loop.test.ts:49/177` (they map only `params.state`; the
     state echo is still recorded and consumed) and `tests/writers/writers.test.ts:81`, where
     `{ state: "closed" }` is the write's input.
4. **New regression test** in `tests/mirror/parity-g3.test.ts`: `GithubWritePath` sends
   `state_reason` in the PATCH but records only the `state` op hash.
5. **Still pending:** wiring `githubWebOrigin` into `mirrorDeps` in `src/app/issues.ts`, which
   waits for G1's `hosts.ts`.
