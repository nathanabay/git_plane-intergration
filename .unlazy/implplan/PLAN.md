# Plan: implementation plan for Plane ↔ GitHub sync

Scope: implplan
Depth: tree 3
Mode: orchestrated

## Contract

- **Interfaces:** Each authoring leaf writes one markdown file. Task headings are
  `### <PREFIX><n> <title>` with `**Files:**`, `**Depends:**`, `**Acceptance:**` on every task.
  Prefix `A` for leaf-1.1.1, `B` for leaf-1.1.2. Task ids are globally unique and run 1..n with
  no gaps within a part. Every task cites the spec section it implements as `§N`.
- **Source of truth:** `docs/superpowers/specs/2026-10-10-plane-github-sync-design.md` (546 lines).
  Plans must trace to it; a citation to a nonexistent section fails leaf gate G1.
- **Ownership:** disjoint, one file per leaf (see dispatch table).
- **Dependencies:** leaf-1.1.3 (review) needs both authoring leaves VERIFIED.
- **Host launch mode:** mixed, recorded honestly.
  Host is **Orca IDE** throughout; all three agents run as Orca workspace sessions.
  - leaf-1.1.1 and leaf-1.1.2: **Orca-hosted `agy` sessions on `gemini-3.1-pro-high`**, launched
    nonblocking via `orca terminal send`, each with a distinct Orca terminal handle. These are
    not Claude Code native subagents; the handle is Orca's, and the evidence boundary in
    `references/dispatch.md` applies to it exactly as to a native handle.
  - leaf-1.1.3: **Orca-hosted `claude` session** (Orca `--agent claude`), its own worktree and
    terminal handle, for the review pass.
- **Agent discipline (rev 2):** every agent must load the `unlazy` skill, write its own ledger at
  the path it owns under `docs/plan/agent-gates/`, and run `gate-check` until all of its gates are
  met. Hand-written evidence on a runnable gate fails `verify-agent-unlazy.mjs`, so the agent
  cannot satisfy its G3 by assertion.
- **Wave policy:** wave 1 launches both authoring leaves together (host concurrency 2).
  Wave 2 launches the review leaf after both are VERIFIED and their leases released.
- **Toolchain:** Node (for gate scripts), `/bin/sh`, checker run with `--root . --cwd .` from the
  repository root so repo-relative `CHECK:` paths resolve identically for leaf and parent.
- **Conventions:** repo-relative paths only, no traversal; markdown only; no code is written by
  this pipeline — the deliverable is the plan.
- **Manual review:** the driver owns every manual gate and must cite the exact artifact location.

## Current contract inventory

Contract revision: 4. Amendment (rev 4): after the two Gemini agents finish their fix-and-commit pass, the Claude agent must review the resulting changes. Amendment (rev 3): after the Claude review, each authoring agent must record one distinct git commit per planned task. Amendment (rev 2): host is Orca IDE; every dispatched agent must itself run the unlazy discipline and leave a machine-verified ledger.

