import type { Db } from "./migrate.ts";
import type { SyncLinkRow } from "./schema.ts";

export async function recordDelivery(db: Db, source: "plane" | "github", deliveryId: string): Promise<boolean> {
  try {
    await db.query(`INSERT INTO webhook_deliveries (source, delivery_id) VALUES ($1, $2)`, [source, deliveryId]);
    return true;
  } catch (err: any) {
    if (err.code === '23505' || err.message?.includes('duplicate key')) return false;
    throw err;
  }
}

/**
 * One claim per (SHA, workspace) (§5, F16). `workspaceSlug` defaults to the global claim, which is what the
 * pre-F16 callers and the A3 oracle use: the SHA alone, whatever repository sent it.
 */
export async function claimCommit(db: Db, sha: string, repoId: number, workspaceSlug = ""): Promise<boolean> {
  try {
    await db.query(`INSERT INTO processed_commits (sha, repo_id, workspace_slug) VALUES ($1, $2, $3)`, [sha, repoId, workspaceSlug]);
    return true;
  } catch (err: any) {
    if (err.code === '23505' || err.message?.includes('duplicate key')) return false;
    throw err;
  }
}

/** Gives a claim back, for a caller whose processing failed in a way a retry should redo. */
export async function releaseCommit(db: Db, sha: string, workspaceSlug = ""): Promise<void> {
  await db.query(`DELETE FROM processed_commits WHERE sha = $1 AND workspace_slug = $2`, [sha, workspaceSlug]);
}

// ---- in-flight create markers (F13) -------------------------------------------------------------------
// A create's echo needs the new id, which exists only after the response. Between the request and the
// moment the id's op is recorded, an echo could be taken for a human event. The marker lives in
// applied_ops (so TTL pruning also cleans up after a crash) and makes ingress retry such an event shortly.
export const PENDING_TTL_SECONDS = 30;

export async function markCreatePending(db: Db, hash: string, direction: "to_plane" | "to_github"): Promise<void> {
  await recordAppliedOps(db, [{ opHash: hash, direction }]);
}

export async function clearCreatePending(db: Db, hash: string): Promise<void> {
  await forgetAppliedOps(db, [hash]);
}

export async function createPending(db: Db, hash: string): Promise<boolean> {
  const r = await db.query(`SELECT 1 FROM applied_ops WHERE op_hash = $1 AND created_at >= NOW() - INTERVAL '1 second' * $2 LIMIT 1`, [hash, PENDING_TTL_SECONDS]);
  return r.rows.length > 0;
}

// ---- retention (F17, F13) -----------------------------------------------------------------------------
export interface Retention {
  deliveryDays: number;
  commitDays: number;
  auditPayloadDays: number;
  outboundDays?: number;
}

export async function readRetention(db: Db): Promise<Retention> {
  const { rows } = await db.query<any>(`SELECT delivery_retention_days, commit_retention_days, audit_payload_retention_days, outbound_retention_days FROM instance_settings WHERE id = 1`);
  const r = rows[0];
  const days = (v: unknown, d: number) => (Number.isFinite(Number(v)) && Number(v) >= 1 ? Math.floor(Number(v)) : d);
  return {
    deliveryDays: days(r?.delivery_retention_days, 30),
    commitDays: days(r?.commit_retention_days, 180),
    auditPayloadDays: days(r?.audit_payload_retention_days, 90),
    outboundDays: days(r?.outbound_retention_days ?? r?.delivery_retention_days, 30),
  };
}

/** Prunes the idempotency ledgers, strips payloads from old audit rows, and prunes old applied/failed outbound writes (F13). */
export async function pruneLedgers(db: Db, r: Retention): Promise<{ deliveries: number; commits: number; auditPayloads: number; outboundWrites: number }> {
  const count = async (sql: string, days: number) => Number((await db.query<{ n: number }>(`WITH d AS (${sql} RETURNING 1) SELECT count(*)::int AS n FROM d`, [days])).rows[0]?.n ?? 0);
  const outboundDays = r.outboundDays ?? r.deliveryDays;
  return {
    deliveries: await count(`DELETE FROM webhook_deliveries WHERE received_at < NOW() - INTERVAL '1 day' * $1`, r.deliveryDays),
    commits: await count(`DELETE FROM processed_commits WHERE processed_at < NOW() - INTERVAL '1 day' * $1 AND workspace_slug <> ''`, r.commitDays),
    auditPayloads: await count(`UPDATE audit_log SET detail = detail - 'payload' WHERE created_at < NOW() - INTERVAL '1 day' * $1 AND detail ? 'payload'`, r.auditPayloadDays),
    outboundWrites: await count(`
      DELETE FROM outbound_writes
      WHERE status IN ('applied', 'failed')
        AND updated_at < NOW() - INTERVAL '1 day' * $1
        AND id NOT IN (SELECT outbox_id FROM pending_sync_links WHERE outbox_id IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM outbound_writes sibling
          WHERE sibling.status = 'pending'
            AND (
              sibling.write->'_plan'->>'root' = outbound_writes.id
              OR (
                outbound_writes.write->'_plan'->>'root' IS NOT NULL
                AND sibling.write->'_plan'->>'root' = outbound_writes.write->'_plan'->>'root'
              )
            )
        )
    `, outboundDays),
  };
}

