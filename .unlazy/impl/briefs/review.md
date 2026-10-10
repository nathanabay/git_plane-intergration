# Reviewer brief — implementation review round N (Claude reviewer)

You are the **adversarial reviewer** in an orchestrated unlazy pipeline. You write **no
implementation** — only your review and your own ledger. Your round number N and file names are
given in the message that dispatched you.

## Repository

Shared working tree: `/home/claudeuser/orca/workspaces/git_plane-intergration/seal`. Nothing of
the implementation is committed yet (commits come after a clean review), so review the working
tree, not git history. Two implementers may be idle in other terminals; do not message them.

## What to review

The implementation of all 17 plan tasks (A1–A8, B1–B9) against:
1. `docs/superpowers/specs/2026-10-10-plane-github-sync-design.md` — the source of truth.
2. `docs/plan/IMPLEMENTATION_PLAN.md`, `docs/plan/part-a-service-core.md`, `docs/plan/part-b-github-ui.md`.
3. `HANDOFF.md` — especially the four pitfalls: field-granular echo ledger; echoes dropped on
   ingress, never by skipping outbound writes; attribution from `sender` only (never `pusher` or
   commit author; ghost/bot/unmapped fall back to the service identity and are audited); Plane
   deletions fire no webhook, so unreachable issues become `orphaned`, never closed.
4. `.unlazy/impl/briefs/*.md` — the contracts each leaf was given.
5. `.unlazy/impl/evidence/plane-webhook-probe.md` — facts measured on a real Plane v1.4.2.

Code: `src/**`, `tests/**`, `apps/**` + `packages/**` (the Plane fork patches), `deploy/**`,
`Dockerfile`, `docker-compose.override.yaml`. The driver's oracles (`scripts/verify-*.mjs`) all
pass; your job is to find what they **do not** catch: spec violations, security holes,
correctness bugs under concurrency or failure, missing behaviour, dead code paths, wrong
assumptions about Plane or GitHub. Run anything you like (tests, oracles, `node -e` probes); a
throwaway Postgres/Valkey is available via `scripts/lib/postgres.mjs` / `valkey.mjs`. Do not edit
any file other than your two outputs.

## Items the driver asks you to adjudicate explicitly (each needs a finding or a reasoned PASS)

- B6 Plane→GitHub label sync: the probe shows Plane label activity carries **label UUIDs**, not names.
- B4 Smart Commits claim the SHA before writing, so a failed write is never retried (at-most-once).
  Is that compatible with §5 "processed exactly once" and §7.2?
- B6 mirroring: duplicate-create race and assignee removal (wave 5 was asked to fix both — verify).
- B2: the web iframe renders while workspace permissions are still loading.
- Smart Commit `#time`: Plane CE has no worklog API, so time is logged as a comment. Acceptable per §7.2?

## Output — `docs/impl/review-N.md`, in this exact shape (the checker is strict)

```
# Implementation review — round N

VERDICT: BLOCKING            (or NON-BLOCKING — only when no BLOCKING or MAJOR finding is open)

## Task verdicts
- A1: PASS — one line on what you checked
- A2: FINDINGS — F3, F7
… every task A1–A8 and B1–B9 …

## Previous findings            (rounds 2+ only: every finding of the previous round)
- prev F1: CLOSED — "<quoted line of code or text that proves it>"
- prev F2: STILL OPEN — "<quoted line that shows it>"

## Findings
### F1 [BLOCKING] short title
File: src/path/file.ts:123
Spec: §5, §7.3
Evidence: what you ran or read, and what happened
Fix: the concrete change required
```

Severity: **BLOCKING** = violates the spec or a pitfall, or loses/corrupts data, or a security
hole; **MAJOR** = wrong behaviour in a realistic case, or a required feature missing; **MINOR** =
quality, robustness or clarity. Be specific and verifiable; no praise, no style nits as MAJOR.
Round 2+ findings are numbered from F1 again; the `prev` lines refer to the previous file.

## Unlazy — mandatory

Load the `unlazy` skill. Create your ledger `docs/impl/agent-gates/review-N.GATES.md` (OWNS: your
two files) with at least:

    - [ ] G1: the review is decidable and grounded
      CHECK: node scripts/verify-impl-review.mjs docs/impl/review-N.md   (round 2+: add the previous review path)
      EXPECT: implementation review verification passed
      EVIDENCE: pending

    - [ ] G2: every driver oracle passes on the tree I reviewed
      CHECK: sh -c 'for o in verify-a1-deploy verify-rules-contract verify-identity-contract verify-a3-schema verify-a2-ingress verify-a4-writepath verify-b3-config-api verify-a5-a7 verify-b4-b8 verify-wiring verify-fork-patch; do a=""; [ $o = verify-fork-patch ] && a=all; node scripts/$o.mjs $a >/dev/null 2>&1 || { echo "FAIL $o"; exit 1; }; done; echo "all oracles passed"'
      EXPECT: all oracles passed
      EVIDENCE: pending

Run it with `gate-check --approve --timeout 1800` until ALL MET, after your final edit. Then
reply with the verdict and the count of findings by severity.
