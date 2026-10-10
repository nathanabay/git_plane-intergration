# Plane v1.4.2 webhook probe (local test instance, 2026-10-10)

Instance: `~/plane-test` (makeplane/*:v1.4.2, rootless Docker, 127.0.0.1:8090). Webhook delivered to
a sink container on the compose network. Write made with a personal API token (`X-API-Key`).

Request: `PATCH /api/v1/workspaces/gitsync-test/projects/<pid>/issues/<id>/`
body `{"labels": ["95a4…", "1f10…"], "name": "Webhook probe renamed"}`

Deliveries received (one per changed field, spec §1.3 confirmed):

| X-Plane-Event | action | activity.field | old_value | new_value | actor |
|---|---|---|---|---|---|
| issue | updated | `labels` | `["95a43702-…"]` | `["95a43702-…","1f10db54-…"]` | admin@test.local |
| issue | updated | `name` | `"Webhook probe"` | `"Webhook probe renamed"` | admin@test.local |

Findings:
1. `field` is the request-body key and `new_value` is exactly the value sent — A4's field-granular
   op hash matches echoes as designed (scalar-array normalisation covers label order).
2. **Label activity carries label UUIDs, not names.** B6 assumed names; Plane→GitHub label sync
   must resolve ids to names through `GET …/projects/{pid}/labels/` before writing to GitHub.
3. `POST …/labels/` with an existing name → `409` (spec §3 confirmed).
4. `activity.actor.email` is present (spec §1.3, §9 confirmed).
5. Plane's webhook URL validation rejects hostnames without a dot (`http://sink:8000` → 400
   "Enter a valid URL"). A docker-network target needs a dotted alias, and
   `WEBHOOK_ALLOWED_HOSTS` must name it. Not relevant to production (public HTTPS URL, spec §3).

## Live smoke test run (tests/smoke/live-smoke.test.ts) against the same instance

Through A4's real `PlaneWritePath` with a personal API token, all of these behaved as the spec
says: create (and the `created` op recorded), update of state + name in one PATCH, comment, link,
duplicate link URL → `{ ok: true, duplicate: true }` (§3), `update_link` in place, label upsert via
409 (§3), and the triage-group write rejected before sending (§7.1).

The test's final assertion failed, exposing a real defect:

| `GET /api/v1/workspaces/gitsync-test/issues/<KEY>/` | status | body |
|---|---|---|
| `QLL-1` (exists) | 200 | the issue |
| `QLL-999999` (project exists, sequence does not) | 404 | `{"error": "The requested resource does not exist."}` |
| `ZZZZ-1` (no such project, or not a member) | **403** | `{"detail": "You do not have permission to perform this action."}` |

`src/parse/references.ts` `resolveReferences` treats only 404 as unknown (line ~122), so a 403
propagates: any PR or commit mentioning a key that is not a Plane project the service account can
see (e.g. `Fixes JIRA-12`, or a project it is not a member of) makes the reducer throw, the
delivery fail and BullMQ retry it. Required: treat 403 from the identifier endpoint as
unknown/inaccessible, audit it, and keep the smoke test's expectation in line (403 for an
unknown project).
