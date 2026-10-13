# Parity plan, wave 2

Spec Amendment A1 (§12 of the spec) is **approved by the user**; it is now the source of truth for
C0–C8 and N1–N7. Plan: `docs/plan/parity-plan.md`. Wave-1 reports: `docs/impl/parity-w1-*.md`.
Migration 010 and its helpers are in `src/db/parity.ts` (G4) — use them, do not re-implement them.

Same rules as wave 1: Context7 (find-docs / `npx ctx7@latest`) for every GitHub or Plane behavior,
cited by library id; regression tests in `tests/<area>/parity2-<you>.test.ts`; **no test runs**,
typecheck only; edit only your row; never stage, commit or push. Report in
`docs/impl/parity-w2-<you>.md` and reply `<YOU> DONE`.

## Ownership

| Agent | Tasks | Owns |
|---|---|---|
| G3 (Claude Opus) | **C1, C2, C3 server side**: install/connect callback with owner handoff (`GET /app/installation-requests`), GitHub user OAuth (state + PKCE, code exchange, refresh under the per-user lock, re-authorization flag, disconnect), user-token GitHub client and attribution for linked users, user-scoped repository listing and the save-time re-check | new `src/ui/install-flow.ts`, new `src/ui/oauth-flow.ts`, new `src/auth/github-user.ts`, `src/sync/github.ts`, `tests/ui/parity2-g3.test.ts` |
| G4 (Claude Opus) | **N3**: branch-name template validation, the `[Branch] suggested: …` link, Create branch (installation token, `POST /repos/{owner}/{repo}/git/refs`), and the Development panel: its data endpoint and iframe page in our UI, plus the Plane v1.4.2 fork patch adding the panel to the work-item sidebar | `src/sync/dev-info.ts`, new `src/ui/dev-panel.ts`, new `src/ui/client/DevPanel.tsx`, `apps/web/**`, `packages/**`, `tests/ui/parity2-g4.test.ts` |
| G5 (Codex, after its wave-1 N4/N6) | **UI and routes for C1–C3** (Connect button, org card, Disconnect, owner-handoff dialog, personal Connect/Reconnect with the unlinked-member banner and member-level page, repository picker), **N1** health card, banners and instance audit tab, **N5** first-run step and checklist, **N6** signed-commit setting | `src/ui/api.ts`, `src/ui/client/**` (except `DevPanel.tsx`), `src/ui/validate.ts`, `src/app/main.ts`, `tests/ui/parity2-g5.test.ts` |
| G1 (Codex, after its wave-1 C8/N7) | **C8 wiring** (`edition` and `ghe_subdomain` through `hosts.ts` in `credentials.ts` and the GitHub client), `githubWebOrigin` into the mirror deps, and the **N7 setup checklist** server check (App permissions and events via `GET /app`, last deliveries, rate-limit match) | `src/app/credentials.ts`, `src/app/issues.ts`, `src/app/github.ts`, `src/app/context.ts`, new `src/ui/setup-check.ts`, `tests/github/parity2-g1.test.ts` |
| G2 (Codex, after its wave-1 C6/C7/N2) | Wire the text converter into the mirror where G3 left hooks, and finish N2 | `src/sync/text.ts`, `src/sync/mirror.ts` (converter calls only), `src/github/**`, `src/app/push.ts`, `src/app/checks.ts`, `src/app/pr.ts` |

## Seams (agree through the driver)

- G3 exports route **handlers** from `install-flow.ts` and `oauth-flow.ts`; G5 registers them in
  `api.ts` and builds the UI on them. Agree the request/response shapes with G5 via the driver
  before G5 builds the screens.
- G4's Development panel data endpoint is exported from `dev-panel.ts`; G5 registers the route.
- Fork changes (G4) widen the fork surface; report the new file count. The driver updates
  `scripts/verify-fork-patch.mjs` and spec §8 to match.
