# Leaf brief: leaf-1.1.5 — close the B3 authorization blocker

Repository root: `/Users/nathanamare/Downloads/git_plane intergration`. You own ONLY `docs/plan/part-b-github-ui.md` and
`docs/plan/agent-gates/commit-b.GATES.md`. **Do not `git add` any file you do not own** — your
previous commit `be27ddb` swept in four driver-owned scripts. Stage your file by name.

## The blocker (from `docs/plan/review-notes-2.md`)

> B3 owns the config API that accepts mapping and rule-set writes and specifies no authentication
> or role check. §8 requires the workspace-role check "before rendering **or** accepting mapping
> writes"; B2 asserts both halves but its three files are fork-side client code that cannot gate a
> server endpoint on a different path. Authorization for every mapping write in the system is
> therefore owned by no task.

## Fix

In **B3**, state explicitly that the config API validates the Plane session **server-side on every
request** and **re-checks workspace role (admin/owner) on every write**, not only on render.
Make the Acceptance line decidable against that behaviour. Keep §8 cited. If B2's wording implies
it gates server-side writes, correct it to say it gates rendering only.

## Then commit and verify

Commit the change with B3 in the subject, staging only your own file:

```
git add docs/plan/part-b-github-ui.md
git commit -m "B3: authorize config API server-side on every mapping write"
```

If `.git/index.lock` appears, wait and retry. Then:

```
node scripts/verify-plan-part.mjs docs/plan/part-b-github-ui.md B 7.1,7.2,7.3,7.4,7.6,8,9
node scripts/verify-agent-commits.mjs docs/plan/part-b-github-ui.md B
```

Both must print their passing markers. Note the commit verifier now requires each task's commit to
actually change the file — empty commits are rejected. Finish by re-running your ledger until every
gate is met:
`node /Users/nathanamare/.claude/skills/unlazy/scripts/gate-check.mjs --root . --cwd . --approve docs/plan/agent-gates/commit-b.GATES.md`