export async function recordAppliedOps(db: Db, ops: { opHash: string; direction: "to_plane" | "to_github" }[]): Promise<void> {
  if (ops.length === 0) return;
  const values = ops.map((op, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(', ');
  const params = ops.flatMap(op => [op.opHash, op.direction]);
  await db.query(`INSERT INTO applied_ops (op_hash, direction) VALUES ${values}`, params);
}

/** Removes the rows a failed write recorded: one row per hash (the newest), so duplicates and other writers' rows survive. */
export async function forgetAppliedOps(db: Db, hashes: string[]): Promise<void> {
  for (const h of hashes) {
    await db.query(`
      DELETE FROM applied_ops
      WHERE ctid = (
        SELECT ctid FROM applied_ops WHERE op_hash = $1 ORDER BY created_at DESC LIMIT 1 FOR UPDATE SKIP LOCKED
      )
    `, [h]);
  }
}

/** Lets a redelivery retry after the handler failed: the delivery was recorded but never handled. */
export async function forgetDelivery(db: Db, source: "plane" | "github", deliveryId: string): Promise<void> {
  await db.query(`DELETE FROM webhook_deliveries WHERE source = $1 AND delivery_id = $2`, [source, deliveryId]);
}

export async function consumeRecentOp(db: Db, opHash: string, ttlMinutes: number): Promise<boolean> {
  const res = await db.query(`
    DELETE FROM applied_ops
    WHERE ctid = (
      SELECT ctid FROM applied_ops
      WHERE op_hash = $1 AND created_at >= NOW() - INTERVAL '1 minute' * $2
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING 1
  `, [opHash, ttlMinutes]);
  return res.rows.length > 0;
}

export async function pruneAppliedOps(db: Db, olderThanMinutes: number): Promise<number> {
  const res = await db.query(`
    WITH deleted AS (
      DELETE FROM applied_ops
      WHERE created_at < NOW() - INTERVAL '1 minute' * $1
      RETURNING 1
    )
    SELECT count(*)::int AS n FROM deleted
  `, [olderThanMinutes]);
  return res.rows[0].n;
}

export async function upsertSyncLink(db: Db, link: { planeWorkspaceSlug: string, planeProjectId: string, planeIssueId: string, ghRepoId: string | number, ghNumber: number, ghKind: "issue" | "pr", tier: "closing" | "non_closing" | "relation", createdBy: "magic_word" | "branch" | "label_sync" | "manual" }): Promise<string | number> {
  const res = await db.query(`
    INSERT INTO sync_links (plane_workspace_slug, plane_project_id, plane_issue_id, gh_repo_id, gh_number, gh_kind, tier, created_by, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
    ON CONFLICT (plane_issue_id, gh_repo_id, gh_number)
    DO UPDATE SET status = 'active', orphaned_at = NULL, missing_since = NULL, tier = EXCLUDED.tier, created_by = EXCLUDED.created_by
    RETURNING id
  `, [link.planeWorkspaceSlug, link.planeProjectId, link.planeIssueId, link.ghRepoId, link.ghNumber, link.ghKind, link.tier, link.createdBy]);
  return res.rows[0].id;
}

export async function listActiveSyncLinks(db: Db, opts: { limit: number; afterId?: string | number }): Promise<SyncLinkRow[]> {
  if (opts.afterId !== undefined) {
    const res = await db.query(`SELECT * FROM sync_links WHERE status = 'active' AND id > $1 ORDER BY id ASC LIMIT $2`, [opts.afterId, opts.limit]);
    return res.rows;
  }
  const res = await db.query(`SELECT * FROM sync_links WHERE status = 'active' ORDER BY id ASC LIMIT $1`, [opts.limit]);
  return res.rows;
}

export async function markLinkOrphaned(db: Db, id: string | number): Promise<void> {
  await db.query(`UPDATE sync_links SET status = 'orphaned', orphaned_at = NOW() WHERE id = $1`, [id]);
}

export async function appendAudit(db: Db, entry: { kind: string, source?: string, deliveryId?: string, workspaceSlug?: string, detail?: any, outcome: string, error?: string, replayOf?: string | number }): Promise<string | number> {
  const res = await db.query(`
    INSERT INTO audit_log (kind, source, delivery_id, detail, outcome, error, replay_of, workspace_slug)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id
  `, [entry.kind, entry.source || null, entry.deliveryId || null, entry.detail ? JSON.stringify(entry.detail) : null, entry.outcome, entry.error || null, entry.replayOf || null, entry.workspaceSlug || null]);
  return res.rows[0].id;
}

/** The Plane item answered: it is visible, so neither archived nor missing (A2). */
export async function markLinkChecked(db: Db, id: string | number): Promise<void> {
  await db.query(`UPDATE sync_links SET last_checked_at = NOW(), plane_archived_at = NULL, missing_since = NULL WHERE id = $1`, [id]);
}

/** A2: the item or its project is archived in Plane. The link stays active and keeps being checked. */
export async function markLinkArchived(db: Db, id: string | number): Promise<void> {
  await db.query(`UPDATE sync_links SET last_checked_at = NOW(), plane_archived_at = COALESCE(plane_archived_at, NOW()), missing_since = NULL WHERE id = $1`, [id]);
}

/**
 * A2: an unexplained 404. Returns when it was first seen: `null` means this sweep is the first to see it,
 * so the caller must wait for a later sweep to agree before orphaning.
 */
export async function markLinkMissing(db: Db, id: string | number): Promise<Date | null> {
  const res = await db.query<{ previous: string | Date | null }>(`
    UPDATE sync_links l SET missing_since = COALESCE(l.missing_since, NOW()), last_checked_at = NOW()
    FROM (SELECT id, missing_since AS previous FROM sync_links WHERE id = $1) prior
    WHERE l.id = prior.id
    RETURNING prior.previous
  `, [id]);
  const previous = res.rows[0]?.previous;
  return previous ? new Date(previous) : null;
}

// ---- Plane ingress spool and health (A1) -----------------------------------------------------------------
export interface SpooledDelivery { id: string | number; source: "plane" | "github"; delivery_id: string; event: string; received_at: string | Date; payload: unknown; attempts: number }

/** Keeps a verified delivery that could not be queued. A repeat of the same delivery id is a no-op. */
export async function spoolInbound(db: Db, job: { source: "plane" | "github"; deliveryId: string; event: string; receivedAt: string; payload: unknown }): Promise<void> {
  await db.query(`
    INSERT INTO inbound_spool (source, delivery_id, event, received_at, payload) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (source, delivery_id) DO NOTHING
  `, [job.source, job.deliveryId, job.event, job.receivedAt, JSON.stringify(job.payload ?? null)]);
}

export async function listSpooled(db: Db, limit: number): Promise<SpooledDelivery[]> {
  return (await db.query<SpooledDelivery>(`SELECT * FROM inbound_spool ORDER BY id ASC LIMIT $1`, [limit])).rows;
}

export async function deleteSpooled(db: Db, id: string | number): Promise<void> {
  await db.query(`DELETE FROM inbound_spool WHERE id = $1`, [id]);
}

export async function markSpoolFailed(db: Db, id: string | number, error: string): Promise<void> {
  await db.query(`UPDATE inbound_spool SET attempts = attempts + 1, last_error = $2 WHERE id = $1`, [id, error.slice(0, 500)]);
}

/** When the newest delivery from `source` was taken off the queue, or null if none is on record. */
export async function lastDeliveryAt(db: Db, source: "plane" | "github"): Promise<Date | null> {
  const res = await db.query<{ at: string | Date | null }>(`SELECT max(received_at) AS at FROM webhook_deliveries WHERE source = $1`, [source]);
  const at = res.rows[0]?.at;
  return at ? new Date(at) : null;
}

export interface IngressHealth { silentSince: Date | null; latestChangeAt: Date | null; lastDeliveryAt: Date | null; checkedAt: Date }

export async function readIngressHealth(db: Db, source: "plane" | "github"): Promise<IngressHealth | null> {
  const r = (await db.query<any>(`SELECT * FROM ingress_health WHERE source = $1`, [source])).rows[0];
  if (!r) return null;
  const d = (v: unknown) => (v ? new Date(v as string) : null);
  return { silentSince: d(r.silent_since), latestChangeAt: d(r.latest_change_at), lastDeliveryAt: d(r.last_delivery_at), checkedAt: new Date(r.checked_at) };
}

/** Records one health check. Returns the previous `silent_since`, so the caller can alert on a change. */
export async function writeIngressHealth(db: Db, source: "plane" | "github", h: { silent: boolean; latestChangeAt: Date | null; lastDeliveryAt: Date | null }): Promise<Date | null> {
  const previous = (await readIngressHealth(db, source))?.silentSince ?? null;
  await db.query(`
    INSERT INTO ingress_health (source, silent_since, latest_change_at, last_delivery_at, checked_at)
    VALUES ($1, CASE WHEN $2::boolean THEN NOW() ELSE NULL END, $3, $4, NOW())
    ON CONFLICT (source) DO UPDATE SET
      silent_since = CASE WHEN $2::boolean THEN COALESCE(ingress_health.silent_since, NOW()) ELSE NULL END,
      latest_change_at = EXCLUDED.latest_change_at, last_delivery_at = EXCLUDED.last_delivery_at, checked_at = NOW()
  `, [source, h.silent, h.latestChangeAt, h.lastDeliveryAt]);
  return previous;
}

/** Distinct Plane projects that have a repository mapping, for the ingress health check. */
export async function listMappedPlaneProjects(db: Db): Promise<{ workspaceSlug: string; projectId: string }[]> {
  const res = await db.query<{ workspace_slug: string; plane_project_id: string }>(`SELECT DISTINCT workspace_slug, plane_project_id FROM repo_mappings ORDER BY workspace_slug, plane_project_id`);
  return res.rows.map((r) => ({ workspaceSlug: r.workspace_slug, projectId: r.plane_project_id }));
}

export async function upsertDevInfoLink(db: Db, link: { planeIssueId: string; key: string; planeLinkId: string }): Promise<void> {
  await db.query(`
    INSERT INTO dev_info_links (plane_issue_id, key, plane_link_id) VALUES ($1, $2, $3)
    ON CONFLICT (plane_issue_id, key) DO UPDATE SET plane_link_id = EXCLUDED.plane_link_id, updated_at = NOW()
  `, [link.planeIssueId, link.key, link.planeLinkId]);
}

export async function getDevInfoLink(db: Db, planeIssueId: string, key: string): Promise<string | null> {
  const res = await db.query<{ plane_link_id: string }>(`SELECT plane_link_id FROM dev_info_links WHERE plane_issue_id = $1 AND key = $2`, [planeIssueId, key]);
  return res.rows[0]?.plane_link_id ?? null;
}

// ---- workspace installations allow-list (F4) ------------------------------------------------------------
export interface WorkspaceInstallation {
  installationId: number;
  workspaceSlug: string;
  accountLogin: string | null;
  createdAt: string;
}

export async function allowlistInstallation(
  db: Db,
  installationId: number | bigint,
  workspaceSlug: string,
  accountLogin?: string | null
): Promise<WorkspaceInstallation> {
  const { rows } = await db.query<{
    installation_id: string | number | bigint;
    workspace_slug: string;
    account_login: string | null;
    created_at: Date | string;
  }>(
    `INSERT INTO workspace_installations (installation_id, workspace_slug, account_login)
     VALUES ($1, $2, $3)
     ON CONFLICT (installation_id) DO UPDATE SET
       workspace_slug = EXCLUDED.workspace_slug,
       account_login = EXCLUDED.account_login
     RETURNING installation_id, workspace_slug, account_login, created_at`,
    [installationId, workspaceSlug, accountLogin ?? null]
  );
  const r = rows[0]!;
  return {
    installationId: Number(r.installation_id),
    workspaceSlug: r.workspace_slug,
    accountLogin: r.account_login,
    createdAt: typeof r.created_at === "string" ? r.created_at : r.created_at.toISOString(),
  };
}

export async function removeInstallationAllowlist(db: Db, installationId: number | bigint): Promise<boolean> {
  const res = await db.query(`DELETE FROM workspace_installations WHERE installation_id = $1 RETURNING 1`, [installationId]);
  return res.rows.length > 0;
}

export async function listWorkspaceInstallations(db: Db, workspaceSlug?: string): Promise<WorkspaceInstallation[]> {
  const query = workspaceSlug
    ? `SELECT installation_id, workspace_slug, account_login, created_at FROM workspace_installations WHERE workspace_slug = $1 ORDER BY workspace_slug, installation_id`
    : `SELECT installation_id, workspace_slug, account_login, created_at FROM workspace_installations ORDER BY workspace_slug, installation_id`;
  const params = workspaceSlug ? [workspaceSlug] : [];
  const { rows } = await db.query<{
    installation_id: string | number | bigint;
    workspace_slug: string;
    account_login: string | null;
    created_at: Date | string;
  }>(query, params);
  return rows.map((r) => ({
    installationId: Number(r.installation_id),
    workspaceSlug: r.workspace_slug,
    accountLogin: r.account_login,
    createdAt: typeof r.created_at === "string" ? r.created_at : r.created_at.toISOString(),
  }));
}

export async function getInstallationWorkspace(db: Db, installationId: number | bigint): Promise<WorkspaceInstallation | null> {
  const { rows } = await db.query<{
    installation_id: string | number | bigint;
    workspace_slug: string;
    account_login: string | null;
    created_at: Date | string;
  }>(
    `SELECT installation_id, workspace_slug, account_login, created_at FROM workspace_installations WHERE installation_id = $1`,
    [installationId]
  );
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    installationId: Number(r.installation_id),
    workspaceSlug: r.workspace_slug,
    accountLogin: r.account_login,
    createdAt: typeof r.created_at === "string" ? r.created_at : r.created_at.toISOString(),
  };
}

// ---- unlink tombstones (round-4 F11) ---------------------------------------------------------------------

// Single-connection engines cannot open overlapping transactions. Production pools instead lease a
// connection and lock a durable workspace row, so separate replicas share the same serialization.
const userLinkTransactions = new WeakMap<Db, Promise<void>>();
export async function withUserLinkTransaction<T>(db: Db, workspaceSlug: string, fn: (conn: Db) => Promise<T>): Promise<T> {
  const run = async (conn: Db): Promise<T> => {
    await conn.exec("BEGIN");
    try {
      // Lock the whole workspace: PUT can replace an account and DELETE addresses a Plane user,
      // so choosing an account lock before reading the current map would itself introduce a race.
      await conn.query("INSERT INTO user_link_locks (workspace_slug) VALUES ($1) ON CONFLICT DO NOTHING", [workspaceSlug]);
      await conn.query("SELECT workspace_slug FROM user_link_locks WHERE workspace_slug = $1 FOR UPDATE", [workspaceSlug]);
      const result = await fn(conn);
      await conn.exec("COMMIT");
      return result;
    } catch (err) {
      await conn.exec("ROLLBACK").catch(() => undefined);
      throw err;
    }
  };
  if (db.withConnection) return db.withConnection(run);
  const previous = userLinkTransactions.get(db) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  userLinkTransactions.set(db, next);
  await previous;
  try { return await run(db); }
  finally { release(); if (userLinkTransactions.get(db) === next) userLinkTransactions.delete(db); }
}

/** Remembers that an admin unlinked this GitHub account in this workspace, so email auto-linking does not undo it. */
export async function addUserLinkTombstone(db: Db, workspaceSlug: string, ghId: number): Promise<void> {
  await db.query(`INSERT INTO user_link_tombstones (workspace_slug, gh_id) VALUES ($1, $2) ON CONFLICT (workspace_slug, gh_id) DO NOTHING`, [workspaceSlug, ghId]);
}

export async function isUserLinkTombstoned(db: Db, workspaceSlug: string, ghId: number): Promise<boolean> {
  return (await db.query(`SELECT 1 FROM user_link_tombstones WHERE workspace_slug = $1 AND gh_id = $2`, [workspaceSlug, ghId])).rows.length > 0;
}

/** A manual link is an explicit admin decision and lifts the tombstone. */
export async function clearUserLinkTombstone(db: Db, workspaceSlug: string, ghId: number): Promise<void> {
  await db.query(`DELETE FROM user_link_tombstones WHERE workspace_slug = $1 AND gh_id = $2`, [workspaceSlug, ghId]);
}

// ---- GitHub credential state (prev F15) ---------------------------------------------------------------------

/** Durably records that a database credential row exists/existed, so the environment fallback is closed for good. */
export async function markCredentialRowSeen(db: Db): Promise<void> {
  await db.query(`INSERT INTO github_credential_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
}

export async function credentialRowEverSeen(db: Db): Promise<boolean> {
  return (await db.query(`SELECT 1 FROM github_credential_state WHERE id = 1 AND db_row_seen`)).rows.length > 0;
}
