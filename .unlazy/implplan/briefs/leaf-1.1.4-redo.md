# Leaf brief: leaf-1.1.4 — redo part A's commit history with real per-task commits

Repository root: `/Users/nathanamare/Downloads/git_plane intergration` — `cd` there first. You own ONLY:
- `docs/plan/part-a-service-core.md`
- `docs/plan/agent-gates/commit-a.GATES.md`

## The defect

Your previous pass put the entire part A document into commit `c7ed35a` ("A1: Setup deployment
and container") and then created seven **empty** commits for A2 through A8. `git show --numstat`
reports zero files changed for each of them. The verifier accepted it because it only read commit
subjects; it has now been tightened to require that each task's commit actually modifies
`docs/plan/part-a-service-core.md`. Running it today gives:

```
FAIL: commit(s) name task(s) A2, A3, A4, A5, A6, A7, A8 but change nothing in docs/plan/part-a-service-core.md
```

Contract C12 requires one real commit per task. Empty commits are not work.

## What to do

Rebuild the history so each task's text lands in its own commit. Suggested approach:

1. Save the current finished document somewhere outside the repo, e.g.
   `cp docs/plan/part-a-service-core.md /tmp/part-a-final.md`
2. Move the branch pointer back to just before your first A commit, keeping your files:
   `git reset --soft be27ddb2647a35063745f5747e2cb6e188a22899`
   then unstage: `git restore --staged docs/plan/part-a-service-core.md`
3. Rebuild the document incrementally from `/tmp/part-a-final.md`: write the title plus **task A1
   only**, then `git add docs/plan/part-a-service-core.md && git commit -m "A1: <title>"`.
   Append task A2, commit `"A2: <title>"`. Continue through A8.
4. After the final commit, confirm the file is byte-identical to the saved version:
   `diff /tmp/part-a-final.md docs/plan/part-a-service-core.md` must print nothing. **Do not
   change the document's content** — only how it was committed.

**Only commits from `be27ddb2647a35063745f5747e2cb6e188a22899` upward are yours to rewrite.** Everything below that point is
another agent's work; do not touch it. No other agent is committing while you do this.

## Verify

```
node scripts/verify-agent-commits.mjs docs/plan/part-a-service-core.md A
node scripts/verify-plan-part.mjs docs/plan/part-a-service-core.md A 3,4,5,6,7.5,10
```

Both must print their passing markers. Then re-run your ledger until every gate is met:

```
node /Users/nathanamare/.claude/skills/unlazy/scripts/gate-check.mjs --root . --cwd . --approve docs/plan/agent-gates/commit-a.GATES.md
```

If a gate in your ledger carries stale evidence, the checker will re-run it; do not hand-edit
evidence lines.
