# Test failures after the parity work (per-file run, 2026-10-13)

95 test files: 1,037 tests pass, 38 fail; tests/ui/review-r5-ce.test.ts HANGS (killed at 300 s), which is what stopped the whole-suite run.

## tests/db/parity-g4.test.ts
  - parity-g4: 010 upgrades existing rows; ghe_base_url becomes an edition
## tests/github/parity2-g1.test.ts
  - N7: higher grants satisfy reads while Administration is required only for configured autolinks
## tests/github/smart-commits.test.ts
  - F8: network errors, 429 and 5xx are retried; other 4xx and the triage ban are final and audited once
## tests/mirror/audit-g3.test.ts
  - G15: marking an approved, green draft ready for review fires ready_for_merge
## tests/mirror/mirror.test.ts
  - plane→github: the `github` label creates a labelled GitHub issue, links it and cross-links
  - plane→github: a source_of_truth:plane title and description are applied
## tests/mirror/review-r5-cc.test.ts
  - F2: successful but unlinked workflow cannot advance; confirmed orphan can get a replacement
  - F2: confirmed orphan of a saved partner permits replacement even when its old tail failed
## tests/sync/audit-g4.test.ts
  - A5: the default burst is small, and no sliding minute ever carries more than the per-minute limit
## tests/sync/parity-g2.test.ts
  - N2: failed check-suite automation registers a Plane report on its linked item and honors opt-out
  - N2 production wiring: a Plane notice uses its report lane while the automation target is delayed
  - N2 production wiring: authenticated App metadata owns reports even when the stored App slug is stale
## tests/ui/audit-g5.test.ts
  - G1/G11: composed user-link and repository lookups use public/approved installation clients
  - G11: lookup routes authenticate, validate names, and retain GitHub retry deadlines
  - G12: autolinks are unavailable and unchecked in the rendered mapping form
## tests/ui/auth.test.ts
  - csrf: a body that is not application/json is 415; a charset parameter is accepted
## tests/ui/instance.test.ts
  - github app: unconfigured GET says so; first save needs both secrets
  - github app: secrets are stored encrypted (v1 blobs that decrypt) and never returned
  - settings: defaults, partial updates merge, out-of-range values are 422
## tests/ui/operations.test.ts
  - dry-run: a mapping's saved rules are used, and explicit YAML overrides them
  - dry-run: validation, auth and CSRF
  - backfill: lists the mapped repository, links references and reports counts
## tests/ui/parity-g5.test.ts
  - N6: untouched UI settings use the current instance default and retain stored autolinks
  - N6: rule Restore creates a new authored version and is workspace-scoped and CSRF protected
## tests/ui/parity2-g4.test.ts
## tests/ui/review-r5-ce.test.ts
  - F7: unlink waits for the final suppression check and insert, then removes the account and tokens
  - F7: auto-link cannot insert while unlink has deleted the map but not written the tombstone
  - F8: production mount supports non-root writes with a read-only secret and survives process recreation
  - F3 relay: mapping POST and every PATCH verify the effective repository and persist installation authority
## tests/ui/workspace.test.ts
  - mappings: create stores the workspace and applies defaults (autolinks off, smart commits from instance default
  - mappings: list returns camelCase DTOs with numeric ids
  - mappings: duplicates are 409
  - mappings: PATCH updates only the given fields; an empty patch is 422
  - rules: invalid YAML is 422 carrying the engine's reason and stores nothing
  - rules: every accepted save is a new version and GET returns the latest
  - rules: concurrent saves all succeed with distinct versions
  - policies: §7.3 defaults, partial update, unknown field or policy is 422
  - user links: need both login and id; a duplicate GitHub id is 409; a member cannot link
  - audit: newest first, paged by before, scoped to this workspace's entries
  - mappings: DELETE removes the mapping and cascades its rules and policies
  - F2: mappings are verified against Plane and GitHub; a refusal is 422 and stores nothing, an outage is 502
## tests/writers/service.test.ts
  - F2/F6: the running service registers mirror and actor intents without waiting, preserving FIFO

## Per-file summary (rc, seconds, pass, fail)
```
1 25s pass=8 fail=1 tests/db/parity-g4.test.ts
1 37s pass=12 fail=1 tests/github/parity2-g1.test.ts
1 129s pass=43 fail=1 tests/github/smart-commits.test.ts
1 44s pass=17 fail=1 tests/mirror/audit-g3.test.ts
1 85s pass=24 fail=2 tests/mirror/mirror.test.ts
1 34s pass=7 fail=2 tests/mirror/review-r5-cc.test.ts
1 49s pass=22 fail=1 tests/sync/audit-g4.test.ts
1 84s pass=53 fail=3 tests/sync/parity-g2.test.ts
1 25s pass=11 fail=3 tests/ui/audit-g5.test.ts
1 6s pass=13 fail=1 tests/ui/auth.test.ts
1 5s pass=9 fail=3 tests/ui/instance.test.ts
1 8s pass=10 fail=3 tests/ui/operations.test.ts
1 16s pass=7 fail=2 tests/ui/parity-g5.test.ts
1 0s pass=0 fail=1 tests/ui/parity2-g4.test.ts
124 300s pass=? fail=? tests/ui/review-r5-ce.test.ts
1 28s pass=12 fail=12 tests/ui/workspace.test.ts
1 8s pass=0 fail=1 tests/writers/service.test.ts
```
