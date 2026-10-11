-- The GitHub App installation that serves a mapped repository, learned from its first webhook (or
-- looked up through the App) so writes that start on the Plane side can address GitHub.
ALTER TABLE repo_mappings ADD COLUMN installation_id BIGINT;

-- One Plane item per GitHub issue mirrored by the `plane` label: two simultaneous `labeled` events
-- cannot both win this insert, so the loser creates no second item.
CREATE UNIQUE INDEX uq_sync_links_label_sync ON sync_links (gh_repo_id, gh_number, gh_kind) WHERE created_by = 'label_sync';
