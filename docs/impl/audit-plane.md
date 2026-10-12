# Docs audit: Plane
VERDICT: 0 BLOCKING, 3 MAJOR, 7 MINOR

Scope: `src/sync/plane.ts` (client and every write path), `src/api/handler.ts` (Plane ingress and signature),
`src/sync/router.ts`, `src/app/reducers.ts`, `src/app/issues.ts`, `src/sync/mirror.ts` (Plane reducers),
`src/queue/workers.ts` (Plane echo and duplicate filter), `src/ui/plane-auth.ts`, the rate limiter and
`PLANE_API_RATE_PER_MINUTE`, `src/sync/reconcile.ts`, and the fork patches (`apps/admin`, `apps/web`,
`packages/constants`).

Method: Context7 (`/websites/developers_plane_so`, `/makeplane/developer-docs`) for every claim. Where the docs
describe Plane Cloud or API v2 and not CE v1.4.2, the behavior was confirmed against the tagged source
(`https://raw.githubusercontent.com/makeplane/plane/v1.4.2/apps/api/plane/...`), and the rate-limit headers once
against the live test instance with a read-only `GET /api/v1/users/me/` (`X-Ratelimit-Remaining: 59`,
`X-Ratelimit-Reset: <epoch>`). Report only: no source edits, nothing staged.

### A1 [MAJOR] Plane ingress relies on retries that Plane v1.4.2 does not make, and a long outage disables the webhook
File: src/api/handler.ts:111-113 (also :81-84)
Doc: /websites/developers_plane_so — "4xx responses are not retried. Plane treats them as a deliberate rejection from your server." … "After **5 failed attempts**, Plane automatically disables the webhook and emails the webhook creator. Re-enable it from the webhook list once your endpoint is fixed." … "Retry behavior is automatic. There is no way to trigger a manual retry for a failed delivery."
Code: "res.writeHead(503, { \"Content-Type\": \"application/json\" });" (enqueue failure) and "res.end(JSON.stringify({ error: \"Invalid signature\" }));" (401)
Source check: v1.4.2 `bgtasks/webhook_task.py` retries only on transport errors (`autoretry_for=(requests.RequestException,)`, `max_retries=5`); an HTTP 503 response does not raise, so it is logged and never sent again. After the last transport failure it runs `Webhook.objects.filter(pk=webhook.id).update(is_active=False)`.
Impact: (1) Every Plane delivery answered 503 (Redis or queue down) or 401 (secret rotated in Plane before `PLANE_WEBHOOK_SECRET`) is lost for good, and Plane offers no redelivery. Nothing downstream replays it: the reconcile sweep only orphans links. (2) If git-sync is unreachable (connection refused or 30 s timeout) for the whole retry window (5 retries, Celery `retry_backoff=600` with jitter, about 30 to 50 minutes), Plane sets `is_active=False` on the webhook. After that, all Plane→GitHub sync stops silently until someone re-enables the webhook by hand. Nothing in `src/` or `deploy/` detects this. `deploy/APPLY.md` §11 only covers GitHub redelivery.
Fix: For Plane, return 2xx only once the event is persisted. When enqueue fails, write the raw delivery to Postgres (`audit_log` already stores payloads) and replay it later instead of answering 503. Add a health check that reads the webhook through Plane's API or DB, or at least the time of the last Plane delivery, and alerts when it is inactive or silent. Document the re-enable step and the order for rotating the secret in `deploy/APPLY.md`.

