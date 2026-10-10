# Plan: implement the Plane ↔ GitHub sync service

Scope: impl
Depth: tree 3
Mode: orchestrated

## Contract

- **Source of truth:** `docs/superpowers/specs/2026-10-10-plane-github-sync-design.md`. The plan
  `docs/plan/IMPLEMENTATION_PLAN.md` (A1–A8, B1–B9) implements it and does not redesign it.
- **Interfaces:** fixed per wave in the leaf briefs under `.unlazy/impl/briefs/`. Each interface a
  later task consumes is exercised by a driver-owned oracle in `scripts/verify-*-contract.mjs`
  that the leaf does not write, so a leaf cannot certify its own interface.
- **Ownership:** disjoint globs per concurrent leaf, declared in each leaf ledger's `OWNS:` and
  mirrored in the dispatch table below. Driver owns `scripts/**`, `package.json`,
  `package-lock.json`, `tsconfig.json`, `.unlazy/impl/**` until a later wave hands one over.
- **Host launch mode:** Orca IDE. Implementers are Orca-hosted `agy` sessions on
  `gemini-3.1-pro-high` (one for Part A, one for Part B); the reviewer is an Orca-hosted `claude`
  session. Every launch is a nonblocking `orca terminal send`; the Orca terminal handle is the
  dispatch handle.
