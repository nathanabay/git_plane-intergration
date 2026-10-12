# Round 5 full gate-run report

OWNS: docs/impl/gate-run-r5.md, docs/impl/agent-gates/gate-run-r5.GATES.md

Scope: Execute the prescribed checks on ab32b13 once each and report every outcome and diagnosed failure without product changes.

- [x] G1: The report exists and covers all four prescribed stages, with every individual result and failure diagnosis.
  CHECK: node --input-type=module -e 'import {readFileSync} from "node:fs"; import {strictEqual,ok} from "node:assert/strict"; const s=readFileSync("docs/impl/gate-run-r5.md","utf8"); const gates=["verify-a1-deploy","verify-rules-contract","verify-identity-contract","verify-a3-schema","verify-a2-ingress","verify-a4-writepath","verify-b3-config-api","verify-a5-a7","verify-b4-b8","verify-wiring","verify-fork-patch all","Whole suite","Typecheck","Stub scan"]; for(const g of gates) strictEqual(s.split("\n").filter(l=>l.startsWith("- "+g+": PASS")||l.startsWith("- "+g+": FAIL")).length,1,g); ok(s.includes("ab32b13")); ok(s.includes("## Failures")); console.log("round 5 gate report coverage passed (14 results, four stages)");'
  EXPECT: round 5 gate report coverage passed (14 results, four stages)
  EVIDENCE: automatic-evidence=v1; definition-sha256=6fe10efcd772ddf5a0e4b8602711e733966e150a0f8f20700944e3e439fbb00e; exit=0; EXPECT=matched; output-sha256=7e4a9de0971b51d4c583224b3fba6f7acc482e9e4daf1f10c2f9fde11b7decda; output-bytes=62; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal; path=3d6c2d000e40/34 entries
