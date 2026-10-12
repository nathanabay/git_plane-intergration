# Round 7 fixes — CD

## Review-7 F3 — orphan-comment source authority

`src/app/main.ts:211` resolves the installation before creating the comment; `:214` stamps `freezeMappingAuthority(mapping)` on every new maintenance orphan-comment registration. Registration therefore records the selected mapping's identity even outside inbound delivery scope. The existing strict authorizer in `src/app/mappings.ts` needed no change, and its legacy behavior remains available for older unstamped rows.

Proof: `tests/app/review-r7-cd.test.ts:10` runs the real maintenance callback through the production ordered outbox and authorizer with two authorized project mappings for the same repository/workspace/installation. It checks the frozen snapshot, deletes the admitted source mapping while retaining the alternative, and requires execution and Retry to refuse without sending a comment or replacing the snapshot. A fresh callback admitted under the remaining mapping succeeds, and metadata never reaches the remote API. `:51` explicitly seeds an older unstamped durable row and verifies legacy authorization still executes it.

## Stale installation-lookup fixture

`tests/app/fixes-r3.test.ts:55` now retains the verified installation during full-reducer admission. The old query wrapper cleared hydrated installation IDs after verification, which conflicts with round-6 frozen authority and made the broad rejection assertion pass for the wrong error.

Uncached classification is tested at the exported `planeInstallation` boundary (`:75`): the actual 502 error must propagate unchanged, while the 404 returns installation 0. The suppression writer then rejects a write, exposes no create-plan method, produces no remote/durable writes, and records `github_not_installed`. Both mocked lookups must run. The full reducer still handles a verified mapping without changing its saved authority (`:88`). No authority validation was relaxed, and only this stale test plus its imports/unused helper changed in the older test file.

## Validation

```text
node scripts/typecheck.mjs src/app/main.ts src/app/mappings.ts tests/app/fixes-r3.test.ts tests/app/review-r7-cd.test.ts
typecheck passed (55 project files)

NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/app/review-r7-cd.test.ts tests/app/fixes-r3.test.ts
tests 8; pass 8; fail 0; cancelled 0
```

Only assigned product/test files and this requested report were written. No oracle, heavy.sh, gate-check, whole suite, staging, commit or push was run.
