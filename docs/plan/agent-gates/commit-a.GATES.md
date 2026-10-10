- [x] G1: part A still passes structural and assigned-section verification
  CHECK: node scripts/verify-plan-part.mjs docs/plan/part-a-service-core.md A 3,4,5,6,7.5,10
  EXPECT: plan part verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=8c9a376067784e495b839c791a5e0f8538d06c3d2c726c48988a0f96e0e61b2c; exit=0; EXPECT=matched; output-sha256=be70b529805f4aa58d8b2c34d04fe518890a696b6cb5d57f45b755f30401ef4c; output-bytes=54; shell=/bin/sh; cwd=/Users/nathanamare/Downloads/git_plane intergration; path=8ab7b88bda7f/63 entries

- [x] G2: every task in part A has its own distinct commit
  CHECK: node scripts/verify-agent-commits.mjs docs/plan/part-a-service-core.md A
  EXPECT: agent commit verification passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=60430d56eb1009fec844dffe8aa34ac004e03bed6e1ebb25905117e063f650ab; exit=0; EXPECT=matched; output-sha256=266714fb50d129eb66155a5b2e83e929c6f5d718f27b9b6f18a009028603c915; output-bytes=63; shell=/bin/sh; cwd=/Users/nathanamare/Downloads/git_plane intergration; path=8ab7b88bda7f/63 entries
