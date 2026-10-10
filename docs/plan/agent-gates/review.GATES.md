# Gates: adversarial review of plan parts A and B

OWNS: docs/plan/review-notes.md, docs/plan/agent-gates/review.GATES.md

Scope: find spec drift, seam gaps, ordering defects and undecidable acceptance criteria in
docs/plan/part-a-service-core.md and docs/plan/part-b-github-ui.md, and record a decidable verdict.

- [x] G1: the review is substantive and records a decidable verdict
  CHECK: node scripts/verify-review.mjs
  EXPECT: review verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=044957f7403a0c2e8f40381e54cc1bd23c66b7d5de17ef2f9ae85b665e149899; exit=0; EXPECT=matched; output-sha256=695181f939cc4cbe187b152b3a3e59dea0100ad1558b670f347cc55c08ffc98d; output-bytes=62; shell=/bin/sh; cwd=/Users/nathanamare/Downloads/git_plane intergration; path=17082c0eb005/62 entries

- [x] G2: this ledger states outcomes that can fail
  CHECK: node /Users/nathanamare/.claude/skills/unlazy/scripts/gate-lint.mjs docs/plan/agent-gates/review.GATES.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=6223c556f6efdf0e4f9f1da6914a4bc6420602bf9e1a66aa8e8a3b9870124492; exit=0; EXPECT=matched; output-sha256=c68ef83b7cf5732f2647d335bdc8c62e3a2994a073a568019a7e2c022635cde5; output-bytes=179; shell=/bin/sh; cwd=/Users/nathanamare/Downloads/git_plane intergration; path=17082c0eb005/62 entries

- [x] G3: every blocker names one task id and quotes the offending plan line
  EVIDENCE: 7 BLOCKER lines; each opens with a task id (A2, A4, B3/B4/B5/B6, B4, B3+B5+A6, B1/B2, A3) and carries a verbatim quote from that task plus the spec clause it breaks: A2 "Incoming requests are signature-verified" vs §1.2 X-Plane-Signature; A4 "Outbound queue workers ... drop messages that match recently applied operations" vs §5 inbound drop; B4 "evaluates lifecycle states" vs §7.1 "must not grow a second, parallel state-mapping evaluator"; B3 inheriting §7.2 state-name matching with no triage exclusion (§7.1); §8 "All real UI is one React app in this repo" unowned; A4 "deduplication based on delivery IDs" vs A3's two-table scope.
