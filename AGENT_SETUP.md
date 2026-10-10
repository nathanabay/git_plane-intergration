# Agent setup — required topology for continuing this project

This project is built by a fixed agent roster under an `unlazy` pipeline, hosted in Orca IDE.
**Continuing sessions must reproduce this setup, including for implementation.**

## Roster

| Role | Agent | Model | Owns |
|---|---|---|---|
| Author / implementer A | `agy` | `gemini-3.1-pro-high` | Part A work — service core, Plane side (tasks A1–A8) |
| Author / implementer B | `agy` | `gemini-3.1-pro-high` | Part B work — GitHub side, UI, ops (tasks B1–B9) |
| Reviewer | `claude` | Orca's configured Claude | Adversarial review. Writes no implementation. |

The driver (the session running this file) plans, dispatches, re-verifies, integrates and reports.
The driver never grades its own leaves on an agent's say-so.

## Prerequisites

```bash
command -v agy && command -v orca            # both required
agy models | grep gemini-3.1-pro-high        # the exact model id
ls ~/.claude/skills/unlazy/scripts/gate-check.mjs
```

`agy` is the Antigravity CLI; `--agent antigravity` does not exist in Orca, and `antigravity-ide`
is a GUI launcher with no headless mode. Use `agy` through an Orca terminal, as below.

## Creating the agents

Worktrees live under one **git** repo (a folder-kind Orca repo cannot hold git worktrees).

```bash
# Two Gemini authors — custom model means two-step create, not --agent
orca worktree create --name impl-part-a --repo id:<repoId> --no-parent --json
orca terminal create --worktree "id:<repoId>::<path>" --title impl-part-a \
  --command 'agy --model gemini-3.1-pro-high --dangerously-skip-permissions -i "Read BRIEF.md in this directory and execute it fully."' --json

# The Claude reviewer — built-in launcher is enough
orca worktree create --name review --repo id:<repoId> --no-parent --agent claude --json
```

Record each returned terminal handle; it is the dispatch handle. **Handles are session-scoped —
never reuse one from a previous session.** Re-list with `orca terminal list` after any restart.

On first launch each `agy` session shows a folder-trust prompt that
`--dangerously-skip-permissions` does *not* cover. Send a bare Enter to accept:
`orca terminal send --terminal <handle> --enter`.

## Wave protocol

Claim before dispatch, launch the whole wave before reading any result, re-verify every return.

```bash
node $U/gate-check.mjs --scope <scope> --leaf <leaf> --claim          # refuses on overlap
node $U/dispatch-check.mjs open  --scope <scope> --wave <w> --leaf <leaf> ...
orca terminal send --terminal <handle> --text "<brief pointer>" --enter   # launch each
node $U/dispatch-check.mjs start --scope <scope> --wave <w> --leaf <leaf> --handle <handle>
node $U/dispatch-check.mjs seal  --scope <scope> --wave <w>           # before any wait
# ... agent works ...
node $U/dispatch-check.mjs return --scope <scope> --wave <w> --leaf <leaf>
node $U/gate-check.mjs --root . --cwd . --reverify <leaf ledger>      # NOT --status
node $U/gate-check.mjs --scope <scope> --leaf <leaf> --release
```

Rules learned the hard way in the planning phase:

- **A history rewrite gets its own wave, alone.** It cannot run beside another committer.
- **Never bypass a refused claim.** A refusal usually means the leaf still holds a live lease from
  an earlier wave; release it, then claim.
- **Tell agents to `git add` by name.** One agent swept four driver-owned scripts into its commit;
  another force-added `.unlazy/` after emptying `.gitignore`. Leases coordinate, they do not sandbox.
- `--status` is not verification. Only `--reverify` re-executes.

## Implementation phases mapped to waves

Dependencies cross the A/B split, so waves are driven by `IMPLEMENTATION_PLAN.md` phases, not by
which agent owns which part. Both agents work in parallel inside a wave on their own tasks.

| Wave | Gemini A | Gemini B |
|---|---|---|
| 1 | A1, A6 | B1, B2, B9 |
| 2 | A2, A3 | — (idle; B3 is blocked on A3) |
| 3 | A4 | B3 |
| 4 | A5, A7 | B4, B5, B6, B7, B8 |
| 5 | A8 | — |
| 6 | — | — (Claude reviews everything) |
| 7 | fixes + commits | fixes + commits |
| 8 | — | — (Claude re-reviews the changes) |

Declare `OWNS:` as disjoint source globs before each wave and let `--claim` refuse any overlap.
Part A writes `src/queue/**`, `src/db/**`, `src/parse/**`, `src/rules/**`, `src/sync/**`, `tests/**`.
Part B writes `src/github/**`, `src/ui/**`, `src/operations/**`, `src/auth/**`, `apps/admin/**`,
`apps/web/**`. Verify these against the real `Files:` lines before dispatching; the plan is the
authority, not this table.

## Non-negotiable agent rules

Every agent brief must carry these, because each was violated at least once during planning:

1. **Use unlazy.** Write your own ledger before working, and finish only when every gate in it is
   met. `scripts/verify-agent-unlazy.mjs` requires `automatic-evidence=v1` with a valid definition
   digest, which only `gate-check.mjs` produces — hand-written evidence is rejected.
2. **One real commit per task.** The commit subject carries the task id as a standalone token, and
   the commit must actually change files. `scripts/verify-agent-commits.mjs` rejects empty commits;
   seven of them passed an earlier, weaker version of that check.
3. **Stage only what you own.** `git add <path>`, never `-A` and never `-f`.
4. **Never edit `.gitignore`.** `.unlazy/` is tracked so continuing sessions can read it, but never commit `.unlazy/locks/` — leases are per-machine runtime state.
5. **Commits come after the Claude review**, not during authoring.

## Portability note for new scopes

`.unlazy/implplan/` is published as a **record** of how the plan was produced: PLAN.md with the
contract inventory at revision 4, the six leaf ledgers with their evidence, every agent brief, the
append-only `status.log`, and `dispatch.json` covering all eight waves. A fresh clone can read it
with:

```bash
node "$HOME"/.claude/skills/unlazy/scripts/gate-check.mjs --status --scope implplan
# -> ALL MET (34 met) [scope implplan]
```

`--status` only parses; it executes nothing, so it works on any machine.

**Do not `--reverify` the `implplan` scope on another host.** Seven of its gates embed the
authoring machine's absolute skill path (`/Users/nathanamare/.claude/skills/unlazy/...`) in their
`CHECK:` lines, so they would fail on a path lookup rather than on substance. The scope is closed;
re-running it proves nothing.

**When you open a new scope for implementation, write portable `CHECK:` lines from the start.**
`CHECK:` runs through `/bin/sh`, so `$HOME` expands:

```
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/<scope>/gates/leaf-1.1.1.md
```

Keep every project oracle repo-relative (`node scripts/verify-*.mjs`) — those already run
unchanged anywhere, which the clean-clone test confirms.

## Review cadence

Claude reviews **after both Gemini agents finish**, then again **after their fix-and-commit pass**.
The reviewer's gate requires it to adjudicate each prior finding as CLOSED or STILL OPEN with a
quoted line, not to issue a general opinion. The driver then confirms at least one finding by
reading the artifact and attempts to refute one passed finding — both refutation attempts during
planning succeeded and changed the outcome.
