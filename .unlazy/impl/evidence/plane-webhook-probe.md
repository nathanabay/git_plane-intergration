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
