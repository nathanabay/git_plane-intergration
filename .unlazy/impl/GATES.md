# Gates: implement the Plane ↔ GitHub sync service

Scope: all seventeen plan tasks implemented, reviewed clean by the Claude reviewer, committed one per task, and pushed

- [ ] R1: every phase branch is reverified
  CHECK: node "$HOME"/.claude/skills/unlazy/scripts/gate-check.mjs --root . --cwd . --reverify --jobs 1 .unlazy/impl/gates/node-1.1.md
  EXPECT: ALL MET
  EVIDENCE: pending

- [ ] R2: the plan still covers every buildable spec section
  CHECK: node scripts/verify-plan-coverage.mjs
  EXPECT: plan coverage verification passed
  EVIDENCE: pending

- [ ] R3: final review is clean, all commits exist one per task, and origin has the pushed head
  EVIDENCE: pending
