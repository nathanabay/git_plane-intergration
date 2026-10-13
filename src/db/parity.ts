import { createHash } from "node:crypto";
import type { Db } from "./migrate.ts";

// Data access for migration 010 (parity plan C0). Secrets arrive and leave as encryptSecret blobs;
// this module never sees plaintext and never decrypts.

const toDate = (v: unknown): Date | null => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v)));

// ---- GitHub App client and edition (C0, C2, C8) -----------------------------------------------------------
export type GithubEdition = "github" | "ghe_cloud" | "ghes";

export interface GithubAppClientConfig {
  clientId: string | null;
  /** encryptSecret blob, like private_key_v1. Never send it to the browser. */
  clientSecretCiphertext: string | null;
  appSlug: string | null;
  edition: GithubEdition;
  gheSubdomain: string | null;
  gheBaseUrl: string | null;
}

export async function readGithubAppClient(db: Db): Promise<GithubAppClientConfig | null> {
  const r = (await db.query<any>(`SELECT client_id, client_secret_v1, app_slug, edition, ghe_subdomain, ghe_base_url FROM github_app_config WHERE id = 1`)).rows[0];
  if (!r) return null;
  return {
    clientId: r.client_id ?? null,
    clientSecretCiphertext: r.client_secret_v1 ?? null,
    appSlug: r.app_slug ?? null,
    edition: r.edition,
    gheSubdomain: r.ghe_subdomain ?? null,
    gheBaseUrl: r.ghe_base_url ?? null,
  };
}

/**
 * Updates the parity fields of the stored App row. A field left undefined keeps its stored value, so a
 * form that does not resend the client secret keeps it. Returns false when no App row exists yet (the
 * row needs app_id and the private key first).
 */
export async function saveGithubAppClient(db: Db, patch: Partial<GithubAppClientConfig>): Promise<boolean> {
  const columns: [keyof typeof patch, string][] = [
    ["clientId", "client_id"], ["clientSecretCiphertext", "client_secret_v1"], ["appSlug", "app_slug"],
    ["edition", "edition"], ["gheSubdomain", "ghe_subdomain"], ["gheBaseUrl", "ghe_base_url"],
  ];
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, column] of columns) {
    if (patch[key] === undefined) continue;
    params.push(patch[key]);
    sets.push(`${column} = $${params.length}`);
  }
  if (sets.length === 0) return (await db.query(`SELECT 1 FROM github_app_config WHERE id = 1`)).rows.length > 0;
  const res = await db.query(`UPDATE github_app_config SET ${sets.join(", ")} WHERE id = 1 RETURNING 1`, params);
  return res.rows.length > 0;
}

// ---- single-use callback state (C1, C2) -------------------------------------------------------------------
export type OAuthStatePurpose = "install" | "oauth";

export interface OAuthState {
  purpose: OAuthStatePurpose;
  workspaceSlug: string;
  planeUserId: string;
  /** encryptSecret blob of the PKCE code_verifier; set for purpose "oauth". */
  pkceVerifierCiphertext: string | null;
  /** The installation a chained OAuth step must confirm through GET /user/installations. */
  installationId: number | null;
  createdAt: Date;
  expiresAt: Date;
}

/** Only this hash is stored, so the table cannot be replayed from a copy. */
export function hashStateNonce(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex");
}

export async function createOAuthState(db: Db, s: {
  nonce: string;
  purpose: OAuthStatePurpose;
  workspaceSlug: string;
  planeUserId: string;
  ttlSeconds: number;
  pkceVerifierCiphertext?: string | null;
  installationId?: number | null;
}): Promise<void> {
  if (!(s.ttlSeconds > 0)) throw new Error("ttlSeconds must be positive");
  await db.query(`
    INSERT INTO oauth_states (nonce_hash, purpose, workspace_slug, plane_user_id, pkce_verifier_v1, installation_id, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '1 second' * $7)
  `, [hashStateNonce(s.nonce), s.purpose, s.workspaceSlug, s.planeUserId, s.pkceVerifierCiphertext ?? null, s.installationId ?? null, s.ttlSeconds]);
}

/**
 * Consumes a state atomically: the first caller gets the row, a replay, an expired state, a wrong
 * purpose or an unknown nonce all get null.
 */
