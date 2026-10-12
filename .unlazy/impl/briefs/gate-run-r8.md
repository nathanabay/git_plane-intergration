# Full gate run after fix round 8 (one agent)

The code is committed on branch `seal` (HEAD `651ee39`). Your job is to **run every gate once on
the combined tree and report**. You do **not** fix product code. A failure goes back to its owner,
through the driver.

Read `.unlazy/impl/briefs/COMMON.md` (git rules: never stage, commit or push). This host is the live
Plane server: run the heavy steps **one at a time**, only through `sh scripts/heavy.sh`, and never in
parallel with another heavy step. An automatic guard kills any test run above 2.5 GB (5 GB for
`run-tests.mjs`).

## Gates, in this order. Run each one even if an earlier one fails.

1. **Oracles**, one by one so each gets its own result:
   `for o in verify-a1-deploy verify-rules-contract verify-identity-contract verify-a3-schema verify-a2-ingress verify-a4-writepath verify-b3-config-api verify-a5-a7 verify-b4-b8 verify-wiring; do sh scripts/heavy.sh node scripts/$o.mjs > "$HOME/.cache/gitsync-gates/$o.log" 2>&1; echo "$o exit=$?"; done; sh scripts/heavy.sh node scripts/verify-fork-patch.mjs all`
   (first `mkdir -p "$HOME/.cache/gitsync-gates"`; read a log only when its oracle fails)
2. **Whole suite:** `sh scripts/heavy.sh node scripts/run-tests.mjs 450 tests`
3. **Typecheck:** `node scripts/typecheck.mjs "src/**/*.ts" "src/**/*.tsx" "tests/**/*.ts"`
4. **Stub scan:** `node scripts/verify-no-stubs.mjs src tests`

## For each failure

Find the root cause, not just the symptom: is it the product code, a stale test or fixture, or a
stale oracle (oracles in `scripts/` are driver-owned)? Name the file:line and the owning round-4
agent from `.unlazy/impl/briefs/fix-r4.md` (oracles: "driver"). Re-running a failed step once is
fine. Flaky results must be reported as flaky, with both outcomes.

## Output

Write `docs/impl/gate-run-r8.md`:
- one line per gate: `- <gate>: PASS` or `- <gate>: FAIL — <one-line cause>`,
- then a `## Failures` section: per failure, the command, the key error lines, the root cause,
  file:line, the suggested fix and the owner.

Unlazy, lightweight: your ledger `docs/impl/agent-gates/gate-run-r8.GATES.md` (OWNS: your two files)
holds one gate: the report exists and covers all four gates. Reply in one line:
`GATES DONE: <n> pass, <m> fail`.
