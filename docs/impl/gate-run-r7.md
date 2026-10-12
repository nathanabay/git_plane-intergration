# Full gate run after round 7

Tested committed HEAD `8c59007af9ff3d416c0240a8ee19b7cc09c02cbf` on 2026-10-12.
Every prescribed gate ran once, in the brief's order. Heavy steps ran sequentially through
`sh scripts/heavy.sh`; typecheck and stub scan used their prescribed direct commands.

**14 pass, 0 fail across 14 gates.** No diagnostic reruns were needed.

- verify-a1-deploy: PASS
- verify-rules-contract: PASS
- verify-identity-contract: PASS
- verify-a3-schema: PASS
- verify-a2-ingress: PASS
- verify-a4-writepath: PASS
- verify-b3-config-api: PASS
- verify-a5-a7: PASS
- verify-b4-b8: PASS
- verify-wiring: PASS
- verify-fork-patch all: PASS
- whole suite: PASS
- typecheck: PASS
- stub scan: PASS

## Failures

None. All 14 gates exited 0 on their first run. No flaky outcome was observed.

## Commands and evidence

The ten logged oracles ran individually and sequentially:

```sh
mkdir -p "$HOME/.cache/gitsync-gates"
for o in verify-a1-deploy verify-rules-contract verify-identity-contract verify-a3-schema verify-a2-ingress verify-a4-writepath verify-b3-config-api verify-a5-a7 verify-b4-b8 verify-wiring; do sh scripts/heavy.sh node scripts/$o.mjs > "$HOME/.cache/gitsync-gates/$o.log" 2>&1; echo "$o exit=$?"; done
```

Every oracle printed `exit=0`. Their logs were not read, following the brief's rule to read
logs only for failed oracles. Wiring passed on its first attempt.

The remaining gates ran in order:

```text
sh scripts/heavy.sh node scripts/verify-fork-patch.mjs all
fork patch verification passed (all)

sh scripts/heavy.sh node scripts/run-tests.mjs 450 tests
tests passed (785 tests in 77 files)

node scripts/typecheck.mjs "src/**/*.ts" "src/**/*.tsx" "tests/**/*.ts"
typecheck passed (142 project files)

node scripts/verify-no-stubs.mjs src tests
stub scan passed (150 files)
```

Final HEAD remained `8c59007af9ff3d416c0240a8ee19b7cc09c02cbf`. Final inspection showed no
diff from HEAD under `src/`, `tests/` or `scripts/`. Only this report and its lightweight
coverage ledger were edited. No product/test/oracle fixes, staging, commits or pushes.