### A2 [MAJOR] The reconcile sweep orphans links to archived work items (and items in archived projects)
File: src/sync/reconcile.ts:22-26, src/sync/plane.ts:192-193
Doc: /websites/developers_plane_so — "Restore an archived work item by clearing its `archived_at` field, making it visible in lists and detail reads again." and "Archives a work item. Sets `archived_at`. Reversible via unarchive. Archived items are removed from default query set." and (archive errors) "`404` | `not_found` | No such work item, it's outside your project or tenant, or it is already archived."
Code: "await deps.plane.getIssue(link.plane_workspace_slug, link.plane_project_id, link.plane_issue_id);" → "if (err instanceof PlaneApiError && err.status === 404) {" → "await markLinkOrphaned(deps.db, link.id);"
Source check: v1.4.2 `IssueDetailAPIEndpoint.get` reads `Issue.issue_objects`, whose manager does `.exclude(archived_at__isnull=False).exclude(project__archived_at__isnull=False)` (`db/models/issue.py` `IssueManager`). The resulting `ObjectDoesNotExist` becomes a 404 in `BaseAPIView.handle_exception`. PATCH uses `Issue.objects` and still succeeds on archived items.
Impact: Archiving a closed item is a routine Plane action, and per-project auto-archive (`archive_in`) can do it automatically. Once an item is archived, the next sweep marks its link `orphaned`, which stops all checks for good. With linkback enabled, `linkbackOnOrphan` also posts "The linked Plane work item can no longer be found…" on the GitHub issue, which is false. Unarchiving does not restore the link. Archiving a whole project orphans every link in it at once.
Fix: Treat 404 as "not visible" and confirm before orphaning. For example, look the item up through the project's archived list (`GET …/projects/{pid}/archived-issues/` in the app API, or v2 `workitem.list_archived`), or treat a 404 as orphaned only when the project itself still answers and a second sweep agrees. Store an `archived` status separately from `orphaned`, and never post the linkback for archived items.

### A3 [MAJOR] Plane deliveries are not ordered, but the mirror applies them as if they were (a stale retry overwrites a newer edit)
File: src/sync/mirror.ts:38, src/sync/mirror.ts:530 (also :487, :501)
Doc: /websites/developers_plane_so — "Plane sends webhook requests asynchronously. When an event occurs, Plane queues the delivery and sends a POST request to your endpoint." and "If your endpoint is unavailable or returns a server error, Plane retries using exponential backoff with a ~10-minute base and jitter."
Code: "case \"last_write_wins\": return true; // events arrive in order, so the latest applied change wins" and "const planeIds = idList(Array.isArray(body.activity?.new_value) ? body.activity.new_value : data.assignees);"
Source check: v1.4.2 `model_activity` sends one `webhook_activity.delay(...)` per changed key, and each of those sends `webhook_send_task.delay(...)`. These are independent Celery tasks with no ordering. `event_data` (the `data` snapshot) is captured when the task is queued and resent unchanged on every retry, up to about 10 minutes later each time.
Impact: Two quick edits to the same field (assignees A→B, or state, or title), or one delivery that hits a transport retry, can arrive in reverse order. The mirror writes the older value last: title from the stale `data.name`, state from the stale `data.state`, assignees from the stale `activity.new_value` (a full replacement set). GitHub then keeps the outdated value with no later event to correct it. Last-write-wins is not met.
Fix: Do not trust delivery order. For full-value fields (title, description, state, assignees), re-read the item with `GET …/issues/{id}/?expand=assignees` when the event is applied and mirror the current value, or compare `data.updated_at` against the last value applied for that link and field and drop older events. Label diffs (old_value/new_value) can stay as they are.

### A4 [MINOR] Delivery-id de-duplication cannot catch Plane retries: `X-Plane-Delivery` is new on every attempt
File: src/queue/workers.ts:90 (spec §5 line 237)
Doc: /websites/developers_plane_so — "**X-Plane-Delivery** (string) - Unique UUID per delivery attempt. Matches `delivery_id` in the payload body."
Code: "if (!(await recordDelivery(deps.db, job.source, job.deliveryId))) {"
Source check: v1.4.2 builds the header inside the retried task body (`"X-Plane-Delivery": str(uuid.uuid4())`), so each Celery retry carries a fresh id.
Impact: If git-sync enqueued an event but the connection dropped or the 30 s timeout fired before Plane read the response, Plane resends the event under a new id and it is processed twice. Most writes are idempotent (outbox keys, `external_id`), but `issue_comment` creates a second GitHub comment ("**X** commented in Plane"). The spec's claim "Webhook redelivery → `X-Plane-Delivery` … rejected on repeat" does not hold for Plane.
Fix: Also de-duplicate Plane events on a content key, e.g. `sha256(webhook_id, event, action, data.id, activity.field, activity.new_value, activity.actor.id)`, with a short TTL. Alternatively, give GitHub comment writes an idempotency key derived from the Plane comment id. Correct the spec's wording.

