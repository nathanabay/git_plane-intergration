-- A1: a Plane delivery that cannot be queued is kept here and replayed. Plane v1.4.2 never resends a
-- delivery that got an HTTP answer, so answering 503 would lose it for good.
CREATE TABLE inbound_spool (
  id BIGSERIAL PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('plane', 'github')),
  delivery_id TEXT NOT NULL,
  event TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, delivery_id)
);

-- A1: Plane disables a webhook after its retries fail; the sweep watches for Plane changes that never
-- arrived as deliveries. One row per ingress source, `silent_since` set while deliveries look missing.
CREATE TABLE ingress_health (
  source TEXT PRIMARY KEY CHECK (source IN ('plane', 'github')),
  silent_since TIMESTAMPTZ,
  latest_change_at TIMESTAMPTZ,
  last_delivery_at TIMESTAMPTZ,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_latest ON webhook_deliveries(source, received_at);

-- A2: Plane hides archived items (and items of archived projects) from detail reads with a 404. Such a
-- link stays active and is marked archived instead of orphaned; `missing_since` holds an unexplained
-- 404 until a second sweep confirms it.
ALTER TABLE sync_links ADD COLUMN plane_archived_at TIMESTAMPTZ;
ALTER TABLE sync_links ADD COLUMN missing_since TIMESTAMPTZ;
