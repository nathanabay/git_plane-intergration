-- Migration 007: unlink tombstones (round-4 F11) and the durable "a database credential row was seen" marker (prev F15).

-- An admin unlinking a GitHub account in a workspace must not be undone by the next event's email auto-link.
-- Keyed by GitHub id (stable across renames). A manual PUT /user-links clears it.
CREATE TABLE IF NOT EXISTS user_link_tombstones (
  workspace_slug TEXT NOT NULL,
  gh_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_slug, gh_id)
);

-- Once the instance admin stored GitHub App credentials, the environment bootstrap secret must never be accepted again,
-- even after the row is lost or after a restart. In memory this was forgotten on restart; this row is not.
CREATE TABLE IF NOT EXISTS github_credential_state (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  db_row_seen BOOLEAN NOT NULL DEFAULT TRUE,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO github_credential_state (id) SELECT 1 WHERE EXISTS (SELECT 1 FROM github_app_config) ON CONFLICT (id) DO NOTHING;

-- Round-4 F4 (CC): the 003 unique index also counted orphaned rows, so re-labelling an item whose partner was deleted could not
-- create the replacement link. Only ACTIVE label_sync links are unique. No ON CONFLICT clause targets this index.
DROP INDEX IF EXISTS uq_sync_links_label_sync;
CREATE UNIQUE INDEX uq_sync_links_label_sync ON sync_links (gh_repo_id, gh_number, gh_kind) WHERE created_by = 'label_sync' AND status = 'active';