### A5 [MINOR] The token bucket allows about 2× Plane's per-minute limit in a burst
File: src/sync/plane.ts:52, src/sync/plane.ts:118
Doc: /websites/developers_plane_so — "**Limit**: Each client is limited to 60 requests per minute." and "**Scope of Limitation**: The rate limit applies to all requests made with a given API key."
Code: "this.#capacity = capacity ?? (ratePerMinute > 0 ? ratePerMinute : 1);"
Source check: v1.4.2 `ApiKeyRateThrottle(SimpleRateThrottle)` keeps a sliding 60-second history per `X-Api-Key`. A full bucket (60 tokens) plus refill (1 per second) lets about 119 requests through in one sliding minute, so the second half of a burst gets 429.
Impact: Under bursts (bulk PR merges, a reconcile sweep), the client sends requests Plane is certain to reject. They are retried after `Retry-After`, so the result is wasted calls and latency, not lost data. `maxRetries: 5` can still be exhausted under sustained load, and the write then falls back to the outbox's slower retry path. Setting `PLANE_API_RATE_PER_MINUTE` equal to `API_KEY_RATE_LIMIT` (as `deploy/APPLY.md` §8 advises) does not keep the client under the limit.
Fix: Default `burstCapacity` to a small number (e.g. 5 to 10), or use a sliding-window limiter that matches DRF's. Also pause the bucket when a response reports `X-RateLimit-Remaining: 0`.

### A6 [MINOR] The reconcile sweep spends one rate-limited request per active link per interval
File: src/sync/reconcile.ts:22, src/queue/cron.ts:35
Doc: /websites/developers_plane_so — "**Scope of Limitation**: The rate limit applies to all requests made with a given API key." and "**Reset Interval**: The rate limit counter resets every minute."
Code: "await deps.plane.getIssue(link.plane_workspace_slug, link.plane_project_id, link.plane_issue_id);" (run for every active link every `reconciliation_interval_minutes`, default 60)
Impact: The sweep uses the service PAT's single shared bucket. At 60/min, a deployment with N active links spends N/3600 of the whole hourly budget on the sweep (100% at 3,600 links). Because the bucket is FIFO, webhook-driven writes wait behind it.
Fix: Read issues per project in pages (`GET …/projects/{pid}/issues/?per_page=100&fields=id`, about 1 request per 100 links) and diff the ids locally. Fall back to per-issue GETs only for ids missing from the page (see A2). Alternatively, cap the sweep to a fraction of the budget.

### A7 [MINOR] The web session cookie name is hardcoded, but Plane makes it configurable
File: src/ui/plane-auth.ts:15
Doc: /websites/developers_plane_so — (Plane documents only API-key auth for `/api/v1`; session auth is undocumented.) Source v1.4.2 `settings/common.py`: "SESSION_COOKIE_NAME = os.environ.get(\"SESSION_COOKIE_NAME\", \"session-id\")"
Code: "const WEB_COOKIE = \"session-id\";"
Impact: If an operator sets `SESSION_COOKIE_NAME` in `plane.env`, every signed-in admin gets "Sign in to Plane to continue" in the git-sync iframe.
Fix: Read the cookie name from config (`PLANE_SESSION_COOKIE_NAME`, default `session-id`). Note it in `deploy/git-sync.env.example`.

### A8 [MINOR] A workspace slug containing "instances" makes Plane read the admin cookie on the membership check
File: src/ui/plane-auth.ts:74
Doc: /websites/developers_plane_so — (no docs for session middleware.) Source v1.4.2 `authentication/middleware/session.py`: "if \"instances\" in request.path:\n    session_key = request.COOKIES.get(settings.ADMIN_SESSION_COOKIE_NAME)"
Code: "const member = await planeGet(deps, `/api/workspaces/${encodeURIComponent(slug)}/workspace-members/me/`, cookie);"
Impact: For a slug such as `instances-team`, Plane looks for `admin-session-id`, which git-sync does not forward. The request is anonymous, so the workspace admin is always told to sign in. This is an edge case caused by Plane's substring match, but it locks those workspaces out of the UI.
Fix: Forward the `admin-session-id` cookie as well when the slug contains `instances`, or document the limitation.

