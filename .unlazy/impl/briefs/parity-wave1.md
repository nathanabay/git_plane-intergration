# Parity plan, wave 1 (four implementers)

Plan: `docs/plan/parity-plan.md` (tasks C0–C8, N1–N7). Research behind it:
`reports/GitHub integration UX audit.md`. Spec: `docs/superpowers/specs/2026-10-10-plane-github-sync-design.md`.

The working tree still holds uncommitted documentation-audit fixes (migration 009 included); build on
them. G5 is finishing a test fix in `src/app/*`, `src/ui/*` and some tests. **Wave 1 therefore
avoids `src/ui/**`, `src/app/main.ts`, `src/app/context.ts`, `src/app/github.ts`, `src/app/issues.ts`
and `src/app/reducers.ts`.** UI work (C1–C3, N1, N4–N6) is wave 2.

## Rules

- Use Context7 (`npx ctx7@latest library|docs …` or the find-docs skill) for every GitHub or Plane
  behavior you rely on, and cite the library id in your report. Plane's current docs describe a
  newer API than our v1.4.2 target; confirm v1.4.2 behavior in its source
  (`https://raw.githubusercontent.com/makeplane/plane/v1.4.2/<path>`) when it matters.
- Write regression tests in `tests/<area>/parity-<you>.test.ts`. **Do not run tests**; the driver
  runs everything after coding. Your only check is `node scripts/typecheck.mjs <your files>`.
- Edit only your row's files; send anything else to the driver. Never stage, commit or push.
- Report in `docs/impl/parity-w1-<you>.md` and reply `<YOU> DONE`.

## Ownership

| Agent | Tasks | Owns |
|---|---|---|
| G4 (Claude Opus) | **C0 schema**: migration 010 for every parity column and table (see list below) plus the db helpers | `src/db/**`, `tests/db/parity-g4.test.ts` |
| G3 (Claude Opus) | **C0 spec amendment** (draft for the user's approval), then **C4 and C5 server side** | `docs/superpowers/specs/2026-10-10-plane-github-sync-design.md`, `src/sync/mirror.ts`, `src/app/pr.ts`, `src/app/rules.ts`, `tests/mirror/parity-g3.test.ts` |
| G2 (Codex) | **C6 + C7** (new text converter) and **N2** (report failures where the user acted) | new `src/sync/text.ts`, `src/github/smart-commits.ts`, `src/github/pr-automation.ts`, `src/app/push.ts`, `src/app/checks.ts`, `tests/sync/parity-g2.test.ts` |
| G1 (Codex) | **C8** host derivation (pure module) and **N7** documentation | new `src/github/hosts.ts`, `src/config/env.ts`, `deploy/APPLY.md`, `apps/README.md`, `deploy/git-sync.env.example`, `tests/github/parity-g1.test.ts` |

## Migration 010 contents (G4 owns; others request additions through the driver)

- `github_app_config`: `client_id TEXT`, `client_secret_v1 BYTEA` (encrypted like the private key),
  `app_slug TEXT`, `edition TEXT` (`github` | `ghe_cloud` | `ghes`), `ghe_subdomain TEXT`.
- `oauth_states`: single-use signed state for the install and OAuth callbacks (nonce, purpose,
  workspace slug, Plane user id, PKCE verifier encrypted, expires_at, consumed_at).
- `user_tokens` (kind `github_oauth`): refresh token and both expiries, encrypted; a
  `needs_reauth` flag.
- `repo_mappings`: `open_state_id`, `closed_state_id` (C4), `report_problems BOOLEAN` default
  false (N2), `branch_template TEXT` (N3).
- `instance_settings` (or the existing settings table): `require_verified_commits` (N6).

## Task notes

- **G3, spec amendment:** add the C1–C8 and N1–N7 behaviors to the spec as a clearly marked
  amendment section. Do not change unrelated text. The user approves it before UI wave 2 builds on
  it, so write it as a proposal. Then C4 (the mirror uses the mapping's open and closed states with
  a fallback; Plane completed/cancelled closes GitHub with `state_reason`) and C5 (one Plane link
  and one GitHub comment per mirrored pair, as durable intents with stable keys, gated by linkback).
- **G2:** C6/C7 converter used by the mirror (G3 wires it into `mirror.ts`; agree the function
  signatures with G3 through the driver). Include Plane's fidelity bug cases (tables, image alt
  text, bare URLs, soft wraps, code spans and blocks untouched) as tests. N2 reports go through the
  outbox as intents with stable keys, gated by `report_problems`.
- **G1:** `hosts.ts` derives API and web origins for github.com, ghe.com (`api.<sub>.ghe.com`,
  `<sub>.ghe.com`) and GHES (`<base>/api/v3`, `<base>`), verified with Context7. N7: document the
  exact App permissions and webhook events (include "Commit statuses: Read"), the OAuth callback
  and setup URLs from C0, and the new env variables.
