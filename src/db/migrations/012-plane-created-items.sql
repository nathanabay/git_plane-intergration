-- E2E-2 (Plane A2): Plane v1.4.2's work-item detail answers 404 for an archived item as for a deleted one, and its
-- activity log records an archive only when Plane's own archive paths run. The v1 list lookup by
-- `external_source` + `external_id` reads `Issue.objects`, which still returns an archived item (with
-- `archived_at`) and hides a deleted one. Every work item git-sync creates carries `external_source = 'gitsync'`
-- and its outbox intent id as `external_id`, so that pair is kept here for reconcile. Applied outbox rows are pruned
-- after the retention period, so the outbox cannot be the only place it is remembered.
CREATE TABLE IF NOT EXISTS plane_created_items (
  plane_issue_id TEXT PRIMARY KEY,
  plane_project_id TEXT NOT NULL,
  external_source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Items created before this migration: recover the pair from outbox rows that are still retained.
INSERT INTO plane_created_items (plane_issue_id, plane_project_id, external_source, external_id)
SELECT result->>'id', write->>'projectId', 'gitsync', id
FROM outbound_writes
WHERE side = 'plane' AND write->>'kind' = 'create_issue' AND result->>'id' IS NOT NULL AND write->>'projectId' IS NOT NULL
ON CONFLICT (plane_issue_id) DO NOTHING;
