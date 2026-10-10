# Findings: Plane v1.4.2 API Research

These findings address the open questions for the Plane ↔ GitHub sync service based on the source code of `makeplane/plane` at tag `v1.4.2`.

## 1. Do REST API writes fire webhooks? (CRITICAL)
**CONFIRMED:** Yes, REST API writes trigger webhooks for creations and updates, identical to the web app.
* **Code path:** In `apps/api/plane/api/views/issue.py`, `IssueDetailAPIEndpoint.patch` (line 819) explicitly calls `model_activity.delay(model_name="issue", ...)`. This is the exact same celery task called by the internal web app in `apps/api/plane/app/views/issue/base.py`.
* **Webhook delivery:** `model_activity` computes the diffs and calls `webhook_activity.delay` (in `apps/api/plane/bgtasks/webhook_task.py` line 507), which in turn enqueues `webhook_send_task.delay`.
* **Important Caveat:** API and App *deletions* (`delete` and `destroy` methods) for issues do **NOT** trigger webhooks. They only trigger internal `issue_activity` audit logs. Project deletions, however, do trigger webhooks.

## 2. Webhook event catalog
**CONFIRMED:**
* **`X-Plane-Event` values:** `project`, `issue`, `module`, `module_issue`, `cycle`, `cycle_issue`, `issue_comment` (filtered in `webhook_activity`, `apps/api/plane/bgtasks/webhook_task.py`).
* **`action` values:** `create`, `update`, `delete` (mapped in `webhook_send_task`, `apps/api/plane/bgtasks/webhook_task.py` lines 279-284).
* **Payload Shape:**
  * **`data`**: The full serialized object representation via `SERIALIZER_MAPPER` (e.g. `IssueExpandSerializer`).
  * **`activity`**: Identifies the actor and the changed fields, which is perfect for our echo-loop prevention:
    ```json
    {
      "field": "title",
      "new_value": "New Title",
      "old_value": "Old Title",
      "actor": { "id": "...", "first_name": "...", "last_name": "...", "email": "...", "avatar_url": "...", "display_name": "..." },
      "old_identifier": null,
      "new_identifier": null
    }
    ```

## 3. State model
**CONFIRMED:**
* **`group` values:** `backlog`, `unstarted`, `started`, `completed`, `cancelled`, `triage` (`StateGroup` in `apps/api/plane/db/models/state.py`).
* **Default:** `backlog` is the default group enum. Upon issue creation, the state defaults to the `State` marked `default=True` for the project.
* **State reference:** The `state` field on an issue is a `ForeignKey` to the `State` model (`apps/api/plane/db/models/issue.py` line 121), so it must be set using the state's UUID (`state` or `state_id` in API payloads).

## 4. `issues/{id}/links/` semantics
**CONFIRMED:**
* **Fields:** `title`, `url`, `issue_id` (via `IssueLinkCreateSerializer` in `apps/api/plane/api/serializers/issue.py`).
* **Duplicates:** A duplicate URL on the same issue is **rejected loudly**. The `IssueLinkCreateSerializer.create` method checks for existence and raises a `ValidationError` (`{"error": "URL already exists for this Issue"}`), returning a `400 Bad Request`. We do not need to manually deduplicate link insertions.

## 5. Labels
**CONFIRMED:**
* **Schema:** `name`, `color`, `description`, `external_source`, `external_id`, `sort_order` (`apps/api/plane/db/models/label.py`).
* **Uniqueness:** Guaranteed unique by project via a `UniqueConstraint` on `["project", "name"]` where `deleted_at__isnull=True`.
* **Duplicates:** If a duplicate name is created, it raises an `IntegrityError` which is caught in `LabelListCreateAPIEndpoint.post` (`apps/api/plane/api/views/issue.py` line 962). It returns a `409 Conflict` with the payload `{"error": "Label with the same name already exists in the project", "id": "<existing_id>"}`.

## 6. Members
**CONFIRMED:**
* **Exposed Fields:** The member endpoints (`apps/api/plane/api/views/member.py`) serialize data using `UserLiteSerializer` (`apps/api/plane/api/serializers/user.py`).
* **Email Exposure:** **CRITICAL — Yes, the email is exposed.** The `UserLiteSerializer` fields list is `["id", "first_name", "last_name", "email", "avatar", "avatar_url", "display_name"]`. We can safely match GitHub commits to Plane users by email.

## 7. PAT scope
**CONFIRMED:**
* **Scope:** Tokens (`APIToken`) can be optionally tied to a workspace, but they are inherently tied to the user (`user` ForeignKey).
* **Permissions:** In `APIKeyAuthentication` (`apps/api/plane/api/middleware/api_authentication.py`), the request is authenticated directly as the token's owning user (`return (api_token.user, api_token.token)`).
* **Result:** A PAT carries the exact permissions of its owning user, and API calls act on behalf of that user.

## 8. Error and pagination shapes
**CONFIRMED:**
* **JSON error envelope:** Standardized as `{"error": "<Message here>"}` (from `BaseAPIView.handle_exception` in `apps/api/plane/api/views/base.py`).
* **HTTP codes:**
  * **400 Bad Request:** Validation errors (`ValidationError`, `KeyError`) or payload integrity failures.
  * **403 Forbidden:** Permission failures (e.g. `Only admin or creator can delete the work item`).
  * **404 Not Found:** `ObjectDoesNotExist`.
  * **409 Conflict:** Semantic duplicates (e.g. label name collision, duplicate `external_id`).
* **Pagination format:** Managed by `BasePaginator` (`apps/api/plane/utils/paginator.py`):
  ```json
  {
      "grouped_by": null,
      "sub_grouped_by": null,
      "total_count": 0,
      "next_cursor": "string",
      "prev_cursor": "string",
      "next_page_results": true,
      "prev_page_results": false,
      "count": 0,
      "total_pages": 0,
      "total_results": 0,
      "extra_stats": null,
      "results": []
  }
  ```
