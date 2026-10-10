# Handoff — Plane ↔ GitHub sync

Status at handoff: **design spec and implementation plan complete and verified. No product code written yet.**
The next session starts at task **A1**.

## What exists

| File | What it is |
|---|---|
| `docs/superpowers/specs/2026-10-10-plane-github-sync-design.md` | The design spec (546 lines). Source of truth. |
| `docs/plan/IMPLEMENTATION_PLAN.md` | **Start here.** 17 tasks in 5 dependency-ordered phases. |
| `docs/plan/part-a-service-core.md` | Tasks A1–A8: service core, Plane side. |
| `docs/plan/part-b-github-ui.md` | Tasks B1–B9: GitHub side, UI forks, ops. |
| `docs/plan/review-notes.md` | First adversarial review — 7 blockers. |
| `docs/plan/review-notes-2.md` | Second review — adjudicates all 7 CLOSED, raised 2 more (both fixed). |
| `docs/research/findings-plane.md` | Plane v1.4.2 API/webhook research, with code citations. |
| `docs/research/findings-github.md` | GitHub App permissions, events, rate limits. |
| `scripts/verify-*.mjs` | Gate oracles. Re-runnable; see "Verification" below. |

## The target instance

Plane **v1.4.2 Community Edition** at `tasks.qelal.et`, host alias `convpss`, install `/root/plane`.
Community Edition has **no** GitHub integration — `silo` is closed-source and Commercial-only, which
is why this project exists.

Facts read from the live host that drive the design:

- Host Caddy at `/root/caddy` terminates TLS, routes `tasks.qelal.et → plane-proxy:80` over an
  external `gateway` network. `/root/plane/docker-compose.override.yaml` already exists — that is
  the seam for the new `git-sync` container. Do not edit the upstream compose file.
- Existing Postgres 15.7, Valkey 7.2.11, RabbitMQ 3.13.6. **Add no new infrastructure.**
- `API_KEY_RATE_LIMIT=60/minute` is in `plane.env` and is yours to raise.
- `WEBHOOK_ALLOWED_IPS` / `_HOSTS` are empty; the design uses a public HTTPS webhook URL to avoid
  the question entirely.
- Watchtower runs `WATCHTOWER_LABEL_ENABLE=true` and no Plane container carries the label, so
  forked images will not be auto-replaced.
- Six state groups, including a `triage` group. Live projects are `QLL` and `DSAFDSF`, whose state
  names differ ("To Do" vs "Todo", "Won't Do" vs "Cancelled") — resolve states by
  `(project, group)`, never by name alone.

## The four things most likely to be got wrong

1. **The echo ledger is field-granular.** Plane emits one webhook per *changed field*, carrying
   `field`/`old_value`/`new_value`/`actor`. Hash `(side, event_id, field, normalized new_value)`.
   Whole-object hashing is explicitly wrong.
2. **Drop echoes on ingress, not egress.** An early draft inverted this; dropping outbound writes
   silently discards legitimate repeat human edits inside the TTL.
3. **Attribution uses `sender`, never `pusher` or the commit author.** GitHub documents `pusher`
   as git-supplied metadata, and `git commit --author` is forgeable. `sender` can also be the
   `ghost` user, a bot, or unmapped — fall back to the service identity and log it; never guess.
4. **Plane deletions fire no webhook.** Only a reconciliation sweep finds them. An unreachable
   issue is `orphaned`, never "closed".

## Corrections to apply

- **Spec §8 is wrong.** It says the fork surface is "four files". `makeplane/plane`'s
  `apps/admin/app/routes.ts` is an *explicit* React Router route config, so each app needs three
  files (nav entry, route component, `routes.ts`) — **six total**. The plan reflects six; the spec
  does not. Fix the spec before using it standalone.
- **Residual risk, unresolved:** B3's config API writes mappings. If any of those round-trip to
  Plane they must go through A4's write path, or the echo ledger is not authoritative for
  configuration. The plan assumes they stay local to the `gitsync` database. Confirm during A4/B3.
- **Open decision:** whether to raise `API_KEY_RATE_LIMIT` from `60/minute`, and to what.

## Verification

The plan was built under an `unlazy` pipeline (scope `implplan`, 34 gates, all met, none abandoned).
`.unlazy/` is tracked so a continuing session can read `PLAN.md`, the gate ledgers, the agent
briefs, `status.log` and `dispatch.json`. Only `.unlazy/locks/` is excluded: leases record the
authoring machine's pid, and a stale lease would refuse a legitimate `--claim` on another host.

