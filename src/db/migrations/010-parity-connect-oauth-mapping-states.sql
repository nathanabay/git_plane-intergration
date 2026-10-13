-- Migration 010: schema for the parity plan (docs/plan/parity-plan.md, C0).

-- C0/C2/C8: the App's OAuth client and edition. `client_secret_v1` holds an encryptSecret blob, the
-- same format as private_key_v1. `app_slug` builds the install URL (C1). The edition picks the hosts
-- (C8): github.com, a ghe.com subdomain (api.<sub>.ghe.com), or a GHES base URL (ghe_base_url).
ALTER TABLE github_app_config ADD COLUMN client_id TEXT;
ALTER TABLE github_app_config ADD COLUMN client_secret_v1 TEXT;
ALTER TABLE github_app_config ADD COLUMN app_slug TEXT;
ALTER TABLE github_app_config ADD COLUMN edition TEXT NOT NULL DEFAULT 'github';
ALTER TABLE github_app_config ADD COLUMN ghe_subdomain TEXT;

-- Existing rows: a base URL of the form https://api.<sub>.ghe.com is Enterprise Cloud, any other base
-- URL is Enterprise Server.
UPDATE github_app_config SET
  edition = CASE
    WHEN lower(ghe_base_url) ~ '^https://api\.[a-z0-9]([a-z0-9-]*[a-z0-9])?\.ghe\.com/?$' THEN 'ghe_cloud'
    ELSE 'ghes'
  END,
  ghe_subdomain = substring(lower(ghe_base_url) from '^https://api\.([a-z0-9]([a-z0-9-]*[a-z0-9])?)\.ghe\.com/?$')
WHERE ghe_base_url IS NOT NULL AND ghe_base_url <> '';

ALTER TABLE github_app_config ADD CONSTRAINT github_app_config_edition_check
  CHECK (edition IN ('github', 'ghe_cloud', 'ghes'));
ALTER TABLE github_app_config ADD CONSTRAINT github_app_config_ghe_subdomain_check
  CHECK (ghe_subdomain IS NULL OR ghe_subdomain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$');
ALTER TABLE github_app_config ADD CONSTRAINT github_app_config_ghe_cloud_needs_subdomain
  CHECK (edition <> 'ghe_cloud' OR ghe_subdomain IS NOT NULL);

-- C1/C2: single-use state for the install and OAuth callbacks. Only the SHA-256 of the nonce is kept,
-- so a copy of this table cannot be replayed. The PKCE verifier is an encryptSecret blob. A chained
-- OAuth step started by the install callback carries the installation it must confirm.
CREATE TABLE oauth_states (
  nonce_hash TEXT PRIMARY KEY CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  purpose TEXT NOT NULL CHECK (purpose IN ('install', 'oauth')),
  workspace_slug TEXT NOT NULL,
  plane_user_id TEXT NOT NULL,
  pkce_verifier_v1 TEXT,
  installation_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CHECK (purpose <> 'oauth' OR pkce_verifier_v1 IS NOT NULL),
  CHECK (expires_at > created_at)
);
CREATE INDEX idx_oauth_states_expires_at ON oauth_states(expires_at);

-- C2: a GitHub App user token expires (8 h) and comes with a refresh token (about 6 months); both are
-- omitted when token expiration is disabled, so they stay nullable. `ciphertext` keeps the access
-- token. A failed refresh sets `needs_reauth` and the service identity is used instead.
ALTER TABLE user_tokens ADD COLUMN refresh_ciphertext TEXT;
ALTER TABLE user_tokens ADD COLUMN access_expires_at TIMESTAMPTZ;
ALTER TABLE user_tokens ADD COLUMN refresh_expires_at TIMESTAMPTZ;
ALTER TABLE user_tokens ADD COLUMN needs_reauth BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE user_tokens ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- C4: per-mapping open and closed Plane states (state UUIDs; NULL falls back to the defaults).
-- N2: report failures where the user acted, off by default. N3: branch-name template with {key}.
ALTER TABLE repo_mappings ADD COLUMN open_state_id TEXT;
ALTER TABLE repo_mappings ADD COLUMN closed_state_id TEXT;
ALTER TABLE repo_mappings ADD COLUMN report_problems BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE repo_mappings ADD COLUMN branch_template TEXT;
ALTER TABLE repo_mappings ADD CONSTRAINT repo_mappings_open_closed_differ
  CHECK (open_state_id IS NULL OR closed_state_id IS NULL OR open_state_id <> closed_state_id);
ALTER TABLE repo_mappings ADD CONSTRAINT repo_mappings_branch_template_key
  CHECK (branch_template IS NULL OR position('{key}' in branch_template) > 0);

-- N6: "Require signed commits for Smart Commits". NULL means unset: REQUIRE_VERIFIED_COMMITS applies.
ALTER TABLE instance_settings ADD COLUMN require_verified_commits BOOLEAN;
