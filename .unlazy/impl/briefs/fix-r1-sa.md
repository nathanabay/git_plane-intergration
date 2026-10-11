# Fix pass r1 — Sonnet implementer SA (leaf fix-r1-sa)

Read `.unlazy/impl/briefs/COMMON.md` and `.unlazy/impl/briefs/fix-r1-common.md` first; then each
finding's full text in `docs/impl/review-1.md`, and `.unlazy/impl/evidence/plane-webhook-probe.md`.

**Six implementers work at the same time** (Sonnet SA, SB; Codex CA, CB; Gemini Flash GA, GB),
each in its own files. Earlier sessions started these fixes and exited when the editor restarted:
files in your OWNS may already contain partial changes, and an earlier ledger may exist at your
ledger path — read both, keep what is right, finish the rest. If a whole-repo gate fails in a file
you do not own, it is another implementer's work in progress: wait and re-run; never edit it.

Codex implementer CA owns `src/app/rule-events.ts`, `rules.ts`, `reducers.ts`, `github.ts` and `tests/a8/**` (F7, F10). If F2's workspace filter needs a change in one of CA's files, describe the exact change in your fixes doc and tell the driver; do not edit it.

Your fixes document: `docs/impl/fixes-r1-SA.md` (one `## F<n>` section per finding below).
Your ledger: `docs/impl/agent-gates/fix-r1-sa.GATES.md` — copy every gate from
`.unlazy/impl/gates/fix-r1-sa.md` exactly, OWNS line included.

## OWNS

    src/app/main.ts, src/app/context.ts, src/app/credentials.ts, src/app/writers.ts, src/app/mappings.ts, src/app/identity.ts, src/app/issues.ts, src/app/pr.ts, src/app/push.ts, src/app/checks.ts, src/index.ts, src/config/**, src/api/**, src/queue/index.ts, src/queue/workers.ts, deploy/**, docker-compose.override.yaml, tests/queue/**, tests/deploy/**, tests/api/**, docs/impl/fixes-r1-SA.md, docs/impl/agent-gates/fix-r1-sa.GATES.md

## Your findings

- **F2 [BLOCKING], runtime half** — every Plane-side mapping lookup (`mappingsForProject` in `src/app/mappings.ts` and its callers) must also match the payload's `workspace_slug` to the mapping's workspace. (SB does the config-API half.)
- **F5 [MAJOR], app half** — `src/app/issues.ts`: compute the GitHub assignee diff only over logins in the workspace user map; never strip unmapped GitHub assignees. (CB makes the mirror emit removals for an empty Plane set.)
- **F6 [MAJOR]** — load `github_app_config` (decrypt with B9's `decryptSecret` + `GITSYNC_TOKEN_KEY`), prefer it over env, env as fallback; pick up changes without a restart (or at worker start, documented).
- **F9 [MAJOR]** — reducers enqueue `PlaneWrite`/`GithubWrite` jobs on `outbound-plane`/`outbound-github` with long-horizon retries; inbound jobs stay short (§4). Document how a reducer that needs a write's result (a created id) gets it.
- **F12 [MAJOR]** — when a sender is unmapped, try §9 email matching (the GitHub user's public email via the App, then B9 `matchPlaneUserByEmail` over workspace members); zero or several matches → loud audit failure, never a guess.
