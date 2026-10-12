# Independent check of commit 43ab043's F15 test change

VERDICT: ACCEPT

This verdict accepts the deliberate assertion change, not a claim that every prev F15 residual is fixed. Reviewed at HEAD `d6f8428d77ab681b4bf13a1a9a54688f715dc1a9`. `git diff 43ab043 HEAD -- src/app/credentials.ts tests/app/fixes-r2.test.ts` is empty, so the cited current lines match the reviewed commit. Only this report was written; no implementation or test was edited.

## 1. Is the new assertion required?

Yes, for the state this test establishes. The design spec requires instance-admin GitHub App credentials and connection health (`docs/superpowers/specs/2026-10-10-plane-github-sync-design.md:448-450`); it does not itself spell out the restart/environment-fallback policy. That explicit requirement comes from review-3 F15: a restart during a database outage can revive a secret rotated out because it leaked (`docs/impl/review-3.md:200-207`). Its prescribed fix persists that stored credentials have existed and refuses environment fallback after the first save (`:207`). Review-4 did **not** close this finding: its B1 verdict remains FINDINGS (`docs/impl/review-4.md:32`), and prev F15 remains STILL OPEN because the restart guard was only in memory (`:57`). SB's assertion correction implements that requested policy; saying review-4 had already closed the defect would be inaccurate.

The test first reads stored credentials (`tests/app/fixes-r2.test.ts:84-87`), which writes a marker beside its temporary key (`src/app/credentials.ts:29,47-51,69`). It then creates a new credential source with no process cache and an unavailable database, retaining the same key directory (`tests/app/fixes-r2.test.ts:89-94`). This models a restart with durable evidence of prior database credentials. Refusal is required; accepting `leaked-env-secret`, as the parent commit asserted, is precisely the reviewed defect. The outage branch now rejects when that marker exists (`src/app/credentials.ts:58-63`).

The requested `git show 43ab043 -- tests/app/fixes-r2.test.ts src/app/credentials.ts` confirms the old secret-equality assertion was replaced with a rejection assertion and a separate bootstrap control was added. Other test assertions were retained.

## 2. Was any proof weakened, especially cold-start database outage?

No valid requirement proof was removed. The old assertion demonstrated the unwanted restart fallback after a database row had already been read. The replacement now proves refusal in that state (`tests/app/fixes-r2.test.ts:92-94`). It catches any thrown error, which is adequate to prove that this call does not return the environment secret; it does not prove a particular error message or cause.

The positive bootstrap case remains explicitly tested: a fresh key directory with a readable key, no local marker, a newly constructed source, and the same database fake that throws on every query must still return the environment secret (`tests/app/fixes-r2.test.ts:89,95-98`). There is no cached value to rescue that call. Consequently, an implementation that always rejects cold-start database outages would fail this control. In this isolated fixture, the new directory represents an instance that has never adopted database credentials; in production, a missing marker alone cannot establish that history.

The source/decryption, cleared GHE URL, and unreadable-row rejection assertions remain (`tests/app/fixes-r2.test.ts:83-87,99-103`). The separate webhook-route 503 proof also remains (`:107-113`). The comment at `:88` says the last stored secret keeps verifying during an outage, but neither the old nor new test actually exercises an outage on the already-loaded source: both construct another source. Warm-process retention is implemented at `src/app/credentials.ts:60`, but is not proved by this test. That is an existing coverage gap, not proof removed by this edit.

## 3. Is there a real code bug concealed by the correction?

There is a real remaining restart/outage bug outside the writable-marker fixture. The correction does not remove an assertion that would detect it, but passing this test must not be presented as proof that the code fully fixes prev F15.

Static counterexample: read database credentials successfully while the marker location is unwritable, then restart the source while the database is down. `remember()` sets only process state synchronously, starts a database marker write, and silently swallows the filesystem write failure (`src/app/credentials.ts:47-51`). Even if the database flag was successfully persisted, the restarted source has no `lastRow`, no cache, and `sawRow = false` (`:30,44-45`). Its database-error branch checks only process state and the local file (`:58-63`); it never reads the durable database flag there. With no local marker it returns the environment secret again. The database flag protects the missing-row case only when the database query succeeds (`:65-67`; `src/db/ledgers.ts:300-305`). The comment that a read-only mount is protected by the database marker (`src/app/credentials.ts:51`) is therefore insufficient during the outage explicitly under review.

This is relevant to the documented deployment, not merely an invented storage configuration. The key path is `/run/secrets/github-app.pem` (`deploy/git-sync.env.example:26-27`); the service runs as `node` (`Dockerfile:17`), and the documented volume mounts only the key file read-only, with no writable persistent marker directory (`deploy/APPLY.md:101-102`). A marker beside that key is not provisioned as durable writable storage. The exact runtime directory permissions were not probed; regardless of permissions, the documented volume does not preserve the sibling marker across container replacement. The implementation also writes the local marker only on a credential-source read (`src/app/credentials.ts:69`), whereas the admin save records only the database flag (`src/ui/api.ts:475-481`), leaving a save-before-first-read restart window.

The updated test succeeds because its temporary directory is writable and retained across source recreation (`tests/app/fixes-r2.test.ts:78-79,85,92`). Both the original and updated fixtures miss marker failure/loss and the save-before-read window. Keep the corrected assertion; a complete F15 fix needs durable local state available during database outages, recorded at adoption, with corresponding coverage. Reinstating the old assertion would require accepting a leaked bootstrap secret and would contradict the review.

## Requested validation

Ran only the requested test file, with the exact caps:

```sh
NODE_OPTIONS=--max-old-space-size=1024 node --test --test-concurrency=1 --test-timeout=60000 tests/app/fixes-r2.test.ts
```

Exit code 0: 5 tests passed, 0 failed, 0 cancelled, 0 skipped; duration 16,561.934221 ms. No additional test file or scratch reproduction was run. The remaining bug above is established by the cited control flow, not a claimed runtime reproduction.
