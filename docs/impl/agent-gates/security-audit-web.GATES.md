# Gates: security-audit-web

- [x] G1: Report docs/impl/security-audit-web.md exists with a SUMMARY line, and every finding has File, Attacker, Exploit, Evidence and Fix lines
  CHECK: node -e "const t=require('fs').readFileSync('../security-audit-web.md','utf8');if(!/^SUMMARY: \d+ Critical, \d+ High, \d+ Medium, \d+ Low$/m.test(t))process.exit(2);const f=t.split(/^### S\d+ /m).slice(1);if(!f.length)process.exit(3);for(const b of f){const body=b.split(/^## /m)[0];for(const k of ['File:','Attacker:','Exploit:','Evidence:','Fix:'])if(!body.includes('\n'+k))process.exit(4)}console.log('REPORT_OK '+f.length)"
  EXPECT: REPORT_OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=75346456c75d6da984067bb1e987aad52d9cd3d12b2c37dbd6e4aca533e9ed02; exit=0; EXPECT=matched; output-sha256=2ed731c817a5201e50041414569c7ade0989869c4122fe2d99bc5273df3f9939; output-bytes=12; shell=/bin/sh; cwd=/home/claudeuser/orca/workspaces/git_plane-intergration/seal/docs/impl/agent-gates; path=ae06f499d48e/29 entries
