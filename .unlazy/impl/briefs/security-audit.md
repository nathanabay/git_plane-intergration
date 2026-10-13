# Deep security audit (two auditors, report only)

Repository: `/home/claudeuser/orca/workspaces/git_plane-intergration/seal` (working tree, including
uncommitted audit fixes and parity work in progress). It is a self-hosted Plane v1.4.2 ↔ GitHub sync
service that holds **GitHub App credentials, per-user GitHub OAuth tokens, Plane API keys and webhook
secrets**, runs next to a live Plane instance, and writes into both systems. Spec:
`docs/superpowers/specs/2026-10-10-plane-github-sync-design.md` (including Amendment A1, §12).

## Rules

- **Report only.** Edit no file except your report and its ledger. Never stage, commit or push.
  Other agents are still editing `src/ui/api.ts`, `src/ui/client/**`, `src/app/main.ts`,
  `src/app/pr.ts`, `src/sync/github.ts`, `src/operations/outbox.ts` and `src/github/problems.ts`;
  audit them as they are and mark findings in half-finished code as such.
- **Use Context7** (find-docs skill, or `npx ctx7@latest library|docs …`) for every claim about how
  GitHub, Plane, Octokit, Node, React or another library behaves (for example signature algorithms,
  OAuth parameters, token lifetimes, Web Crypto, React escaping). Cite the library id. Confirm Plane
  v1.4.2 specifics in its source when they matter.
- No heavy runs. You may run `npm audit --omit=dev --json` once and read-only commands.
- Prove each finding: a concrete attacker, what they control, the request or event they send, and
  what they gain. No theoretical padding. Mark anything you could not confirm as **Unconfirmed**.

## Output: `docs/impl/security-audit-<side>.md`

    # Security audit: <side>
    SUMMARY: <n> Critical, <n> High, <n> Medium, <n> Low

    ### S1 [Critical|High|Medium|Low] short title
    File: path:line
    Attacker: who, and what they control
    Exploit: the concrete steps or request
    Impact: what they gain
    Evidence: quoted code (and Context7 doc quote where relevant)
    Fix: the concrete change

    ## Checked and sound
    - <area>: what you verified (one line each, at least 10)

Severity: Critical = remote compromise of secrets, tokens or cross-tenant writes without credentials;
High = privilege escalation, cross-workspace access, stored XSS, SSRF to internal services, secret
leakage to logs or the browser; Medium = needs an authenticated user or unlikely conditions; Low =
hardening.

Ledger: `docs/impl/agent-gates/security-audit-<side>.GATES.md` with one gate: the report exists and
every finding has File, Attacker, Exploit, Evidence and Fix lines. Reply
`SECURITY <SIDE> DONE: <counts>`.

## Split

**Side `web` (G4, Claude Opus): everything a browser or a Plane user can reach.**
- AuthN/AuthZ on every route in `src/ui/api.ts` and every handler it calls: Plane session check
  (`src/ui/plane-auth.ts`), instance-admin vs workspace-admin vs member, cross-workspace access
  (IDOR on ids in paths and bodies), and role checks done only in the UI.
- CSRF and origin checks on state-changing routes; cookie handling; CORS.
- The C1–C3 flows (`src/ui/install-flow.ts`, `src/ui/oauth-flow.ts`, `src/auth/github-user.ts`):
  state and PKCE, replay, callback spoofing, `installation_id` trust, open redirects, token and
  client-secret exposure to the browser or logs, referrer leakage.
- XSS: React UI (`src/ui/client/**`, any raw HTML), the Development panel (`src/ui/dev-panel.ts`,
  `DevPanel.tsx`), and the fork patches (`apps/**`, `packages/**`); framing and clickjacking of the
  iframes; security headers (CSP, frame-ancestors, X-Content-Type-Options).
- SSRF: user- or admin-supplied URLs the server fetches (GitHub Enterprise base URL and edition
  hosts in `src/github/hosts.ts`, any link or webhook URL), including DNS rebinding to internal
  services such as `plane-db`, `plane-redis` and `api:8000`.
- Static file serving (`src/ui/static.ts`): path traversal.

**Side `backend` (G1, Codex): everything that arrives by webhook, queue or configuration.**
- Webhook ingress (`src/api/**`): GitHub `X-Hub-Signature-256` and Plane `X-Plane-Signature`
  verification on the raw body, timing-safe comparison, secret rotation, replay and
  de-duplication, body size limits, the Plane spool, and unauthenticated paths.
- Attribution and authority: forged `sender`, `pusher` or commit author; the frozen `_authority`
  and `authoriseWrite`; cross-workspace writes through mappings, installations or replay.
- Injection: SQL (every `db.query`), and content that the service writes into Plane or GitHub
  (stored XSS in Plane comment HTML, markdown or mention injection in GitHub comments, Smart Commit
  commands, the text converter `src/sync/text.ts`, problem-report comments).
- Secrets: encryption at rest (`src/auth/identity.ts`, `src/app/credentials.ts`,
  `src/db/parity.ts`): algorithm, IV and tag handling, key management; logging and audit rows that
  could contain secrets, tokens, codes or payloads; error messages.
- Denial of service and resource limits: queue flooding, unbounded pagination, regexes (ReDoS) in
  parsers (`src/parse/**`, `src/sync/text.ts`), large pushes, the token buckets.
- Dependencies (`npm audit`), the Dockerfile and compose fragment (user, mounts, network exposure),
  and the deployment runbook's secret handling (`deploy/**`).
