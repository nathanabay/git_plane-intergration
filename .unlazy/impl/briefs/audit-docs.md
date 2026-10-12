# Deep audit against current Plane and GitHub documentation (two auditors)

Repository: `/home/claudeuser/orca/workspaces/git_plane-intergration/seal`, branch `seal` (committed).
It is a Plane v1.4.2 CE <-> GitHub sync service: TypeScript on Node 24 (`src/`), tests (`tests/`),
Plane fork patches (`apps/admin`, `apps/web`, `packages/constants`), deployment (`deploy/`,
`Dockerfile`, `docker-compose.override.yaml`). Spec (source of truth for intent):
`docs/superpowers/specs/2026-10-10-plane-github-sync-design.md`. Earlier research:
`docs/research/` (treat as claims to verify, not as truth).

## Your job

Find places where the code **disagrees with how Plane or GitHub actually behave**, using **current
documentation fetched through Context7**, not memory. Examples of what counts: a wrong endpoint,
method, field name, header, status code or pagination scheme; a webhook payload field read from the
wrong place; signature verification that differs from the documented algorithm; permissions or
events the code relies on but the App does not request; rate-limit and retry behavior that ignores
documented headers; an idempotency or ordering assumption the platform does not guarantee; a
Plane v1.4.2 behavior that the fork patches or the client rely on incorrectly.

**Report only. Do not edit any file except your two output files. Never stage, commit or push.**

## How to use Context7 (mandatory: every finding cites it)

    npx ctx7@latest library "<name>" "<what to look up>"     # resolve a library id
    npx ctx7@latest docs <libraryId> "<one specific concept>" # fetch the docs

Useful ids: Plane `/websites/developers_plane_so`, `/makeplane/developer-docs`; GitHub REST
`/websites/github_en_rest` and the OpenAPI description
`/openapi/raw_githubusercontent_github_rest-api-description_main_descriptions_api_github_com_api_github_com_json`;
Octokit `/octokit/auth-app.js`, `/octokit/rest.js`; webhooks verification: resolve
"GitHub webhooks" and "@octokit/webhooks". One concept per query. Never put secrets in a query.

Where the docs are silent or ambiguous, you may confirm against the source of truth:
- Plane v1.4.2 source: `https://raw.githubusercontent.com/makeplane/plane/v1.4.2/<path>`
- A live test Plane v1.4.2 runs at `http://100.85.50.109:8090` (API key for the admin user is in
  `~/plane-test/git-sync/.admin-pat`, workspace `gitsync-test`). Read-only requests only.

## Resource rule (this host is the live Plane server)

No oracles, no `scripts/heavy.sh`, no whole test suite. If you run a test, at most:
`NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 <one file>`.

## Output

`docs/impl/audit-<side>.md` (side: `plane` or `github`), in this shape:

    # Docs audit: <Plane|GitHub>
    VERDICT: <n> BLOCKING, <n> MAJOR, <n> MINOR

    ### A1 [BLOCKING|MAJOR|MINOR] short title
    File: path:line
    Doc: <libraryId> — "<exact quoted sentence or code from the fetched docs>"
    Code: "<exact quoted line from our code>"
    Impact: what breaks in production, concretely
    Fix: the concrete change

    ## Verified correct
    - <area>: <what you checked> — <libraryId> (one line each; at least 10 entries)

Severity: BLOCKING = the integration fails or corrupts data in normal use; MAJOR = fails in a
realistic case (errors, retries, rate limits, pagination, permissions); MINOR = robustness or
clarity. No finding without both a Doc quote and a Code quote. Prefer depth over count.

Also keep a lightweight unlazy ledger `docs/impl/agent-gates/audit-<side>.GATES.md` (OWNS: your two
files) with one gate: the report exists and every finding has `Doc:` and `Code:` lines.
When done, reply in one line: `AUDIT <SIDE> DONE: <counts>`.
