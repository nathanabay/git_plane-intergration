# Gates: Claude review, round 3

OWNS: docs/impl/review-3.md, docs/impl/agent-gates/review-3.GATES.md

Scope: an adversarial review of all seventeen implemented tasks against the spec, with every finding located, cited and given a fix

- [ ] G0: this ledger passes unlazy lint
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/impl/gates/leaf-1.6.3.md
  EXPECT: LINT OK
  EVIDENCE: pending

- [ ] G1: the review is decidable and grounded: every task has a verdict, every round-2 finding is adjudicated with a quoted line, every finding has an existing file:line, a real spec section, evidence and a fix
  CHECK: node scripts/verify-impl-review.mjs docs/impl/review-3.md docs/impl/review-2.md
  EXPECT: implementation review verification passed
  EVIDENCE: pending

- [ ] G2: the reviewer ran unlazy and left a fully met, checker-evidenced ledger
  CHECK: node scripts/verify-agent-unlazy.mjs docs/impl/agent-gates/review-3.GATES.md
  EXPECT: agent unlazy verification passed
  EVIDENCE: pending

- [ ] G3: the driver confirmed at least one finding by reading the code and attempted to refute at least one, recording the outcome of each
  EVIDENCE: pending
