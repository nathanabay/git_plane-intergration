# Gates: implementation review round 4 (Claude reviewer)

OWNS: docs/impl/review-4.md, docs/impl/agent-gates/review-4.GATES.md

Scope: an adversarial, grounded review of tasks A1–A8 and B1–B9 after the round-3 fixes, adjudicating all
18 round-3 findings against the code and hunting regressions, written to docs/impl/review-4.md.
Per the user, oracle and whole-suite gates are skipped (the user runs all gates after coding); this is the only gate.

- [ ] G1: the review is decidable, grounded, and adjudicates every round-3 finding
  CHECK: node scripts/verify-impl-review.mjs docs/impl/review-4.md docs/impl/review-3.md
  EXPECT: implementation review verification passed
  EVIDENCE: pending
