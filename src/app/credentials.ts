// GitHub App credentials (F6). The instance-admin UI stores them encrypted in `github_app_config`; that row is
// authoritative when it exists, and the environment is the bootstrap fallback. Both the App client and the
// webhook verifier read through here, so a rotated key or secret takes effect within a few seconds without a restart.
import { closeSync, fsyncSync, mkdirSync, openSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { decryptSecret } from "../auth/identity.ts";
import type { Config } from "../config/env.ts";
import { DEFAULT_CREDENTIAL_MARKER_PATH } from "../config/env.ts";
import type { Db } from "../db/migrate.ts";
import { credentialRowEverSeen, markCredentialRowSeen } from "../db/ledgers.ts";
import { readGithubAppClient } from "../db/parity.ts";
import type { GithubAppClientConfig } from "../db/parity.ts";
import { deriveGithubHosts } from "../github/hosts.ts";
import type { GithubHosts } from "../github/hosts.ts";

export interface GithubCredentials {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  baseUrl?: string;
  /** Resolved from the same credential authority, never from bootstrap over a stored row. */
  hosts?: GithubHosts;
  source: "database" | "environment";
}

const DEFAULT_CACHE_MS = 5000;

export interface CredentialSource {
  load(): Promise<GithubCredentials>;
  webhookSecret(): Promise<string>;
  /** Which source the App credentials come from right now, and whether a stored row decrypts (F15). */
  describe(): Promise<{ source: "database" | "environment"; decryptOk: boolean; configured?: false }>;
}

/** No App is stored and none is bootstrapped from the environment: the instance admin has not added one yet. */
export class GithubAppNotConfiguredError extends Error {
  constructor() { super("No GitHub App is configured yet: add it in the instance admin (God mode) under Git Sync"); this.name = "GithubAppNotConfiguredError"; }
}

export function githubBootstrapConfigured(config: Pick<Config, "GITHUB_APP_ID" | "GITHUB_PRIVATE_KEY_PATH" | "GITHUB_WEBHOOK_SECRET">): boolean {
  return Boolean(config.GITHUB_APP_ID && config.GITHUB_PRIVATE_KEY_PATH && config.GITHUB_WEBHOOK_SECRET);
}

export type GithubBootstrapConfig = Pick<Config, "GITHUB_APP_ID" | "GITHUB_PRIVATE_KEY_PATH" | "GITHUB_WEBHOOK_SECRET" | "GITHUB_API_BASE_URL" | "GITHUB_CREDENTIAL_MARKER_PATH" | "GITHUB_EDITION" | "GITHUB_GHE_SUBDOMAIN" | "GITHUB_GHES_BASE_URL">;

/** Stored ghe_base_url historically contains an API base; the approved edition resolves its meaning. */
export function hostsFromAppConfig(client: GithubAppClientConfig): GithubHosts {
  return deriveGithubHosts({ edition: client.edition, gheSubdomain: client.gheSubdomain,
    ...(client.edition === "ghes" ? { gheBaseUrl: client.gheBaseUrl } : { apiBaseUrl: client.gheBaseUrl }) });
}

export function hostsFromBootstrap(config: Pick<Config, "GITHUB_API_BASE_URL" | "GITHUB_EDITION" | "GITHUB_GHE_SUBDOMAIN" | "GITHUB_GHES_BASE_URL">): GithubHosts {
  return deriveGithubHosts({ edition: config.GITHUB_EDITION, gheSubdomain: config.GITHUB_GHE_SUBDOMAIN,
    gheBaseUrl: config.GITHUB_GHES_BASE_URL, apiBaseUrl: config.GITHUB_API_BASE_URL });
}

export function createCredentialSource(db: Db, tokenKey: Buffer, config: GithubBootstrapConfig, cacheMs = DEFAULT_CACHE_MS, markerPath: string = config.GITHUB_CREDENTIAL_MARKER_PATH ?? DEFAULT_CREDENTIAL_MARKER_PATH): CredentialSource {
  let cached: { at: number; value: GithubCredentials } | undefined;

  const fromEnvironment = async (): Promise<GithubCredentials> => {
    if (!githubBootstrapConfigured(config)) throw new GithubAppNotConfiguredError();
    const hosts = hostsFromBootstrap(config);
    return { appId: config.GITHUB_APP_ID, privateKey: await readFile(config.GITHUB_PRIVATE_KEY_PATH, "utf8"),
      webhookSecret: config.GITHUB_WEBHOOK_SECRET, hosts,
      ...(hosts.edition !== "github" || config.GITHUB_API_BASE_URL ? { baseUrl: hosts.apiBaseUrl } : {}), source: "environment" };
  };

  // Once a database row has been read the environment is never consulted again: a secret rotated because it
  // leaked must not be accepted again during a database outage, after a cache miss, or after a restart (prev F15).
  // The local marker belongs on writable persistent storage, never beside the read-only secret.
  // A missing marker cannot prove an instance has never retired bootstrap credentials: a save
  // can precede the first load, and storage can be lost. Cold database outages always fail closed.
  let sawRow = false;
  let lastRow: GithubCredentials | undefined;
  let persistedMarker = false;
  const markerOnDisk = () => {
    try { statSync(markerPath); return true; }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return false; throw err; }
  };
  const remember = async () => {
    sawRow = true;
    if (persistedMarker) return;
    await markCredentialRowSeen(db);
    mkdirSync(dirname(markerPath), { recursive: true });
    const file = openSync(markerPath, "a", 0o600);
    try { writeFileSync(file, `${new Date().toISOString()}\n`); fsyncSync(file); }
    finally { closeSync(file); }
    const directory = openSync(dirname(markerPath), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
    persistedMarker = true;
  };

  const read = async (): Promise<GithubCredentials> => {
    let row: any;
    let client: GithubAppClientConfig | null = null;
    try {
      row = (await db.query("SELECT app_id, private_key_v1, webhook_secret_v1 FROM github_app_config WHERE id = 1")).rows[0];
      if (row) client = await readGithubAppClient(db);
    } catch (err) {
      // Only successfully loaded database credentials can be retained during an outage.
      if (lastRow) return lastRow;
      throw err;
    }
    if (!row) {
      if (sawRow || markerOnDisk() || await credentialRowEverSeen(db)) throw new Error("github_app_config row is gone; refusing the environment fallback");
      return fromEnvironment();
    }
    await remember();
    if (!client) throw new Error("GitHub App configuration changed during credential loading");
    const hosts = hostsFromAppConfig(client);
    // Stored edition/host is authoritative; environment host variables cannot override it.
    lastRow = {
      appId: String(row.app_id),
      privateKey: decryptSecret(row.private_key_v1, tokenKey),
      webhookSecret: decryptSecret(row.webhook_secret_v1, tokenKey),
      hosts,
      ...(hosts.edition !== "github" ? { baseUrl: hosts.apiBaseUrl } : {}),
      source: "database",
    };
    return lastRow;
  };

  const load = async (): Promise<GithubCredentials> => {
    // Environment credentials require a healthy retirement-authority check on every load.
    if (cached?.value.source === "database" && Date.now() - cached.at < cacheMs) return cached.value;
    const value = await read();
    cached = { at: Date.now(), value };
    return value;
  };
  const describe = async (): Promise<{ source: "database" | "environment"; decryptOk: boolean; configured?: false }> => {
    try {
      return { source: (await load()).source, decryptOk: true };
    } catch (err) {
      if (err instanceof GithubAppNotConfiguredError) return { source: "environment", decryptOk: false, configured: false };
      let retired = sawRow;
      try { retired ||= markerOnDisk(); } catch { retired = true; }
      return { source: retired ? "database" : "environment", decryptOk: false };
    }
  };
  return { load, webhookSecret: async () => (await load()).webhookSecret, describe };
}
