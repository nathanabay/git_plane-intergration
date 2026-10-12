-- All identity decisions in a workspace take this row lock on a dedicated transaction connection.
-- A workspace lock also covers replacement of a mapping between two different GitHub accounts.
CREATE TABLE user_link_locks (
  workspace_slug TEXT PRIMARY KEY
);

-- Heal accounts resurrected by the pre-lock unlink race, including their actor credentials.
WITH unlinked AS (
  DELETE FROM user_map u USING user_link_tombstones t
  WHERE u.workspace_slug = t.workspace_slug AND u.gh_id = t.gh_id
  RETURNING u.plane_user_id
)
DELETE FROM user_tokens WHERE plane_user_id IN (SELECT plane_user_id FROM unlinked);

-- Saving credentials and retiring the bootstrap source must commit together, including saves
-- by older application versions. The state survives deletion of github_app_config.
CREATE FUNCTION retire_github_bootstrap() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO github_credential_state (id) VALUES (1)
  ON CONFLICT (id) DO UPDATE SET db_row_seen = TRUE;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER retire_github_bootstrap_on_save
AFTER INSERT OR UPDATE ON github_app_config
FOR EACH ROW EXECUTE FUNCTION retire_github_bootstrap();

INSERT INTO github_credential_state (id)
SELECT 1 WHERE EXISTS (SELECT 1 FROM github_app_config)
ON CONFLICT (id) DO UPDATE SET db_row_seen = TRUE;