export async function consumeOAuthState(db: Db, nonce: string, purpose: OAuthStatePurpose): Promise<OAuthState | null> {
  const r = (await db.query<any>(`
    UPDATE oauth_states SET consumed_at = NOW()
    WHERE nonce_hash = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > NOW()
    RETURNING purpose, workspace_slug, plane_user_id, pkce_verifier_v1, installation_id, created_at, expires_at
  `, [hashStateNonce(nonce), purpose])).rows[0];
  if (!r) return null;
  return {
    purpose: r.purpose,
    workspaceSlug: r.workspace_slug,
    planeUserId: r.plane_user_id,
    pkceVerifierCiphertext: r.pkce_verifier_v1 ?? null,
    installationId: r.installation_id === null || r.installation_id === undefined ? null : Number(r.installation_id),
    createdAt: toDate(r.created_at)!,
    expiresAt: toDate(r.expires_at)!,
  };
}

/** Deletes states that expired or were consumed more than `graceSeconds` ago. Returns the count. */
export async function pruneOAuthStates(db: Db, graceSeconds = 3600): Promise<number> {
  const res = await db.query<{ n: number }>(`
    WITH d AS (
      DELETE FROM oauth_states
      WHERE expires_at < NOW() - INTERVAL '1 second' * $1 OR consumed_at < NOW() - INTERVAL '1 second' * $1
      RETURNING 1
    ) SELECT count(*)::int AS n FROM d
  `, [graceSeconds]);
  return Number(res.rows[0]?.n ?? 0);
}

// ---- personal GitHub tokens (C2) --------------------------------------------------------------------------
export interface GithubOAuthToken {
  /** encryptSecret blob of the user access token. */
  accessCiphertext: string;
  /** encryptSecret blob of the refresh token; null when the App has token expiration disabled. */
  refreshCiphertext: string | null;
  accessExpiresAt: Date | null;
  refreshExpiresAt: Date | null;
  needsReauth: boolean;
  updatedAt: Date;
}

const rowToToken = (r: any): GithubOAuthToken => ({
  accessCiphertext: r.ciphertext,
  refreshCiphertext: r.refresh_ciphertext ?? null,
  accessExpiresAt: toDate(r.access_expires_at),
  refreshExpiresAt: toDate(r.refresh_expires_at),
  needsReauth: Boolean(r.needs_reauth),
  updatedAt: toDate(r.updated_at)!,
});

const TOKEN_COLUMNS = `ciphertext, refresh_ciphertext, access_expires_at, refresh_expires_at, needs_reauth, updated_at`;

export async function getGithubOAuthToken(db: Db, planeUserId: string): Promise<GithubOAuthToken | null> {
  const r = (await db.query<any>(`SELECT ${TOKEN_COLUMNS} FROM user_tokens WHERE plane_user_id = $1 AND kind = 'github_oauth'`, [planeUserId])).rows[0];
  return r ? rowToToken(r) : null;
}

/** Stores a fresh exchange or refresh result and clears needs_reauth. */
export async function putGithubOAuthToken(db: Db, planeUserId: string, t: {
  accessCiphertext: string;
  refreshCiphertext: string | null;
  accessExpiresAt: Date | null;
  refreshExpiresAt: Date | null;
}): Promise<void> {
  await db.query(`
    INSERT INTO user_tokens (plane_user_id, kind, ciphertext, refresh_ciphertext, access_expires_at, refresh_expires_at, needs_reauth, updated_at)
    VALUES ($1, 'github_oauth', $2, $3, $4, $5, false, NOW())
    ON CONFLICT (plane_user_id, kind) DO UPDATE SET
      ciphertext = EXCLUDED.ciphertext, refresh_ciphertext = EXCLUDED.refresh_ciphertext,
      access_expires_at = EXCLUDED.access_expires_at, refresh_expires_at = EXCLUDED.refresh_expires_at,
      needs_reauth = false, updated_at = NOW()
  `, [planeUserId, t.accessCiphertext, t.refreshCiphertext, t.accessExpiresAt, t.refreshExpiresAt]);
}

/** A refresh failed: keep the row (the UI shows "Needs re-authorization") and use the service identity. */
export async function markGithubOAuthNeedsReauth(db: Db, planeUserId: string): Promise<boolean> {
  const res = await db.query(`UPDATE user_tokens SET needs_reauth = true, updated_at = NOW() WHERE plane_user_id = $1 AND kind = 'github_oauth' RETURNING 1`, [planeUserId]);
  return res.rows.length > 0;
}

/** Disconnect: removes only the GitHub token; the user's Plane token stays. */
export async function deleteGithubOAuthToken(db: Db, planeUserId: string): Promise<boolean> {
  const res = await db.query(`DELETE FROM user_tokens WHERE plane_user_id = $1 AND kind = 'github_oauth' RETURNING 1`, [planeUserId]);
  return res.rows.length > 0;
}

