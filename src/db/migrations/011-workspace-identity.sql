-- Audit S2: Plane frees a deleted workspace's slug (it renames the soft-deleted row to `<slug>__<epoch>`), and every
-- git-sync row is keyed by slug. Each slug is bound to the Plane workspace id first seen for it, so a new workspace
-- that reuses the slug cannot inherit the old one's installations, mappings, links or audit payloads.
CREATE TABLE IF NOT EXISTS workspace_identity (
  workspace_slug TEXT PRIMARY KEY,
  plane_workspace_id TEXT NOT NULL,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now()
);
