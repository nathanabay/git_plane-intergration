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
    DO UPDATE SET status = 'active', orphaned_at = NULL, tier = EXCLUDED.tier, created_by = EXCLUDED.created_by
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

export async function markLinkChecked(db: Db, id: string | number): Promise<void> {
  await db.query(`UPDATE sync_links SET last_checked_at = NOW() WHERE id = $1`, [id]);
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
