# Fix pass r1 — Sonnet implementer SB (leaf fix-r1-sb)

Read `.unlazy/impl/briefs/COMMON.md` and `.unlazy/impl/briefs/fix-r1-common.md` first; then each
finding's full text in `docs/impl/review-1.md`, and `.unlazy/impl/evidence/plane-webhook-probe.md`.

**Six implementers work at the same time** (Sonnet SA, SB; Codex CA, CB; Gemini Flash GA, GB),
each in its own files. Earlier sessions started these fixes and exited when the editor restarted:
files in your OWNS may already contain partial changes, and an earlier ledger may exist at your
ledger path — read both, keep what is right, finish the rest. If a whole-repo gate fails in a file
you do not own, it is another implementer's work in progress: wait and re-run; never edit it.

Codex implementer CB owns `src/sync/mirror.ts`, `src/sync/dev-info.ts` and `src/operations/**` (F3, F4, F5-mirror).

Your fixes document: `docs/impl/fixes-r1-SB.md` (one `## F<n>` section per finding below).
Your ledger: `docs/impl/agent-gates/fix-r1-sb.GATES.md` — copy every gate from
`.unlazy/impl/gates/fix-r1-sb.md` exactly, OWNS line included.

## OWNS

    src/ui/api.ts, src/ui/validate.ts, src/ui/mapping-check.ts, src/ui/plane-auth.ts, src/ui/http.ts, src/ui/static.ts, src/github/smart-commits.ts, src/github/html.ts, src/auth/**, src/rules/**, tests/ui/auth.test.ts, tests/ui/instance.test.ts, tests/ui/operations.test.ts, tests/ui/static.test.ts, tests/ui/workspace.test.ts, tests/ui/harness.ts, tests/github/smart-commits.test.ts, tests/github/fakes.ts, tests/auth/**, tests/rules/**, Dockerfile, .dockerignore, docs/impl/fixes-r1-SB.md, docs/impl/agent-gates/fix-r1-sb.GATES.md

## Your findings

- **F2 [BLOCKING], config-API half** — on mapping create/update verify the Plane project belongs to the workspace (`GET /api/v1/workspaces/{slug}/projects/{pid}/` with the service PAT; 404/403 → 422) and the GitHub repo is reachable through the App with matching id and full name (injected dependency). Tests for both refusals. (`src/ui/mapping-check.ts` may already hold a start.)
- **F8 [MAJOR]** — make a transient Smart Commit write failure retryable without re-applying commands that already succeeded (per-command idempotency keys recorded on success, a queued retry of only the failed command, or similar).
- **F16 [MINOR], caller half** — pass the mapping's workspace to `claimCommit` (GA changes its key to `(sha, workspace)`; read GA's fixes doc / the migration for the final signature).
- **F18 [MINOR]** — when a push payload is truncated (more than 20 commits), fetch the rest with `GET /repos/{owner}/{repo}/compare/{before}...{after}`.
