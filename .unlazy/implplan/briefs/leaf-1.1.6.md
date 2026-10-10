# Leaf brief: leaf-1.1.6 — second review, after the Gemini agents' fix-and-commit pass

Repository root: `/Users/nathanamare/Downloads/git_plane intergration` — `cd` there first. You own ONLY:
- `docs/plan/review-notes-2.md`
- `docs/plan/agent-gates/review2.GATES.md`

## What happened since the first review

You (a previous Claude session) reviewed both plan parts and returned **VERDICT: BLOCKING** with
seven blockers. That review is at `docs/plan/review-notes.md` — read it first.

Two Gemini agents then revised their own parts to resolve those findings and committed one
distinct commit per task. Part A went from 8 tasks to 8 (renumbered); part B went from 8 to 9,
adding the embedded React app. See `git log --oneline` — commits A1..A8 and B0..B9.

Note: the plan files were untracked before this pass, so `git diff` against an earlier plan state
is not available. Adjudicate against the **current artifacts**, using the first review as the
checklist.

## Your job

Decide, for **each of the seven blockers**, whether it is genuinely closed or still open. Quote
the current line that closes it, or state precisely what is still missing. Be adversarial: a
blocker is closed only if the artifact now says the right thing, not if it merely mentions the
topic.

The seven blockers, abbreviated — read the originals for full detail:

1. **A2** verified only GitHub signatures; Plane's `X-Plane-Signature` (§1.2) was unverified,
   leaving the public Plane ingress unauthenticated.
2. **A4's acceptance inverted the §5 dedupe** (dropped outbound writes instead of inbound echoes).
3. **B3–B6 each declared `Depends: none`** while all producing Plane writes — four write paths
   bypassing A4's `op_hash` record-before-write.
4. **B4 evaluated lifecycle states** with no dependency on A6 — the second parallel evaluator
   §7.1 forbids, or a missing dependency.
5. **The `triage` prohibition** (§7.1) sat in one consumer while three paths could still write there.
6. **No task owned the embedded React app** §8 requires, nor the persistence behind it.
7. **A3 defined two tables** while A4, A7 and B7 needed storage it never defined.

Also check these two, which the driver added during wave 3:

- **Fork surface correction.** §8 of the spec says "four files"; the driver verified that
  `makeplane/plane`'s `apps/admin/app/routes.ts` is an **explicit** React Router route config, so
  each app needs three files (nav, route component, routes.ts) — **six total**. Confirm part B now
  reflects six, and say whether the spec itself still needs correcting.
- **Regression check.** Both parts were edited heavily. Look for anything the fixes broke: tasks
  whose `Depends:` now form a cycle, renumbering that orphaned a reference, acceptance criteria
  that became undecidable, or a §-citation that no longer matches the task's content.

## Deliverable

Write `docs/plan/review-notes-2.md`. The verifier requires:

- A section naming **Part A** and one naming **Part B** (those exact words).
- At least three task ids cited in `A<n>` / `B<n>` form.
- A column-1 line, exactly one of: `VERDICT: BLOCKING` or `VERDICT: NON-BLOCKING`.
- If BLOCKING, one or more `- BLOCKER:` lines.
- At least 600 characters. No TBD, TODO, FIXME or PLACEHOLDER in uppercase.

Include a clearly marked section adjudicating **all seven** original blockers, each labelled
CLOSED or STILL OPEN. That is a gate requirement, not a suggestion.

Do not edit the plans. Report only.

## unlazy (contract C10)

Skill at `/Users/nathanamare/.claude/skills/unlazy`. Ledger at
`docs/plan/agent-gates/review2.GATES.md`, at least 2 gates, at least one runnable, including:

```
- [ ] G1: the second review is substantive and records a decidable verdict
  CHECK: node scripts/verify-review.mjs docs/plan/review-notes-2.md
  EXPECT: review verification passed
  EVIDENCE: pending
```

Verify with: `node /Users/nathanamare/.claude/skills/unlazy/scripts/gate-check.mjs --root . --cwd . --approve docs/plan/agent-gates/review2.GATES.md`
Finish only when every gate is met.