// GitHub rotates the refresh token on every refresh, so two refreshes with the same token invalidate
// each other. The lock is a row lock held on one dedicated connection; a waiter sees the row the winner
// wrote and should skip its own refresh when that token is still fresh. PGlite has a single connection,
// so it is serialized in process instead (same pattern as withUserLinkTransaction).
const refreshQueues = new WeakMap<Db, Promise<void>>();
export async function withGithubOAuthRefreshLock<T>(
  db: Db,
  planeUserId: string,
  fn: (conn: Db, current: GithubOAuthToken | null) => Promise<T>,
): Promise<T> {
  const run = async (conn: Db): Promise<T> => {
    await conn.exec("BEGIN");
    try {
      const r = (await conn.query<any>(`SELECT ${TOKEN_COLUMNS} FROM user_tokens WHERE plane_user_id = $1 AND kind = 'github_oauth' FOR UPDATE`, [planeUserId])).rows[0];
      const result = await fn(conn, r ? rowToToken(r) : null);
      await conn.exec("COMMIT");
      return result;
    } catch (err) {
      await conn.exec("ROLLBACK").catch(() => undefined);
      throw err;
    }
  };
  if (db.withConnection) return db.withConnection(run);
  const previous = refreshQueues.get(db) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  refreshQueues.set(db, next);
  await previous;
  try { return await run(db); }
  finally { release(); if (refreshQueues.get(db) === next) refreshQueues.delete(db); }
}

// ---- per-mapping parity settings (C4, N2, N3) -------------------------------------------------------------
export interface MappingParitySettings {
  openStateId: string | null;
  closedStateId: string | null;
  reportProblems: boolean;
  branchTemplate: string | null;
}

export async function readMappingParity(db: Db, mappingId: number | string): Promise<MappingParitySettings | null> {
  const r = (await db.query<any>(`SELECT open_state_id, closed_state_id, report_problems, branch_template FROM repo_mappings WHERE id = $1`, [mappingId])).rows[0];
  if (!r) return null;
  return {
    openStateId: r.open_state_id ?? null,
    closedStateId: r.closed_state_id ?? null,
    reportProblems: Boolean(r.report_problems),
    branchTemplate: r.branch_template ?? null,
  };
}

/** A branch template must contain {key} (N3); the database enforces the same rule. */
export function isValidBranchTemplate(template: string): boolean {
  return template.includes("{key}");
}

/** Updates the given fields; undefined keeps the stored value, null clears it. Returns false for an unknown mapping. */
export async function updateMappingParity(db: Db, mappingId: number | string, patch: Partial<MappingParitySettings>): Promise<boolean> {
  const columns: [keyof MappingParitySettings, string][] = [
    ["openStateId", "open_state_id"], ["closedStateId", "closed_state_id"],
    ["reportProblems", "report_problems"], ["branchTemplate", "branch_template"],
  ];
  const sets: string[] = [];
  const params: unknown[] = [mappingId];
  for (const [key, column] of columns) {
    if (patch[key] === undefined) continue;
    params.push(patch[key]);
    sets.push(`${column} = $${params.length}`);
  }
  if (sets.length === 0) return (await db.query(`SELECT 1 FROM repo_mappings WHERE id = $1`, [mappingId])).rows.length > 0;
  const res = await db.query(`UPDATE repo_mappings SET ${sets.join(", ")} WHERE id = $1 RETURNING 1`, params);
  return res.rows.length > 0;
}

// ---- instance setting: signed commits for Smart Commits (N6) ----------------------------------------------
/** The stored setting, or `envDefault` (REQUIRE_VERIFIED_COMMITS) when the admin never set it. */
export async function readRequireVerifiedCommits(db: Db, envDefault: boolean): Promise<boolean> {
  const r = (await db.query<{ require_verified_commits: boolean | null }>(`SELECT require_verified_commits FROM instance_settings WHERE id = 1`)).rows[0];
  const v = r?.require_verified_commits;
  return v === null || v === undefined ? envDefault : Boolean(v);
}

/** null returns control to the environment default. */
export async function writeRequireVerifiedCommits(db: Db, value: boolean | null): Promise<void> {
  await db.query(`
    INSERT INTO instance_settings (id, require_verified_commits) VALUES (1, $1)
    ON CONFLICT (id) DO UPDATE SET require_verified_commits = EXCLUDED.require_verified_commits
  `, [value]);
}
