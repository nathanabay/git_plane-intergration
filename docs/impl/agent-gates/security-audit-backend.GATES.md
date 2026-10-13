# Backend security audit gate

OWNS: docs/impl/security-audit-backend.md, docs/impl/agent-gates/security-audit-backend.GATES.md

- [x] G1: The backend report exists and every finding, including Unconfirmed leads, has File, Attacker, Exploit, Impact, Evidence and Fix lines.
  CHECK: trusted parent-only Markdown structure validation; no target code or tests.
  EXPECT: AUDIT_BACKEND_REPORT_OK

Full-audit artifacts: /home/claudeuser/security-audit-skill/git_plane-intergration/run-1-backend.

User authorizes source review only. No source edits, builds, tests, fixtures, live/service probes, staging, commits or pushes. One permitted production npm advisory audit. Metadata, architecture, coverage, prompt packets and structured records are parent-owned in the external run directory.

PASSED: AUDIT_BACKEND_REPORT_OK — 5 Unconfirmed sections, all six required fields and Context7 citations, 18 source-control bullets.

SKILL VALIDATORS: PASS: 6 findings valid; PASS: 20 coverage units valid.

SOURCE STABILITY: 97 reviewed paths hashed; no changes between final independent review and report check. Reviewed commit remains 325519c13d031c77242b3dc176ff59e2ce37d998; shared worktree is dirty.

FINAL DISPOSITIONS: 0 confirmed (0 Critical/High/Medium/Low), 5 needs_validation, 1 rejected. Each retained needs_validation record has a fresh Phase3 and a distinct fresh Phase5 verifier. Source-only email assurance remains blocked, browser and host SSRF remain out of scope; these are explicit coverage limits.
