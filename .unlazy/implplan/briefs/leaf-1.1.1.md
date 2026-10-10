# Leaf brief: leaf-1.1.1 — implementation plan, service core and Plane side

You are an execution leaf in an orchestrated unlazy pipeline. Work only inside your contract.

## Repository

All paths below are relative to the repository root:
`/Users/nathanamare/Downloads/git_plane intergration`
`cd` there first. Use that absolute root whenever you run a command.

## Your deliverable

Write **`docs/plan/part-a-service-core.md`**: the implementation plan for the sync service core
and every Plane-facing concern.

Source of truth: **`docs/superpowers/specs/2026-10-10-plane-github-sync-design.md`**.
Read it fully before writing. Your plan implements it; it does not redesign it.

Cover exactly these spec sections, and cite each one:
- **§3** deployment (container in docker-compose.override.yaml, Caddy route, webhook URLs)
- **§4** service internals (TypeScript/Node, octokit, BullMQ on existing Valkey, Postgres `gitsync` db, queue separation, Plane write semantics)
- **§5** echo-loop prevention (`sync_links`, `applied_ops`, field-granular op_hash, delivery-id and commit-SHA idempotency)
- **§6** linking and reference parsing (three-tier magic words, skip/ignore, identifier endpoint resolution, multi-issue)
- **§7.5** the rule engine (triggers, conditions, actions; state mappings compile to rules)
- **§10** testing (fixture-driven reducer tests, the echo-loop test, idempotency, grammar, security, smoke)

Do **not** cover GitHub App setup, Smart Commits grammar, dev-info surfacing, the Plane UI forks,
or attribution — leaf-1.1.2 owns those. Do not write their file.

## Mandatory task format

Every task is a heading plus three bold fields. The verifier is strict:

```
### A1 Short imperative title
**Files:** src/queue/index.ts, src/queue/README.md
**Depends:** none
**Acceptance:** A concrete, checkable condition of at least twenty characters.

Prose: what to build, key decisions, and the spec rationale (§4).
```

Rules the verifier enforces, all of which fail the build if broken:
- Headings are `### A<n>`, ids **A1..An contiguous from 1**, no gaps, no duplicates. **At least 4 tasks** (expect 8-14 for this scope).
- `**Files:**` must be **repository-relative** — no leading `/`, no `..`, never empty.
- `**Depends:**` lists task ids or `none`.
- `**Acceptance:**` must be at least 20 characters and state an observable condition.
- Every `§N` you cite must be a real heading in the spec. A citation to a nonexistent section fails.
- The words TBD, TODO, FIXME, XXX, PLACEHOLDER must not appear anywhere.

## You must use the unlazy discipline (contract C10)

The skill lives at `/Users/nathanamare/.claude/skills/unlazy`. Read its `SKILL.md` and
`references/gates.md` first.

1. **Before writing the plan**, create your own ledger at **`docs/plan/agent-gates/part-a.GATES.md`**
   with at least 2 gates, at least one of them runnable with `CHECK:` and `EXPECT:`.
   One runnable gate must be exactly:

   ```
   - [ ] G1: part A passes the structural and spec-citation verifier
     CHECK: node scripts/verify-plan-part.mjs docs/plan/part-a-service-core.md A
     EXPECT: plan part verification passed
     EVIDENCE: pending
   ```

2. Work the four passes: implement fully, reread as a domain expert and replace the cheap version
   of each part, hunt defects, then polish. No placeholders, no deferred remainder.

3. **Verify with the real checker** — hand-written evidence is detected and rejected:

   ```
   node /Users/nathanamare/.claude/skills/unlazy/scripts/gate-check.mjs --root . --cwd . --approve docs/plan/agent-gates/part-a.GATES.md
   ```

   Tick any manual gate's box yourself after recording its evidence. Finish only when every gate
   in your ledger is met.

## Ownership — do not write outside this

You own exactly:
- `docs/plan/part-a-service-core.md`
- `docs/plan/agent-gates/part-a.GATES.md`

Writing any other file breaks the pipeline's ownership leases. Reading anything is fine.

When both files are complete and your ledger is fully met, stop and report what you wrote.