### A9 [MINOR] The triage guard is dead code: v1.4.2's states list never returns triage states
File: src/sync/plane.ts:249-252
Doc: /websites/developers_plane_so — "Move the work item to another state of the same project. This is the field workflow rules police" (state_id); the v1 states list is documented as the project's states. Source v1.4.2 `db/models/state.py`: "class StateManager(SoftDeletionManager):\n    \"\"\"Default manager - excludes triage states\"\"\"" and `api/views/state.py` `.filter(is_triage=False)`.
Code: "if (found.group === \"triage\") throw new TriageWriteRejected();"
Impact: A triage state id is never in `listStates`, so it fails as `UnknownPlaneState` ("unknown Plane state id"), never as `TriageWriteRejected`. Both are permanent, so §7.1 still holds, but audits and tests that expect the triage error are misleading.
Fix: Treat an id that is missing after a refresh as "unknown or triage" in the error message and audit, or drop the dead branch and its test claim.

### A10 [MINOR] The client uses the deprecated `/issues/` URL family
File: src/sync/plane.ts:189, :193, :307, :321, :338
Doc: /websites/developers_plane_so — "The request uses the GET method with the endpoint /api/v1/workspaces/{workspace_slug}/projects/{project_id}/work-items/{resource_id}/."
Code: "return this.request(\"GET\", `/workspaces/${slug}/projects/${projectId}/issues/${issueId}/`);"
Source check: v1.4.2 `api/urls/work_item.py` lists the `/issues/` paths under "# Deprecated url patterns", next to the `work-items` equivalents served by the same views.
Impact: None on v1.4.2. A future Plane upgrade that drops the deprecated patterns breaks every Plane read and write at once.
Fix: Switch the path builders to `work-items/` (same views, same payloads) and keep one constant for the segment.

