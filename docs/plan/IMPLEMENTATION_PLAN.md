# Implementation plan — Plane ↔ GitHub sync

Integrated from two independently authored parts, after two adversarial review passes.

- Source spec: `docs/superpowers/specs/2026-10-10-plane-github-sync-design.md`
- Part A (service core, Plane side): `docs/plan/part-a-service-core.md` — tasks A1–A8
- Part B (GitHub side, UI, ops): `docs/plan/part-b-github-ui.md` — tasks B1–B9
- Reviews: `docs/plan/review-notes.md` (7 blockers), `docs/plan/review-notes-2.md` (adjudication + 2 new)

17 tasks. Every buildable spec section (§3, §4, §5, §6, §7.1–§7.6, §8, §9, §10) has at least one
owning task, verified by `scripts/verify-plan-coverage.mjs`, which derives the required section
list from the spec's own headings rather than a fixed list.

## Sequencing

Phases are derived from the `Depends:` fields in both parts. Tasks inside a phase are independent
of each other and may run in parallel; a phase begins only when every prior phase is complete.

### Phase 1 — foundations (no dependencies)

| Task | Deliverable |
|---|---|
| **A1** | Deployment and container: `git-sync` service in `docker-compose.override.yaml`, Caddy `/git-sync/*` route, the `gitsync` database (§3) |
| **A6** | Rule engine: triggers, conditions, the full §7.5 action set, first-match-wins ordering, and the no-write evaluation mode B8's dry-run needs |
| **B1** | Plane `apps/admin` fork — nav entry, route component, `routes.ts` registration (§8) |
| **B2** | Plane `apps/web` fork — nav entry, route component, `routes.ts` registration (§8) |
| **B9** | Attribution and identity: email mapping requiring exactly one match, service-account PAT, per-user PAT handling (§9) |

### Phase 2 — service skeleton and storage

| Task | Depends | Deliverable |
|---|---|---|
| **A2** | A1 | Webhook ingress and queues: GitHub signature verification via `@octokit/webhooks`, **Plane `X-Plane-Signature` HMAC-SHA256 verification**, `@octokit/app` installation-token minting, four BullMQ queues on the existing Valkey (§4) |
| **A3** | A1 | Schemas: `sync_links` (with `tier`, `created_by`), `applied_ops` (field-granular `op_hash`), delivery-id and commit-SHA ledgers, orphan status, audit log, and the configuration tables (§5, §8) |

### Phase 3 — the single Plane write path

| Task | Depends | Deliverable |
|---|---|---|
| **A4** | A2, A3 | Queue consumers and Plane write semantics: record `op_hash` before writing, drop **inbound** echoes, duplicate-link 400 treated as success, duplicate-label 409 as a free upsert, the `triage` write prohibition, and outbound rate limiting (§4, §5) |
| **B3** | A3 | Embedded React configuration app and config API — two entry routes, server-side Plane session validation and workspace-role re-check **on every write** (§8, §7.6) |

A4 is the chokepoint. Every later task that touches Plane writes through it; that is what keeps the
echo-loop ledger authoritative and the `triage` prohibition enforceable in one place.

### Phase 4 — features

| Task | Depends | Deliverable |
|---|---|---|
| **A5** | A4 | Reference parsing: branch name, PR title, PR body, commit messages; three-tier magic words; `skip`/`ignore`; `{IDENTIFIER}-NEW`; the all-PRs-must-merge rule (§6) |
| **A7** | A3, A4 | Deletion reconciliation sweep and `applied_ops` TTL pruning — 404 marks a link orphaned, never a state transition (§1.3) |
| **B4** | A4 | Smart Commits: `#comment`, `#time`, `#<transition>`; `sender`-only attribution with ghost/bot/unmapped fallback; optional signature requirement; per-project state resolution (§7.2) |
| **B5** | A6, A4 | PR and branch automation compiled into A6 rules — lifecycle states and branch-regex rules, never a second evaluator (§7.1) |
| **B6** | A4, A3 | Two-way issue mirroring: label-gated, §7.3 conflict defaults, cross-link comment (§7.3) |
| **B7** | A4, A3 | Development information rollups, updated in place via `/links/{pk}/`, plus provider-based preview detection (§7.4) |
| **B8** | A6, A3, A2, A4 | Operational features: dry-run, audit log with replay, backfill on connect (§7.6) |

### Phase 5 — verification

| Task | Depends | Deliverable |
|---|---|---|
| **A8** | A4, A5, A6, A7 | Test suites: fixture-driven reducer tests, the echo-loop test, idempotency, Smart Commit grammar, and the §10 security test proving a forged `--author` cannot act as that user. The live smoke test against `tasks.qelal.et` is separate from the offline suite (§10) |

## Review findings resolved

The first review returned BLOCKING with seven blockers; the second adjudicated all seven CLOSED
and raised two more, both since fixed:

| # | Finding | Resolution |
|---|---|---|
| 1 | Plane `X-Plane-Signature` unverified; public ingress unauthenticated | A2 |
| 2 | A4's acceptance inverted the §5 dedupe | A4 acceptance rewritten to drop inbound echoes |
| 3 | Four Part B write paths bypassed the echo ledger | B4–B7 now depend on A4 |
| 4 | B4 was a second state evaluator | B5 compiles into A6 |
| 5 | `triage` prohibition sat in one consumer | Moved onto A4's single write path |
| 6 | Nobody owned the §8 React app or its persistence | B3 added; A3 supplies the tables |
| 7 | A3 defined two tables while A4, A7, B7 needed more | A3 extended |
| 8 | B3's config API had no authorization | Server-side session + role re-check on write |
| 9 | Part A's A2–A8 were empty commits | History rebuilt; content byte-identical |

## Correction to the spec

**§8 understates the fork surface.** It states "Four files of fork surface total". Verified against
`makeplane/plane`: `apps/admin/app/routes.ts` is an *explicit* React Router route configuration
(it imports `index`, `layout`, `route` from `@react-router/dev/routes`), so registering a route
requires editing `routes.ts` in addition to the nav entry and the route component. The real surface
is **three files per app, six total**. B1 and B2 reflect six; §8 of the spec still says four and
should be corrected before the spec is used as a standalone reference.

## Known residual risk

B3 declares `Depends: A3` for its configuration tables but the config API also issues Plane writes
when applying mappings. If those writes bypass A4, the echo ledger is not authoritative for
configuration changes. Confirm during implementation whether B3 needs `A4` as well; the plan
currently assumes configuration writes are local to the `gitsync` database and never round-trip
to Plane.
