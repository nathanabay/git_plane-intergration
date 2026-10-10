# Gates: integration — one coherent implementation plan

OWNS: docs/plan/IMPLEMENTATION_PLAN.md

Scope: merge both reviewed parts into a single ordered implementation plan that covers every buildable spec section

- [ ] N1: every child ledger parses and reports all gates met with current automatic evidence
  CHECK: node /Users/nathanamare/.claude/skills/unlazy/scripts/gate-check.mjs --root . --cwd . --status .unlazy/implplan/gates/leaf-1.1.1.md .unlazy/implplan/gates/leaf-1.1.2.md .unlazy/implplan/gates/leaf-1.1.3.md .unlazy/implplan/gates/leaf-1.1.4.md .unlazy/implplan/gates/leaf-1.1.5.md
  EXPECT: ALL MET
  EVIDENCE: pending

- [ ] N4: driver re-executed each child's runnable oracles with --reverify under its own toolchain, not merely read their recorded state
  EVIDENCE: pending

- [ ] N2: the joined plan covers every buildable spec section, has globally unique task ids, omits no authored task, and imposes an order
  CHECK: node scripts/verify-plan-coverage.mjs
  EXPECT: plan coverage verification passed
  EVIDENCE: pending

- [ ] N3: blocking review findings are resolved in the integrated plan, not merely recorded
  EVIDENCE: pending