| ID | Required outcome or constraint | Owner | Observing gate or manual review | Disposition | Revision |
|---|---|---|---|---|---|
| C1 | Plan covers the service core and all Plane-facing work | leaf-1.1.1 | leaf-1.1.1:G1, leaf-1.1.1:G2 | ACTIVE | 1 |
| C2 | Plan covers GitHub App, Smart Commits, dev info, UI forks, ops | leaf-1.1.2 | leaf-1.1.2:G1, leaf-1.1.2:G2 | ACTIVE | 1 |
| C3 | A Claude agent reviews both parts (user-specified) | leaf-1.1.3 | leaf-1.1.3:G1, leaf-1.1.3:G2 | ACTIVE | 1 |
| C4 | Two Gemini agents author the parts (user-specified) | driver | dispatch.json handles + status.log | ACTIVE | 1 |
| C5 | Parts are integrated into one ordered plan | node-1.1 | node-1.1:N2 | ACTIVE | 1 |
| C6 | Every buildable spec section has at least one planned task | node-1.1 | node-1.1:N2 | ACTIVE | 1 |
| C7 | No plan artifact contains placeholders | root | R2 | ACTIVE | 1 |
| C8 | Blocking review findings are resolved, not just recorded | node-1.1 | node-1.1:N3 | ACTIVE | 1 |
| C9 | Children are independently re-executed, not trusted | node-1.1 | node-1.1:N4 | ACTIVE | 1 |
| C10 | Every dispatched agent runs unlazy and leaves a ledger with checker-written evidence | leaf-1.1.1, leaf-1.1.2, leaf-1.1.3 | leaf-1.1.1:G3, leaf-1.1.2:G3, leaf-1.1.3:G3 | ACTIVE | 2 |
| C11 | Agents are hosted in Orca IDE workspaces | driver | dispatch.json handles + status.log | ACTIVE | 2 |
| C12 | Each authoring agent commits once per planned task, after the review | leaf-1.1.4, leaf-1.1.5 | leaf-1.1.4:G2, leaf-1.1.5:G2 | ACTIVE | 3 |
| C13 | Review findings are resolved or answered before the commit pass closes | leaf-1.1.4, leaf-1.1.5 | leaf-1.1.4:G4, leaf-1.1.5:G4 | ACTIVE | 3 |
| C14 | Claude reviews the changes after both Gemini agents finish | leaf-1.1.6 | leaf-1.1.6:G1, leaf-1.1.6:G3, leaf-1.1.6:G4 | ACTIVE | 4 |

## Tree

- 1 implementation plan ............ GATES.md
  - 1.1 authoring + review .......... gates/node-1.1.md
    - 1.1.1 service core / Plane .... gates/leaf-1.1.1.md
    - 1.1.2 GitHub / UI forks ....... gates/leaf-1.1.2.md
    - 1.1.3 adversarial review ...... gates/leaf-1.1.3.md
    - 1.1.4 commit pass, part A ..... gates/leaf-1.1.4.md
    - 1.1.5 commit pass, part B ..... gates/leaf-1.1.5.md
    - 1.1.6 second Claude review .... gates/leaf-1.1.6.md

## Leaf dispatch table

| Leaf | Owns | Needs | Tier | Planned wave | State |
|---|---|---|---|---|---|
| 1.1.1 | docs/plan/part-a-service-core.md, docs/plan/agent-gates/part-a.GATES.md | - | judgment | 1 | VERIFIED |
| 1.1.2 | docs/plan/part-b-github-ui.md, docs/plan/agent-gates/part-b.GATES.md | - | judgment | 1 | VERIFIED |
| 1.1.3 | docs/plan/review-notes.md, docs/plan/agent-gates/review.GATES.md | 1.1.1, 1.1.2 | judgment | 2 | VERIFIED |
| 1.1.4 | docs/plan/part-a-service-core.md, docs/plan/agent-gates/commit-a.GATES.md | 1.1.3 | judgment | 3 | VERIFIED |
| 1.1.5 | docs/plan/part-b-github-ui.md, docs/plan/agent-gates/commit-b.GATES.md | 1.1.3 | judgment | 3 | VERIFIED |
| 1.1.6 | docs/plan/review-notes-2.md, docs/plan/agent-gates/review2.GATES.md | 1.1.4, 1.1.5 | judgment | 4 | VERIFIED |

All three leaves are `judgment`: each produces an artifact requiring design decisions, not a
fixed mechanical pattern. Tier is mapped to a real control here — the authoring leaves run on
`gemini-3.1-pro-high` and the review leaf on a Claude agent — because the host exposes that choice.

## Status log

Events append to `.unlazy/implplan/status.log`.

## Ownership handover note (rev 3)

leaf-1.1.4 and leaf-1.1.5 reclaim the same plan files first owned by leaf-1.1.1 and leaf-1.1.2.
This is safe only because they are strictly sequential: both commit-pass leaves depend on
leaf-1.1.3, which depends on both authoring leaves, so the earlier leases are released before the
later claims. They are never concurrent and must never be placed in the same wave.

## Sequential fallback (wave ready-5)

leaf-1.1.4 must rewrite git history to replace seven empty commits with real per-task commits.
A history rewrite cannot run concurrently with another committer in the same repository, so
wave ready-5 carries leaf-1.1.4 alone and leaf-1.1.5/leaf-1.1.6 follow in ready-6. This is a
declared coordination constraint, not a host launch limitation.