- **Shared checkout (deviation from AGENT_SETUP.md's per-agent worktrees, recorded):** all three
  agent terminals live in the Orca worktree `seal` and write to the same working tree. Commits come
  only after review (C6), so per-agent worktrees would hide uncommitted Phase 2 output (A3) from
  the Phase 3 leaf that needs it (B3). Disjoint `OWNS:` leases coordinate writers.
- **Wave policy:** one leaf per agent per wave (dispatch-check requires a distinct handle per
  leaf), so a leaf bundles that agent's tasks for the phase. Host concurrency 2.
- **Toolchain:** Node 24 (runs `.ts` by type stripping: erasable syntax only), `tsc` 7 for
  typecheck, `node:test` for tests, `/bin/sh` for CHECK. Checker run from the repo root with
  `--root . --cwd .`. CHECK lines use `"$HOME"/.claude/skills/unlazy/...`; project oracles are
  repo-relative.
- **Conventions:** ESM, `.ts` import extensions, no enums/namespaces/parameter properties, no new
  dependencies without driver approval, stage by name only, never edit `.gitignore`.
- **Manual review:** the driver owns every manual gate and cites file:line evidence.

## Current contract inventory

Contract revision: 3. Amendment (rev 3, user): the `agy` account hit its usage limit; the two
implementers are replaced by two Orca-hosted Claude Code sessions on `claude-sonnet-5-5`
(`impl-sonnet-a` for Part A, `impl-sonnet-b` for Part B). The reviewer stays a Claude agent.
Previous contract revision: 2. Amendment (rev 2, user, mid-session): the review loop repeats — reviewer
findings go back to both Gemini agents, then back to the Claude reviewer, until the review is
clean; then commit and push.

| ID | Required outcome or constraint | Owner | Observing gate or manual review | Disposition | Revision |
|---|---|---|---|---|---|
| C1 | Every plan task A1–A8, B1–B9 implemented per its spec sections | leaves 1.1.x–1.5.x | each leaf's task gates | ACTIVE | 1 |
| C2 | Two implementers (Part A, Part B) and one Orca `claude` reviewer — `agy` gemini-3.1-pro-high until its limit, then Claude Code `claude-sonnet-5-5` (rev 3) | driver | dispatch.json handles + status.log | ACTIVE | 3 |
| C3 | Every agent runs unlazy with a checker-evidenced ledger | every leaf | leaf-*:G-unlazy (verify-agent-unlazy.mjs) | ACTIVE | 1 |
| C4 | The four pitfalls hold: field-granular op_hash, ingress echo drop, sender-only attribution, deletion → orphaned | leaves owning A3, A4, A7, B4, B9 | contract oracles + reviewer adjudication | ACTIVE | 1 |
| C5 | Reviewer re-reviews after every fix round until clean (no BLOCKING/MAJOR open) | node-1.6 | node-1.6 gates | ACTIVE | 2 |
| C6 | One real commit per task, task id in subject, made after the clean review | leaves 1.7.x | verify-agent-commits.mjs | ACTIVE | 1 |
| C7 | Work is pushed to origin | driver | `git ls-remote` vs local HEAD | ACTIVE | 2 |
| C8 | A1 applied on the live host `convpss` | human operator | — | OWNER_DECISION | 1 |
| C9 | A8 live smoke test run against tasks.qelal.et | human operator | — | OWNER_DECISION | 1 |
| C10 | Spec §8 corrected to six fork files | driver | spec lines 398, 462–468, 538 | ACTIVE | 1 |

C8/C9: the user confirmed (2026-10-10) that this machine **is** `convpss`. The driver runs as `claudeuser` (uid 1001): not root, not in the `docker` group, no passwordless sudo, so `/root/plane`, `docker compose` and Caddy are out of reach. A1 ships as files plus `deploy/APPLY.md`; deployment happens after the clean review, either run by the user or after the user grants access. Neither C8 nor C9 is reported as performed until it is.

## Tree

- 1 implementation ....................... GATES.md
  - 1.1 phase 1: foundations ............. gates/node-1.1.md
    - 1.1.1 A1 deploy + A6 rule engine ... gates/leaf-1.1.1.md
    - 1.1.2 B1, B2 forks + B9 identity ... gates/leaf-1.1.2.md
  - 1.2 phase 2: skeleton + storage ...... gates/node-1.2.md
    - 1.2.1 A2 ingress/queues + A3 schema  gates/leaf-1.2.1.md
  - 1.3 phase 3: write path .............. gates/node-1.3.md
    - 1.3.1 A4 Plane write path .......... gates/leaf-1.3.1.md
    - 1.3.2 B3 config app + API .......... gates/leaf-1.3.2.md
  - 1.4 phase 4: features ................ gates/node-1.4.md
    - 1.4.1 A5 parsing + A7 reconcile .... gates/leaf-1.4.1.md
    - 1.4.2 B4–B8 GitHub features ........ gates/leaf-1.4.2.md
  - 1.5 phase 5: verification ............ gates/node-1.5.md
    - 1.5.1 A8 test suites ............... gates/leaf-1.5.1.md
  - 1.6 review loop ...................... gates/node-1.6.md
  - 1.7 commit pass ...................... gates/node-1.7.md

Review-loop and commit-pass leaves are added as contract revisions once their round exists.

## Leaf dispatch table

| Leaf | Owns | Needs | Tier | Planned wave | State |
|---|---|---|---|---|---|
| 1.1.1 | docker-compose.override.yaml, Dockerfile, .dockerignore, deploy/**, src/index.ts, src/rules/**, tests/deploy/**, tests/rules/**, docs/impl/agent-gates/leaf-1.1.1.GATES.md | - | judgment | 1 | VERIFIED |
| 1.1.2 | apps/admin/**, apps/web/**, packages/constants/**, src/auth/**, tests/auth/**, docs/impl/agent-gates/leaf-1.1.2.GATES.md | - | judgment | 1 | VERIFIED |
| 1.2.1 | src/index.ts, deploy/**, src/api/**, src/queue/**, src/db/**, src/config/**, tests/api/**, tests/queue/**, tests/db/**, tests/deploy/**, docs/impl/agent-gates/leaf-1.2.1.GATES.md | 1.1.1 | judgment | 2 | VERIFIED |
| 1.3.1 | src/sync/**, src/queue/**, src/db/**, src/index.ts, src/config/**, tests/sync/**, tests/queue/**, tests/db/**, tests/deploy/**, deploy/**, docs/impl/agent-gates/leaf-1.3.1.GATES.md | 1.2.1 | judgment | 3 | IN-FLIGHT |
| 1.3.2 | src/ui/**, tests/ui/**, Dockerfile, .dockerignore, docs/impl/agent-gates/leaf-1.3.2.GATES.md | 1.2.1, 1.1.2 | judgment | 3 | IN-FLIGHT |
| 1.4.1 | defined at wave 4 | 1.3.1 | judgment | 4 | WAITING |
| 1.4.2 | defined at wave 4 | 1.3.1, 1.3.2 | judgment | 4 | WAITING |
| 1.5.1 | defined at wave 5 | 1.4.1, 1.4.2 | judgment | 5 | WAITING |

Tier maps to a real control: implementers run `agy --model gemini-3.1-pro-high`.

## Status log

Events append to `.unlazy/impl/status.log`.
