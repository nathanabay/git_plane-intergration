-- Migration 006: Workspace to GitHub App installation allow-list table (F4)
-- A GitHub App installation belongs to at most ONE workspace.
CREATE TABLE IF NOT EXISTS workspace_installations (
  installation_id BIGINT PRIMARY KEY,
  workspace_slug TEXT NOT NULL,
  account_login TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspace_installations_slug ON workspace_installations(workspace_slug);

-- Pending sync link markers for atomic opt-in mirror creates (F1/F2 contract with CB)
CREATE TABLE IF NOT EXISTS pending_sync_links (
  key TEXT PRIMARY KEY,
  outbox_id TEXT NOT NULL REFERENCES outbound_writes(id) ON DELETE CASCADE,
  link JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
