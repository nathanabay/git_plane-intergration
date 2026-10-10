# Fix round 2 for leaf-1.1.2 — flaky test

The phase 1 integration gate (all suites together) failed on `tests/auth/identity.test.ts`
"encryptSecret tamper positions". The driver measured it at 1 failure in 30 runs of
`node scripts/run-tests.mjs 12 tests/auth`.

Cause: the test "tampers" by replacing the first base64url character of the IV, tag and
ciphertext with `"A"`. When that character already is `"A"` (1 in 64 per part), nothing changes,
decryption succeeds, and `assert.throws` fails. A test that only usually tests something is a
defect.

Fix: tamper by decoding each part, flipping one bit of one byte (e.g. `buf[0] ^= 0x01`), and
re-encoding — deterministic, always a real change. Check the rest of `tests/auth/` for the same
pattern. Then prove it is stable: run `node scripts/run-tests.mjs 12 tests/auth` at least 50
times in a loop with zero failures, and record that loop as a runnable gate in your ledger
(e.g. a small loop in `sh -c`, EXPECT a token printed only when all 50 passed). Re-run your
ledger with `gate-check --approve` until ALL MET. Same OWNS and rules as before. Do not commit.
