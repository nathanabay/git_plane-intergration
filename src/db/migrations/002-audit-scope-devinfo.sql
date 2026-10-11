-- Workspace scoping for the audit views (B3, B8) and replay lookups by delivery.
ALTER TABLE audit_log ADD COLUMN workspace_slug TEXT;
CREATE INDEX idx_audit_log_workspace ON audit_log(workspace_slug, created_at);
CREATE INDEX idx_audit_log_delivery ON audit_log(source, delivery_id);

-- The Plane link carrying each development-information rollup, so B7 updates it in place.
CREATE TABLE dev_info_links (
  plane_issue_id TEXT NOT NULL,
  key TEXT NOT NULL,
  plane_link_id TEXT NOT NULL,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (plane_issue_id, key)
);