Oracles that still run against the artifacts:

```
node scripts/verify-plan-coverage.mjs                                   # every buildable spec section has a task
node scripts/verify-plan-part.mjs docs/plan/part-a-service-core.md A 3,4,5,6,7.5,10
node scripts/verify-plan-part.mjs docs/plan/part-b-github-ui.md B 7.1,7.2,7.3,7.4,7.6,8,9
node scripts/verify-agent-commits.mjs docs/plan/part-a-service-core.md A
node scripts/verify-no-placeholders.mjs
```

Each exits nonzero and prints `FAIL:` on failure; a passing run prints a success marker.

### Oracle caveats worth knowing

These checkers were each tightened after they certified something false. Keep the lessons:

- `verify-plan-coverage.mjs` originally required a `.` after heading numbers, so every `§7.x`
  collapsed to `§7` and the whole feature set went unchecked while the gate reported green.
- `verify-agent-commits.mjs` originally matched commit *subjects*, which let seven **empty**
  commits pass as per-task work. It now requires each commit to actually modify the file.
- The placeholder scan was case-insensitive and rejected the live Plane state name "Todo". It is
  now case-sensitive, so uppercase `TODO` still fails but real data passes.

A passing gate is evidence about the oracle, not proof about the artifact. Read the artifact.

## Continuing in a cloud session

### Bootstrap

```bash
git clone https://github.com/nathanabay/git_plane-intergration.git
cd git_plane-intergration
git checkout master          # NOT main
node --version               # any Node 18+; the verifiers need nothing else
node scripts/verify-plan-coverage.mjs   # should print: plan coverage verification passed
```

Read `docs/plan/IMPLEMENTATION_PLAN.md`, then start at **A1**.

### What the cloud session does NOT inherit

| Missing | Consequence | What to do |
|---|---|---|
| Repo is **private** | Clone fails without auth | Provide a token or add the cloud identity as a collaborator |
| `.unlazy/locks/` | No leases | Deliberate. Leases hold a pid from the authoring machine; a cloud session must claim its own. The rest of `.unlazy/` **is** tracked and readable. |
| The `unlazy` skill | Lives at `~/.claude/skills/unlazy`, not in this repo | Optional. `scripts/verify-*.mjs` run standalone and are the real oracles. |
| SSH access to `convpss` | Cannot reach the live Plane instance | Only matters for A1 (deployment) and A8's live smoke test. Everything else is offline work. |

### Historical files that will NOT re-run

`docs/plan/agent-gates/*.GATES.md` are the six agent ledgers, kept as **evidence of what was
verified and when**. They embed absolute paths from the authoring machine
(`/Users/nathanamare/...`) in both their `CHECK:` lines and their recorded `cwd=`/`path=`
evidence. Do not try to re-run them; they are a record, not a live harness. The live oracles are
`scripts/verify-*.mjs`, which take repo-relative paths.

### Suggested opening prompt

> Read `HANDOFF.md` and `docs/plan/IMPLEMENTATION_PLAN.md`. We are implementing a Plane to GitHub
> sync service for a self-hosted Plane v1.4.2 Community Edition instance. Begin at task A1 and
> work the phases in dependency order. The spec at
> `docs/superpowers/specs/2026-10-10-plane-github-sync-design.md` is the source of truth; the
> plan implements it and does not redesign it. Before writing code, read the four pitfalls in
> HANDOFF.md -- the field-granular echo ledger, dropping echoes on ingress not egress,
> `sender`-only attribution, and Plane firing no webhook on delete.

### First real decision

A1 creates the `git-sync` container in `/root/plane/docker-compose.override.yaml` on the live
host. If the cloud session has no SSH access, write A1's artifacts (compose fragment, Caddy route
stanza, env additions) as files in this repo for a human to apply, rather than stubbing the task
as done.

## Git

Remote `origin` → `github.com/nathanabay/git_plane-intergration`.
Commit history is one commit per plan task: `A1`–`A8`, `B1`–`B9`.

Note: commit `aa48ea8` contains `.unlazy/` because an agent emptied `.gitignore` and force-added it.
`.gitignore` is restored and the files are untracked going forward, but they remain in that commit's
history. Nothing sensitive is in them (briefs, ledgers, lease files holding only scope/leaf/globs/pid).
Removing them from history entirely would need a rewrite and force-push, which was deliberately not done.
