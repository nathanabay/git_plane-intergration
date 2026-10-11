// GitHub App credentials (F6). The instance-admin UI stores them encrypted in `github_app_config`; that row is
// authoritative when it exists, and the environment is the bootstrap fallback. Both the App client and the
// webhook verifier read through here, so a rotated key or secret takes effect within a few seconds without a restart.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decryptSecret } from "../auth/identity.ts";
import type { Config } from "../config/env.ts";
import type { Db } from "../db/migrate.ts";
import { credentialRowEverSeen, markCredentialRowSeen } from "../db/ledgers.ts";

export interface GithubCredentials {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  baseUrl?: string;
  source: "database" | "environment";
}

const DEFAULT_CACHE_MS = 5000;

export interface CredentialSource {
  load(): Promise<GithubCredentials>;
  webhookSecret(): Promise<string>;
  /** Which source the App credentials come from right now, and whether a stored row decrypts (F15). */
  describe(): Promise<{ source: "database" | "environment"; decryptOk: boolean }>;
}

export function createCredentialSource(db: Db, tokenKey: Buffer, config: Pick<Config, "GITHUB_APP_ID" | "GITHUB_PRIVATE_KEY_PATH" | "GITHUB_WEBHOOK_SECRET" | "GITHUB_API_BASE_URL">, cacheMs = DEFAULT_CACHE_MS, markerPath: string = join(dirname(config.GITHUB_PRIVATE_KEY_PATH), ".gitsync-db-credentials")): CredentialSource {
  let cached: { at: number; value: GithubCredentials } | undefined;

  const fromEnvironment = async (): Promise<GithubCredentials> => ({
    appId: config.GITHUB_APP_ID,
    privateKey: await readFile(config.GITHUB_PRIVATE_KEY_PATH, "utf8"),
    webhookSecret: config.GITHUB_WEBHOOK_SECRET,
    ...(config.GITHUB_API_BASE_URL ? { baseUrl: config.GITHUB_API_BASE_URL } : {}),
    source: "environment",
  });

  // Once a database row has been read the environment is never consulted again: a secret rotated because it
  // leaked must not be accepted again during a database outage, after a cache miss, or after a restart (prev F15).
  // "Seen" is durable in three places: this process, the `github_credential_state` row, and a marker file beside the
  // key path, which survives a restart while the database is down (the one moment the first two cannot be read).
  let sawRow = false;
  let lastRow: GithubCredentials | undefined;
  const markerOnDisk = () => { try { return existsSync(markerPath); } catch { return false; } };
  const remember = () => {
    if (sawRow) return;
    sawRow = true;
    void markCredentialRowSeen(db).catch(() => undefined);
    try { mkdirSync(dirname(markerPath), { recursive: true }); writeFileSync(markerPath, `${new Date().toISOString()}\n`); } catch { /* read-only mount: the database marker still holds */ }
  };

  const read = async (): Promise<GithubCredentials> => {
    let row: any;
    try {
      row = (await db.query("SELECT app_id, private_key_v1, webhook_secret_v1, ghe_base_url FROM github_app_config WHERE id = 1")).rows[0];
    } catch (err) {
      // The database being down must not stop webhook verification: keep what was last known.
      if (lastRow) return lastRow;
      if (cached) return cached.value;
      if (sawRow || markerOnDisk()) throw err;
      return fromEnvironment(); // cold start, no row ever seen: the environment is the only credential there is
    }
    if (!row) {
      if (sawRow || markerOnDisk() || await credentialRowEverSeen(db).catch(() => false)) throw new Error("github_app_config row is gone; refusing the environment fallback");
      return fromEnvironment();
    }
    remember();
    // A cleared stored URL means github.com when a row exists; the environment URL is not a fallback here.
    lastRow = {
      appId: String(row.app_id),
      privateKey: decryptSecret(row.private_key_v1, tokenKey),
      webhookSecret: decryptSecret(row.webhook_secret_v1, tokenKey),
      ...(row.ghe_base_url ? { baseUrl: String(row.ghe_base_url) } : {}),
      source: "database",
    };
    return lastRow;
  };

  const load = async (): Promise<GithubCredentials> => {
    if (cached && Date.now() - cached.at < cacheMs) return cached.value;
    const value = await read();
    cached = { at: Date.now(), value };
    return value;
  };
  const describe = async (): Promise<{ source: "database" | "environment"; decryptOk: boolean }> => {
    try {
      return { source: (await load()).source, decryptOk: true };
    } catch {
      return { source: sawRow || markerOnDisk() ? "database" : "environment", decryptOk: false };
    }
  };
  return { load, webhookSecret: async () => (await load()).webhookSecret, describe };
}
