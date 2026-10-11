# Round 1 fixes — CB

## F3

`src/sync/mirror.ts:81` and `src/sync/mirror.ts:90` require active issue links with
`created_by = 'label_sync'` in both lookup directions. Backfill continues to establish
reference links with `created_by = 'magic_word'` or `'branch'`; those links cannot become
mirror partners merely because their GitHub kind is `issue`.

`tests/mirror/review-r1.test.ts:55` performs a real backfill of issue #5 mentioning WEB-12,
checks that it is a relation reference, and delivers GitHub edit/close/comment events and
Plane state/comment events. Neither writer receives a write. Its positive control replaces
the reference with a label-sync link and verifies that title and state writes occur.
`tests/mirror/mirror.test.ts` also covers reference links in both directions.

`src/operations/tooling.ts:153` also preserves existing label-sync links when backfill runs
again. Its conflict guard is part of the SQL upsert, so backfill cannot overwrite the
opt-in origin or tier, including when a label-sync insert wins a concurrent conflict.
`tests/operations/tooling.test.ts:189` backfills an already opted-in issue twice and checks
that it remains an active label-sync partner with its original tier. This regression failed
before the guard: backfill changed its origin to `magic_word` and its tier to `closing`.
It passes after the guard with the inherited 1024 MiB heap limit and 60-second test timeout.

## F4

`src/sync/mirror.ts:240` extracts IDs from UUID arrays or expanded objects.
`src/sync/mirror.ts:256` resolves label IDs from expanded `data.labels`, then through the
configured project-label lookup (`GET /workspaces/{slug}/projects/{pid}/labels/`), including
removed labels absent from the current snapshot. The label reducer at
`src/sync/mirror.ts:327` handles both `labels` and `label_ids`, diffs the old/new ID sets,
adds/removes the resulting GitHub label names, and skips the `github` opt-in label.
The assignee reducer at `src/sync/mirror.ts:346` handles both `assignees` and `assignee_ids`
and resolves IDs through the workspace-scoped user map. Activity `new_value` takes
precedence over a later expanded assignee snapshot.

The fixtures in `tests/mirror/review-r1.test.ts:26` preserve the Plane v1.4.2 activity and
expanded-data shapes, with sanitized UUIDs. Tests at lines 84–135 exercise both API/UI
field names, adding and removing labels, clearing labels, skipping the gate label,
ignoring UUID order changes, and resolving assignees only within the mapping's workspace.
The main mirror tests also prove expanded labels avoid an unnecessary lookup and unresolved
IDs are reported without guessing label names.

## F5

`src/sync/mirror.ts:352` preserves an explicit empty activity array and always sends the
mapped assignee reconciliation set, including `[]`, to the GitHub writer. Clearing the
last mapped Plane assignee, or leaving only unmapped users, therefore triggers removal
of mapped GitHub assignees. SA owns the writer's diff in `src/app/issues.ts`, which preserves
unmapped GitHub assignees; CB does not edit that file.

`tests/mirror/review-r1.test.ts:119` covers clearing the final mapped assignee under both
field names, even when `data.assignees` still contains the previous assignee. Tests at
line 127 cover leaving only an unmapped member. Both cases produce the empty reconciliation
set rather than an ignored event.

## Shared dry-run translation

`src/operations/tooling.ts:21` delegates delivery translation to CA's
`ruleEventsFor(source, event, payload)`, exported from `src/app/rule-events.ts`.
Dry-run evaluates every translated trigger with the rule engine's no-write mode and a
refusing executor. A default-branch push evaluates `push` followed by
`commit.pushed_to_default` and reports both results; single-trigger responses retain their
existing shape. `tests/operations/tooling.test.ts:46` and `:60` compare dry-run translation
with the live mapper for a push and a completed check suite, including sender attribution,
conditions, rendered actions, and trigger order.

## Verification and resource discipline

`NODE_OPTIONS=--max-old-space-size=1024 node --test --test-timeout=60000
tests/mirror/review-r1.test.ts` passed all 13 tests in 46.6 seconds. `/usr/bin/time` measured
peak RSS of 1,069,828 KiB (about 1.02 GiB), including the child test process.
`tests/mirror/mirror.test.ts` passed all 26 tests. Separate isolated snapshots
restored each reported bug: unrestricted mirror lookups (F3), ignored label UUID arrays
(F4), and ignored empty mapped assignees (F5). Each corresponding regression failed its
assertion; the snapshots were removed and production code was never replaced.

`NODE_OPTIONS=--max-old-space-size=1024 node --test --test-timeout=60000
tests/operations/tooling.test.ts` passed the original 15 tests in 43.6 seconds, with peak RSS
of 1,084,364 KiB. Both bounded runs had zero failed, skipped, or cancelled tests. The additional
backfill opt-in preservation test also passed separately under the same bounds; the final
whole-suite gate includes it alongside the original operations cases.

The owned mirror and operations tests create their own migrated PGlite databases and close
them after each test. They avoid the shared fake helper's array that retains databases until
file completion, reducing concurrent memory use on the live Plane host. No unbounded loop
was found in the mirror or its fake: label lookup is asserted to occur once per changed-label
event, and `src/operations/tooling.ts:119` already caps backfill at 50 pages per endpoint.

Final driver oracles, full-suite, typecheck, and stub-scan evidence is recorded by the checker
in `docs/impl/agent-gates/fix-r1-cb.GATES.md` (G0–G5; G6 belongs to the driver).
Heavy verification uses `scripts/heavy.sh`. No spec disagreement; no staging or commits.
