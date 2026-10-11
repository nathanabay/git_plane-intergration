-- F6: durable outbound writes table for write ordering per target object
CREATE TABLE IF NOT EXISTS outbound_writes (
  id TEXT PRIMARY KEY,
  sequence BIGSERIAL NOT NULL UNIQUE,
  side TEXT NOT NULL CHECK (side IN ('plane', 'github')),
  target_key TEXT NOT NULL,
  delivery_id TEXT,
  workspace_slug TEXT,
  actor_user_id TEXT,
  write JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'failed')),
  attempts INT NOT NULL DEFAULT 0,
  retry_at TIMESTAMPTZ,
  result JSONB,
  error JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outbound_writes_pending ON outbound_writes(target_key, sequence) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_outbound_writes_retention ON outbound_writes(status, updated_at) WHERE status IN ('applied', 'failed');

ALTER TABLE instance_settings ADD COLUMN IF NOT EXISTS outbound_retention_days INT NOT NULL DEFAULT 30;
