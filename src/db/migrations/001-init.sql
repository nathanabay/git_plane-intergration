CREATE TABLE sync_links (
  id SERIAL PRIMARY KEY,
  plane_workspace_slug TEXT NOT NULL,
  plane_project_id TEXT NOT NULL,
  plane_issue_id TEXT NOT NULL,
  gh_repo_id BIGINT NOT NULL,
  gh_number INT NOT NULL,
  gh_kind TEXT NOT NULL CHECK (gh_kind IN ('issue', 'pr')),
  tier TEXT NOT NULL CHECK (tier IN ('closing', 'non_closing', 'relation')),
  created_by TEXT NOT NULL CHECK (created_by IN ('magic_word', 'branch', 'label_sync', 'manual')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'orphaned')),
  orphaned_at TIMESTAMP WITH TIME ZONE,
  last_checked_at TIMESTAMP WITH TIME ZONE,
  UNIQUE (plane_issue_id, gh_repo_id, gh_number)
);

CREATE TABLE applied_ops (
  op_hash TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('to_plane', 'to_github')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX idx_applied_ops_lookup ON applied_ops(op_hash, direction, created_at);

CREATE TABLE webhook_deliveries (
  source TEXT NOT NULL CHECK (source IN ('plane', 'github')),
  delivery_id TEXT NOT NULL,
  received_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  PRIMARY KEY (source, delivery_id)
);

CREATE TABLE processed_commits (
  sha TEXT PRIMARY KEY,
  repo_id BIGINT NOT NULL,
  processed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE audit_log (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  source TEXT,
  delivery_id TEXT,
  detail JSONB,
  outcome TEXT NOT NULL,
  error TEXT,
  replay_of INT REFERENCES audit_log(id),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX idx_audit_log_created_at ON audit_log(created_at);

CREATE TABLE repo_mappings (
  id SERIAL PRIMARY KEY,
  workspace_slug TEXT NOT NULL,
  gh_repo_id BIGINT NOT NULL,
  gh_repo_full_name TEXT NOT NULL,
  plane_project_id TEXT NOT NULL,
  sync_direction TEXT NOT NULL CHECK (sync_direction IN ('bidirectional', 'github_to_plane')),
  smart_commits_enabled BOOLEAN NOT NULL DEFAULT true,
  linkback_enabled BOOLEAN NOT NULL DEFAULT true,
  autolinks_enabled BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE rule_sets (
  id SERIAL PRIMARY KEY,
  mapping_id INT NOT NULL REFERENCES repo_mappings(id) ON DELETE CASCADE,
  yaml_source TEXT NOT NULL,
  version INT NOT NULL,
  updated_by TEXT,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (mapping_id, version)
);

CREATE TABLE conflict_policies (
  id SERIAL PRIMARY KEY,
  mapping_id INT NOT NULL REFERENCES repo_mappings(id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  policy TEXT NOT NULL CHECK (policy IN ('last_write_wins', 'source_of_truth:github', 'source_of_truth:plane')),
  UNIQUE (mapping_id, field)
);

CREATE TABLE user_map (
  id SERIAL PRIMARY KEY,
  workspace_slug TEXT NOT NULL,
  plane_user_id TEXT NOT NULL,
  gh_login TEXT NOT NULL,
  gh_id BIGINT NOT NULL,
  UNIQUE(workspace_slug, plane_user_id),
  UNIQUE(workspace_slug, gh_id)
);

CREATE TABLE user_tokens (
  plane_user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('plane_pat', 'github_oauth')),
  ciphertext TEXT NOT NULL,
  PRIMARY KEY (plane_user_id, kind)
);

CREATE TABLE instance_settings (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  smart_commits_default BOOLEAN NOT NULL DEFAULT true,
  reconciliation_interval_minutes INT NOT NULL DEFAULT 60,
  op_ttl_minutes INT NOT NULL DEFAULT 10
);

CREATE TABLE magic_words (
  id SERIAL PRIMARY KEY,
  tier TEXT NOT NULL CHECK (tier IN ('closing', 'non_closing', 'relation')),
  words TEXT[] NOT NULL,
  UNIQUE (tier)
);

CREATE TABLE github_app_config (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  app_id BIGINT NOT NULL,
  private_key_v1 TEXT NOT NULL,
  webhook_secret_v1 TEXT NOT NULL,
  ghe_base_url TEXT
);
