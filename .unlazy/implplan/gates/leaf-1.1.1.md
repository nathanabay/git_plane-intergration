# Gates: implementation plan — service core and Plane side

OWNS: docs/plan/part-a-service-core.md, docs/plan/agent-gates/part-a.GATES.md

Scope: author the complete implementation plan for the sync service core and every Plane-facing concern (spec §3, §4, §5, §6, §7.5, §10)

- [x] G0: this ledger states outcomes that can fail
  CHECK: node /Users/nathanamare/.claude/skills/unlazy/scripts/gate-lint.mjs .unlazy/implplan/gates/leaf-1.1.1.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=3a2ea213cb018ceb367133dd8450c4878ee9a41fc0f852923d8f7c87285c46ab; exit=0; EXPECT=matched; output-sha256=7cd332d5ffe536233bbcab568d91d0e60dbdb3eb43c00a75f5b3451a45e9181f; output-bytes=178; shell=/bin/sh; cwd=/Users/nathanamare/Downloads/git_plane intergration; path=ead53c83f5b8/61 entries

- [x] G1: part A is a structurally complete plan whose every spec citation resolves
  CHECK: node scripts/verify-plan-part.mjs docs/plan/part-a-service-core.md A 3,4,5,6,7.5,10
  EXPECT: plan part verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=8c9a376067784e495b839c791a5e0f8538d06c3d2c726c48988a0f96e0e61b2c; exit=0; EXPECT=matched; output-sha256=be70b529805f4aa58d8b2c34d04fe518890a696b6cb5d57f45b755f30401ef4c; output-bytes=54; shell=/bin/sh; cwd=/Users/nathanamare/Downloads/git_plane intergration; path=ead53c83f5b8/61 entries

- [x] G2: each task is independently implementable in the stated order by an engineer who has not read the spec
  EVIDENCE: driver review of docs/plan/part-a-service-core.md after fix round ready-1b. Dependency graph is acyclic and correctly ordered (A1->A2->A4; A3->A4; A7 needs A3,A4; A8 needs A4,A5,A6,A7). The two defects that would have produced wrong implementations are closed inline: A3 now states "track a field-granular op_hash ... Whole-object hashing must not be used, as Plane emits webhooks per changed field", and A4 gives the exact tuple "(target side, target id, single field name, normalized new value)". A7 was added for the deletion reconciliation sweep with correct semantics (404 -> orphaned, "never treat this deletion as a state transition"). 8 tasks, ids contiguous, every Files path repo-relative.

- [x] G3: the agent ran unlazy on its own work and left a ledger whose every gate is met with checker-written evidence
  CHECK: node scripts/verify-agent-unlazy.mjs docs/plan/agent-gates/part-a.GATES.md
  EXPECT: agent unlazy verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=55fe7370967b6be25a449d477315d2a5fe864c811c94eb653c99d0e93d279dbb; exit=0; EXPECT=matched; output-sha256=c89c32aa56c046b3834c1838ec81dbd550a7c7d37a1d501636aef1c51267e672; output-bytes=64; shell=/bin/sh; cwd=/Users/nathanamare/Downloads/git_plane intergration; path=ead53c83f5b8/61 entries
