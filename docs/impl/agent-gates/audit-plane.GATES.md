# Gates: Plane documentation audit

OWNS: docs/impl/audit-plane.md, docs/impl/agent-gates/audit-plane.GATES.md

Scope: Report-only review of every Plane integration surface listed in the audit brief, verified against current Context7 documentation (and Plane v1.4.2 source where the docs describe Cloud/v2); no staging, commits, pushes, or source edits.

- [x] G1: The report exists and every finding has Doc: and Code: lines.
  CHECK: node -e "const t=require('fs').readFileSync('docs/impl/audit-plane.md','utf8');const f=t.split(/\n### A\d+ /).slice(1);const ok=f.length>0&&f.every(s=>/\nDoc: \S/.test(s)&&/\nCode: \S/.test(s));console.log(ok?'AUDIT_PLANE_OK '+f.length:'AUDIT_PLANE_BAD');process.exit(ok?0:1)"
  EXPECT: AUDIT_PLANE_OK \d+
  EVIDENCE: 2026-10-12 node oracle printed AUDIT_PLANE_OK 10 (10 findings, each with Doc: and Code:).
