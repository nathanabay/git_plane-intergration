# Round 8 gate-run report

OWNS: docs/impl/gate-run-r8.md, docs/impl/agent-gates/gate-run-r8.GATES.md

Scope: Run every prescribed gate once against committed HEAD 651ee39, serialize heavy steps,
and report results and failure ownership without changing product code.

- [x] G1: Report exists and covers oracles, whole suite, typecheck and stub scan, with causes and owners for any failures
  EVIDENCE: Oracle results begin at docs/impl/gate-run-r8.md:10; suite/typecheck/stub results at :21. Failures begin at :25, including both flaky outcomes, a source-based likely fixture race, the unavailable primary assertion details, suggested fixes and CB/driver ownership. Commands and measured checks begin at :82. Inline coverage validation exited 0: all four groups, exactly 14 ordered results, 13 PASS and 1 FAIL; typecheck 143 project files, stub scan 151 files; focused retry 1 pass, 0 fail. Every prescribed gate ran once, followed by one failing-case retry. Final HEAD 651ee394aee1810835a9c0ea8322620a3172c1a6; no product/test/script diff from HEAD. Manual coverage gate only; no gate-check certificate claimed.
