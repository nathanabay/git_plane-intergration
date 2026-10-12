# Full gate run after round 8

Tested committed HEAD `651ee394aee1810835a9c0ea8322620a3172c1a6` on 2026-10-12.
Every prescribed gate ran once, in the brief's order. Heavy steps ran sequentially through
`sh scripts/heavy.sh`; typecheck and stub scan used their prescribed direct commands.

**Primary run: 13 pass, 1 fail across 14 gates.** The sole failing test passed its one
permitted focused retry, so the suite failure is reported as flaky. No product code was fixed.

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
- whole suite: FAIL — running-service FIFO assertion failed once; focused retry passed (flaky; likely fixture completion race).
- typecheck: PASS
- stub scan: PASS

## Failures

### Whole suite — flaky running-service fixture

Command: `sh scripts/heavy.sh node scripts/run-tests.mjs 450 tests` (exit 1).

Key output:

```text
not ok 760 - F2/F6: the running service registers mirror and actor intents without waiting, preserving FIFO
  error: |-
  expected:
  actual:
FAIL: node --test exit 1, fail=1, cancelled=0
```

The failing case is `tests/writers/service.test.ts:26`. It passed the focused retry below:

```sh
NODE_OPTIONS=--max-old-space-size=1024 sh scripts/heavy.sh node --test --test-concurrency=1 --test-timeout=60000 --test-name-pattern='^F2/F6: the running service registers mirror and actor intents' tests/writers/service.test.ts
```

Retry result: **1 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo**, exit 0. Observed outcomes
are **FAIL then PASS** for this case; it is flaky. The whole suite was not rerun.

Likely root cause: **fixture completion race**, inferred from static control flow. The fake
Plane server records each HTTP write before responding (`tests/writers/service.test.ts:53`).
The test waits only for two recorded HTTP writes at `:114`, checks their order/tokens at
`:115`, then immediately reads durable outbox statuses and expects both to be `applied`
at `:118`. That predicate does not synchronize with durable worker completion. The executor
returns from the API call at `src/operations/outbox.ts:639`, saves its result at `:648`,
updates status at `:676`, and commits the completion transaction at `:682`. A query between
the second HTTP request and that commit can still see a pending actor intent. The earlier
`rule_match` predicate at `tests/writers/service.test.ts:112` records reducer registration,
not remote completion (`src/app/rules.ts:98`). Waiting for BullMQ completion at `:124`
comes after the vulnerable assertion.

Evidence limit: the primary runner filters away multiline assertion differences and stack
lines at `scripts/run-tests.mjs:36`. Consequently its output does not identify whether the
failed structural assertion was the HTTP-array comparison at `:115` or the status comparison
at `:118`. The permitted retry passed, so it supplied no failing diff. The completion race
above is a concrete fixture defect and the likely explanation; the exact primary assertion
and mismatching values remain unconfirmed. No FIFO or actor-attribution product regression
is established by the available failure output. Both this fixture and the outbox executor
are unchanged from `8c59007`, whose full gate run passed.

Suggested fix: poll the two registered intent IDs until both durable statuses are `applied`
before checking their status/actor tuples. Keep the strict HTTP FIFO/token assertion, the
two-intent expectation, the unavailable-destination/nonblocking-delivery checks, and the
queue completion/secret-absence checks. Retain full TAP failure differences and stacks in a
cache log in the driver-owned runner so future primary failures can be classified precisely.

Owner: **CB**, round-4 owner of the outbox/FIFO seam in
`.unlazy/impl/briefs/fix-r4.md:23`; the driver must assign the older
`tests/writers/service.test.ts` fixture, which is outside that round's exact file row.
Failure-output retention in `scripts/run-tests.mjs` belongs to **driver**. No files were fixed.

## Commands and passing evidence

The ten logged oracles ran individually and sequentially:

```sh
mkdir -p "$HOME/.cache/gitsync-gates"
for o in verify-a1-deploy verify-rules-contract verify-identity-contract verify-a3-schema verify-a2-ingress verify-a4-writepath verify-b3-config-api verify-a5-a7 verify-b4-b8 verify-wiring; do sh scripts/heavy.sh node scripts/$o.mjs > "$HOME/.cache/gitsync-gates/$o.log" 2>&1; echo "$o exit=$?"; done
```

Every logged oracle printed `exit=0`; their logs were not read, following the brief's
failed-log-only rule. Fork-patch verification then passed:

```text
sh scripts/heavy.sh node scripts/verify-fork-patch.mjs all
fork patch verification passed (all)
```

After the whole suite exited, the final prescribed checks both exited 0:

```text
node scripts/typecheck.mjs "src/**/*.ts" "src/**/*.tsx" "tests/**/*.ts"
typecheck passed (143 project files)

node scripts/verify-no-stubs.mjs src tests
stub scan passed (151 files)
```

Only after all prescribed gates finished was the failing service case retried, once, through
the heavy wrapper with heap 1024 and concurrency 1. The whole-suite wrapper reported one
failure and zero cancellations but does not print a passing count on failure; no whole-suite
passing count is claimed.

Final HEAD remained `651ee394aee1810835a9c0ea8322620a3172c1a6`. Final inspection showed no
diff from HEAD under `src/`, `tests/` or `scripts/`. Only this report and its lightweight
coverage ledger were edited. No product/test/oracle fixes, staging, commits or pushes.
