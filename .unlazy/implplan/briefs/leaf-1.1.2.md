# Leaf brief: leaf-1.1.2 — implementation plan, GitHub side and Plane UI forks

You are an execution leaf in an orchestrated unlazy pipeline. Work only inside your contract.

## Repository

All paths below are relative to the repository root:
`/Users/nathanamare/Downloads/git_plane intergration`
`cd` there first. Use that absolute root whenever you run a command.

## Your deliverable

Write **`docs/plan/part-b-github-ui.md`**: the implementation plan for everything GitHub-facing,
the two Plane frontend forks, attribution, and operational tooling.

Source of truth: **`docs/superpowers/specs/2026-10-10-plane-github-sync-design.md`**.
Read it fully before writing. Your plan implements it; it does not redesign it.

Cover exactly these spec sections, and cite each one:
- **§7.1** PR and branch automation (lifecycle states, branch-regex rules, branch name format, the "mappings compile to rules" constraint, the six state groups and the never-write-into-`triage` rule)
- **§7.2** Smart Commits (the Jira grammar, `#comment` / `#time` / `#<transition>`, multi-key and multi-command lines, per-repo toggle, and the attribution table: trust `sender`, never `pusher` or commit author; handle `sender` being `ghost`)
- **§7.3** two-way issue mirroring (label-gated, field list, sync direction, per-field conflict policy)
- **§7.4** development information (branches/commits/PRs, check and deployment rollups, preview links, categorised links via title prefix, autolinks off by default because they need `Administration: Write`)
- **§7.6** operational features (dry-run/simulate, audit log with manual replay, backfill on connect)
- **§8** configuration surface and UI (instance-admin vs workspace-settings split, the **four-file** fork surface, nav entry + iframe route per app, auth via Plane's API and workspace role)
- **§9** attribution, identity and rate limits (service PAT on a least-privileged account, per-user PATs are full-privilege, email-based user mapping requiring exactly one match)

Do **not** cover the service core, queues, the echo-loop ledger, reference parsing, the rule
engine internals, or the test strategy — leaf-1.1.1 owns those. Do not write their file.

## Mandatory task format

Every task is a heading plus three bold fields. The verifier is strict:

```
### B1 Short imperative title
**Files:** src/github/app.ts, src/github/webhooks.ts
**Depends:** none
**Acceptance:** A concrete, checkable condition of at least twenty characters.

Prose: what to build, key decisions, and the spec rationale (§7.2).
```

Rules the verifier enforces, all of which fail the build if broken:
- Headings are `### B<n>`, ids **B1..Bn contiguous from 1**, no gaps, no duplicates. **At least 4 tasks** (expect 8-14 for this scope).
- `**Files:**` must be **repository-relative** — no leading `/`, no `..`, never empty.
- `**Depends:**` lists task ids or `none`.
- `**Acceptance:**` must be at least 20 characters and state an observable condition.
- Every `§N` you cite must be a real heading in the spec. A citation to a nonexistent section fails.
- The words TBD, TODO, FIXME, XXX, PLACEHOLDER must not appear anywhere.

Where the plan touches the Plane monorepo forks, state the exact files and keep the whole fork
surface to four files total across both apps, per §8.

## You must use the unlazy discipline (contract C10)

The skill lives at `/Users/nathanamare/.claude/skills/unlazy`. Read its `SKILL.md` and
`references/gates.md` first.

1. **Before writing the plan**, create your own ledger at **`docs/plan/agent-gates/part-b.GATES.md`**
   with at least 2 gates, at least one of them runnable with `CHECK:` and `EXPECT:`.
   One runnable gate must be exactly:

   ```
   - [ ] G1: part B passes the structural and spec-citation verifier
     CHECK: node scripts/verify-plan-part.mjs docs/plan/part-b-github-ui.md B
     EXPECT: plan part verification passed
     EVIDENCE: pending
   ```

2. Work the four passes: implement fully, reread as a domain expert and replace the cheap version
   of each part, hunt defects, then polish. No placeholders, no deferred remainder.

3. **Verify with the real checker** — hand-written evidence is detected and rejected:

   ```
   node /Users/nathanamare/.claude/skills/unlazy/scripts/gate-check.mjs --root . --cwd . --approve docs/plan/agent-gates/part-b.GATES.md
   ```

   Tick any manual gate's box yourself after recording its evidence. Finish only when every gate
   in your ledger is met.

## Ownership — do not write outside this

You own exactly:
- `docs/plan/part-b-github-ui.md`
- `docs/plan/agent-gates/part-b.GATES.md`

Writing any other file breaks the pipeline's ownership leases. Reading anything is fine.

When both files are complete and your ledger is fully met, stop and report what you wrote.
