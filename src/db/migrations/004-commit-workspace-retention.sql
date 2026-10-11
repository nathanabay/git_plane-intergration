-- F16: a commit is claimed once per (SHA, workspace), so one repository mapped into two workspaces acts in
-- each, while a fork or branch re-delivering the SHA into the same workspace still dedupes. The empty
-- workspace is the legacy "global" claim that existing rows keep.
ALTER TABLE processed_commits ADD COLUMN workspace_slug TEXT NOT NULL DEFAULT '';
ALTER TABLE processed_commits DROP CONSTRAINT processed_commits_pkey;
ALTER TABLE processed_commits ADD PRIMARY KEY (sha, workspace_slug);

-- F17: retention for the ledgers the maintenance job prunes (days). Defaults are deliberately generous.
ALTER TABLE instance_settings ADD COLUMN delivery_retention_days INT NOT NULL DEFAULT 30;
ALTER TABLE instance_settings ADD COLUMN commit_retention_days INT NOT NULL DEFAULT 180;
ALTER TABLE instance_settings ADD COLUMN audit_payload_retention_days INT NOT NULL DEFAULT 90;
CREATE INDEX idx_webhook_deliveries_received ON webhook_deliveries(received_at);
CREATE INDEX idx_processed_commits_processed ON processed_commits(processed_at);

