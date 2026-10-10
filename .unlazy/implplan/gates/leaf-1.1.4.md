# Gates: post-review commit pass — part A

OWNS: docs/plan/part-a-service-core.md, docs/plan/agent-gates/commit-a.GATES.md

Scope: resolve the review's findings for part A and record one git commit per planned task

- [x] G0: this ledger states outcomes that can fail
  CHECK: node /Users/nathanamare/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/implplan/gates/leaf-1.1.4.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=0c19e7382b2708090decd02e1d0892d67cf8c632010036da329ccafcdc2931d3; exit=0; EXPECT=matched; output-sha256=1f85990505c2940d1a261a7e05bb6a5f216a0bacf84d0aa553e186215e3520da; output-bytes=178; shell=/bin/sh; cwd=/Users/nathanamare/Downloads/git_plane intergration; path=ead53c83f5b8/61 entries

- [x] G1: part A still passes the structural and spec-citation verifier after review edits
  CHECK: node scripts/verify-plan-part.mjs docs/plan/part-a-service-core.md A 3,4,5,6,7.5,10
  EXPECT: plan part verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=8c9a376067784e495b839c791a5e0f8538d06c3d2c726c48988a0f96e0e61b2c; exit=0; EXPECT=matched; output-sha256=be70b529805f4aa58d8b2c34d04fe518890a696b6cb5d57f45b755f30401ef4c; output-bytes=54; shell=/bin/sh; cwd=/Users/nathanamare/Downloads/git_plane intergration; path=ead53c83f5b8/61 entries

- [x] G2: every planned task in part A has its own distinct git commit
  CHECK: node scripts/verify-agent-commits.mjs docs/plan/part-a-service-core.md A
  EXPECT: agent commit verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=60430d56eb1009fec844dffe8aa34ac004e03bed6e1ebb25905117e063f650ab; exit=0; EXPECT=matched; output-sha256=266714fb50d129eb66155a5b2e83e929c6f5d718f27b9b6f18a009028603c915; output-bytes=63; shell=/bin/sh; cwd=/Users/nathanamare/Downloads/git_plane intergration; path=ead53c83f5b8/61 entries

- [x] G3: the agent ran unlazy on this pass and left a ledger whose every gate is met with checker-written evidence
  CHECK: node scripts/verify-agent-unlazy.mjs docs/plan/agent-gates/commit-a.GATES.md
  EXPECT: agent unlazy verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=1662fb95caf06fe1654f6b122f17780a1da33c2d4a917de9d1c2e00df31a142d; exit=0; EXPECT=matched; output-sha256=c89c32aa56c046b3834c1838ec81dbd550a7c7d37a1d501636aef1c51267e672; output-bytes=64; shell=/bin/sh; cwd=/Users/nathanamare/Downloads/git_plane intergration; path=ead53c83f5b8/61 entries

- [x] G4: every review finding against part A is either fixed in the plan or answered with a recorded rationale
  EVIDENCE: driver verified each blocker against the artifact after wave ready-3. A2 now names X-Plane-Signature (was 0 occurrences, now present), closing the unauthenticated public Plane ingress. A4's Acceptance was rewritten from the inverted "Outbound queue workers ... drop messages" to "Inbound queue workers drop incoming webhook echoes that match recently applied operations", matching spec section 5. A3 now covers delivery ids, commit SHAs, orphan status and the audit log (5 matches for delivery/audit/commit-sha/orphan where the original scoped only sync_links and applied_ops). The triage prohibition is now stated on the single Plane write path. 8 tasks, ids contiguous, 11 spec refs, all resolving.
