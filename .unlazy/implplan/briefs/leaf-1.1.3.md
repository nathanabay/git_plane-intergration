# Leaf brief: leaf-1.1.3 — adversarial review of both plan parts

You are the review leaf in an orchestrated unlazy pipeline. Your job is to find what is wrong,
not to approve. A review that finds nothing is a failed review unless you can defend that.

## Repository

Repository root: `/Users/nathanamare/Downloads/git_plane intergration` — `cd` there first.

## What to review

Two implementation-plan parts, written independently by two different agents from one spec:

- `docs/plan/part-a-service-core.md` — service core and Plane side (spec §3, §4, §5, §6, §7.5, §10)
- `docs/plan/part-b-github-ui.md` — GitHub side, UI forks, attribution, ops (spec §7.1-§7.4, §7.6, §8, §9)

Source of truth: `docs/superpowers/specs/2026-10-10-plane-github-sync-design.md`. Read it first.

## What to hunt for, in priority order

1. **Spec drift** — a task that contradicts the spec, or quietly redesigns it. Check especially:
   the echo-loop ledger must be field-granular (§5); state mappings must compile to rules rather
   than get a second evaluator (§7.1); the fork surface must stay four files (§8); autolinks must
   be off by default (§7.4); Smart Commit attribution must use `sender`, never `pusher` or the
   commit author (§7.2); nothing may ever write a work item into the `triage` group (§7.1).
2. **Seams between the parts.** The two authors could not see each other's work. Look for
   duplicated responsibility, contradictory interfaces, and work that *neither* part claims —
   the gap is more dangerous than the overlap.
3. **Ordering defects.** A task whose `Depends:` is wrong or missing, or a dependency that
   points at a task in the other part without saying so.
4. **Unimplementable acceptance criteria** — an `Acceptance:` line nobody could decide.
5. **Platform limits the plan ignores**: Plane deletions fire no webhook (§1.3); the Plane API
   rate limit is 60/minute by default; a PAT carries its owner's full permissions (§9).

## Your deliverable

Write **`docs/plan/review-notes.md`**. The verifier is strict — it must contain:

- An explicit section for **Part A** and one for **Part B** (use those exact words).
- At least **three** specific task ids cited in `A<n>` / `B<n>` form, each with your finding.
- A line, at column 1, exactly one of:
  `VERDICT: BLOCKING` or `VERDICT: NON-BLOCKING`
- If and only if the verdict is BLOCKING, one or more lines beginning `- BLOCKER:` naming each
  blocking defect.
- At least 600 characters of substance. No TBD, TODO, FIXME or PLACEHOLDER anywhere.

Be concrete: cite the task id and quote the offending line. "Could be clearer" is not a finding.
State plainly when a part is genuinely sound — but say *what you checked* to conclude that.

## You must use the unlazy discipline (contract C10)

The skill is at `/Users/nathanamare/.claude/skills/unlazy`. Read `SKILL.md` and
`references/gates.md`.

Create your ledger at **`docs/plan/agent-gates/review.GATES.md`** with at least 2 gates, at least
one runnable. One runnable gate must be exactly:

```
- [ ] G1: the review is substantive and records a decidable verdict
  CHECK: node scripts/verify-review.mjs
  EXPECT: review verification passed
  EVIDENCE: pending
```

Verify with the real checker; hand-written evidence on a runnable gate is detected and rejected:

```
node /Users/nathanamare/.claude/skills/unlazy/scripts/gate-check.mjs --root . --cwd . --approve docs/plan/agent-gates/review.GATES.md
```

Tick manual gate boxes yourself after recording evidence. Finish only when every gate is met.

## Ownership

You own exactly `docs/plan/review-notes.md` and `docs/plan/agent-gates/review.GATES.md`.
Read anything; write nothing else. Do not fix the plans — report, and let integration fix.
