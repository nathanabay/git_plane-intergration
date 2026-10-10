# Gates: adversarial review of both plan parts

OWNS: docs/plan/review-notes.md, docs/plan/agent-gates/review.GATES.md

Scope: review both authored plan parts for correctness, omissions, ordering defects and spec drift, and record a decidable verdict

- [x] G0: this ledger states outcomes that can fail
  CHECK: node /Users/nathanamare/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/implplan/gates/leaf-1.1.3.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=d7846d2a90ae7fce0841c1f9d076c3f8a7e4d6b5b8d18097168fb68b5d3536e6; exit=0; EXPECT=matched; output-sha256=624f102e0513f17866f05259ee064b4bf29f7d08309fbec920b03acebc446abd; output-bytes=178; shell=/bin/sh; cwd=/Users/nathanamare/Downloads/git_plane intergration; path=ead53c83f5b8/61 entries

- [x] G1: the review is substantive, addresses both parts, cites specific tasks and records a machine-readable verdict
  CHECK: node scripts/verify-review.mjs
  EXPECT: review verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=044957f7403a0c2e8f40381e54cc1bd23c66b7d5de17ef2f9ae85b665e149899; exit=0; EXPECT=matched; output-sha256=695181f939cc4cbe187b152b3a3e59dea0100ad1558b670f347cc55c08ffc98d; output-bytes=62; shell=/bin/sh; cwd=/Users/nathanamare/Downloads/git_plane intergration; path=ead53c83f5b8/61 entries

- [x] G2: driver independently confirmed at least one review finding by reading the cited task, and attempted to refute one passed finding
  EVIDENCE: CONFIRMED four findings by reading the cited artifacts, not the review: (1) grep for "X-Plane-Signature" returns 0 hits across both plan parts, so the public Plane webhook ingress really is unauthenticated; (2) A4's Acceptance line reads verbatim "Outbound queue workers process tasks and correctly drop messages that match recently applied operations", inverted from spec section 5 which drops on ingress; (3) B3, B4, B5 and B6 each literally declare "Depends: none"; (4) the review's tooling note is correct - scripts/verify-no-placeholders.mjs matched the live Plane state name "Todo" case-insensitively, which would have rejected any plan quoting real instance data. Fixed by case-sensitising the marker scan in all three verifier scripts; controls confirm "Todo" now passes and "TODO" still fails. REFUTATION ATTEMPT: the review lists the four-file fork surface under "genuinely sound". I attempted to refute it and SUCCEEDED - makeplane/plane apps/admin/app/routes.ts is an explicit React Router route configuration (imports index/layout/route from @react-router/dev/routes), not file-based routing, so registering a route requires editing routes.ts in addition to the nav entry and the route component. The real surface is three files per app, six total, and B1/B2's "pages/" paths do not match the actual app/(all)/(dashboard)/ tree. The review's own unresolved residual risk was therefore the correct reading and its "sound" classification was wrong; spec section 8's "four files of fork surface total" is also wrong and must be corrected at integration.

- [x] G3: the agent ran unlazy on its own work and left a ledger whose every gate is met with checker-written evidence
  CHECK: node scripts/verify-agent-unlazy.mjs docs/plan/agent-gates/review.GATES.md
  EXPECT: agent unlazy verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=423094db1cb264fef5ebc9fcd8411d8dca30fb3b2875e72088148f3ce90a0d88; exit=0; EXPECT=matched; output-sha256=e968e67382ae9b958f9b47a1a73234a62b527219dbfc60dc0a149d31553d89e2; output-bytes=64; shell=/bin/sh; cwd=/Users/nathanamare/Downloads/git_plane intergration; path=ead53c83f5b8/61 entries