## Verified correct
- Webhook signature: HMAC-SHA256 hex of the raw body, compared in constant time (`handler.ts:81-82`). Plane signs `json.dumps(payload)` and `pinned_fetch` sends the same bytes via `requests(json=payload)` — /websites/developers_plane_so ("Use the raw bytes, not a parsed or re-serialized version").
- Webhook headers: `X-Plane-Delivery`, `X-Plane-Event`, `X-Plane-Signature` names, and `X-Plane-Event` values `issue` and `issue_comment` for v1.4.2 CE (the docs' `workitem.created` naming is the newer Cloud format) — /websites/developers_plane_so.
- Payload envelope: `event`, `action`, `webhook_id`, `workspace_id`, `data`, `activity.actor.{id,display_name}`. v1.4.2 also sends `workspace_slug`, which `payloadBelongsToMapping` uses first and backs with `workspace_id` — /websites/developers_plane_so.
- Action verbs: v1.4.2 sends `created`, `updated`, `deleted`; `planeAction` normalizes both the `create` and `created` forms — /makeplane/developer-docs (`"action": "created"`).
- Activity: `field` is null on create (echo hash uses `"created"`), and on update it is the request-body key with `new_value` equal to the requested value, which matches `opHash` in `PlaneWritePath` — /makeplane/developer-docs ("The field that got changed null when created").
- Delete events: `data` carries only `{id}`. The mirror ignores them (field none) and the reconcile sweep handles removal — /makeplane/developer-docs ("Full entity object for create/update events; empty for delete events").
- Echo detection by actor: `activity.actor.id === PLANE_SERVICE_USER_ID` is the documented actor shape, and the consumed op keeps the ledger from swallowing a later human edit — /websites/developers_plane_so.
- Authentication header `X-API-Key` and the `/api/v1` prefix — /websites/developers_plane_so (`-H "X-API-Key: $PLANE_API_KEY"`).
- 429 handling: retries honor `Retry-After` (DRF throttle), then `X-RateLimit-Reset` (epoch seconds), and are capped. POST is retried only on 429, which is never applied — /websites/developers_plane_so ("Honor the `Retry-After` header before retrying"; "`X-RateLimit-Reset`… UTC epoch seconds"). Confirmed live: `X-Ratelimit-Remaining: 59`.
- Pagination: `listAll` follows `next_cursor` while `next_page_results` is true, and treats a bare array as one page — /makeplane/developer-docs (`"next_cursor": "20:2:0"`, `"next_page_results": true`).
- `external_id`/`external_source` create idempotency: the GET with both params returns one object or 404 (`Issue.objects.get`), and the POST conflict is 409 `{"error": "Issue with the same external id and external source already exists", "id"}`. Both match `#create` exactly — /websites/developers_plane_so ("Fetches a work item … by specifying the external_source and external_id parameters").
- Comment idempotency: `IssueCommentCreateSerializer` accepts `external_source`/`external_id`, and the 409 text "Work item comment with the same external id and external source already exists" plus `id` matches the code — /websites/developers_plane_so (create comment, 409 EXTERNAL_ID_EXISTS).
- Label upsert: a duplicate name returns 409 `{"error": "Label with the same name already exists in the project", "id"}`, and `upsert_label` reuses that `id` — /makeplane/developer-docs (label create).
- Link duplicate: `IssueLinkCreateSerializer.create` raises `{"error": "URL already exists for this Issue"}` as a 400, which matches `DUPLICATE_LINK` — /websites/developers_plane_so (create link).
- PATCH payload keys `state`, `labels`, `assignees`, `name`: these are v1 `IssueSerializer` write fields. `labels`/`assignees` replace the whole set, which `pr-automation` honors by sending the full set — /websites/developers_plane_so ("**Replaces** the whole label set").
- Webhook `data` for `issue` uses `IssueExpandSerializer` with `state` as `{id,name,color,group}` and labels/assignees expanded, which matches `data.state.group` and `labelNameById` in the mirror — /makeplane/developer-docs (work item object).
- Session check: `GET /api/users/me/` with `session-id` and `GET /api/instances/admins/me/` with `admin-session-id` (v1.4.2 `ADMIN_SESSION_COOKIE_NAME = "admin-session-id"`). `workspace-members/me/` returns `role`, and a non-member gets a `null` role, which the code turns into 403 — /websites/developers_plane_so ("role (20=Admin, 15=Member, 5=Guest)").
- Fork, web routes: v1.4.2 `routes.ts` uses `mergeRoutes(coreRoutes, extendedRoutes)`, which deep-merges by `file`. The patch's `extended.ts` repeats the exact core layout chain `(all)/layout.tsx → [workspaceSlug]/layout.tsx → (settings)/layout.tsx → settings/(workspace)/layout.tsx`, so the page nests under the settings layout with no duplicate route ids — v1.4.2 source `apps/web/app/routes/helper.ts` (Context7 /websites/developers_plane_so is silent on fork routing).
- Fork, settings access: the v1.4.2 settings layout authorizes `WORKSPACE_SETTINGS_ACCESS[pathnameToAccessKey(pathname).accessKey]`, with accessKey `/settings/git-sync` for `/<slug>/settings/git-sync`. The patched map adds exactly that key for ADMIN, and the sidebar entry sits in the existing `developer` category (which always has `webhooks` for admins) — v1.4.2 source `apps/web/core/components/settings/helper.ts` (docs silent).
- Fork, admin: `route("git-sync", …)` is added inside the dashboard layout before the `*` catch-all, and the iframe path `/git-sync/ui/admin` is same-origin, so `admin-session-id` reaches the service — v1.4.2 source `apps/admin/app/routes.ts` (docs silent).
- Webhook SSRF guard: v1.4.2 `pinned_fetch` rejects private targets. The configured URL `https://tasks.qelal.et/git-sync/webhooks/plane` resolves to public (Cloudflare) addresses, so deliveries are allowed — /websites/developers_plane_so (webhook delivery).
