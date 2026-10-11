import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { inspect } from "node:util";

export interface GithubSender { login: string; id: number; type: string }
export type ActorResolution =
  | { kind: "user"; planeUserId: string; githubLogin: string }
  | { kind: "service"; reason: "ghost" | "bot" | "unmapped"; githubLogin: string | null };
export interface UserMapLookup { planeUserIdForGithubLogin(login: string): Promise<string | null> }

export async function resolveActor(sender: GithubSender | null | undefined, users: UserMapLookup): Promise<ActorResolution> {
  // Spec §7.2, §9: Attribution from sender only.
  if (!sender || typeof sender.login !== "string" || sender.login.trim() === "") {
    return { kind: "service", reason: "unmapped", githubLogin: sender?.login || null };
  }
  const lowerLogin = sender.login.toLowerCase();
  if (lowerLogin === "ghost" || sender.id === 10137) {
    return { kind: "service", reason: "ghost", githubLogin: sender.login };
  }
  if (sender.type === "Bot" || lowerLogin.endsWith("[bot]")) {
    return { kind: "service", reason: "bot", githubLogin: sender.login };
  }
  const mapped = await users.planeUserIdForGithubLogin(sender.login);
  if (mapped) {
    return { kind: "user", planeUserId: mapped, githubLogin: sender.login };
  }
  return { kind: "service", reason: "unmapped", githubLogin: sender.login };
}

export interface PlaneMemberLite { id: string; email: string | null }
export type EmailMatch =
  | { ok: true; planeUserId: string }
  | { ok: false; reason: "none" | "multiple" | "invalid_email"; candidates: string[] };

export function matchPlaneUserByEmail(email: string, members: PlaneMemberLite[]): EmailMatch {
  // Spec §9: exactly one match, case-insensitive, trimmed
  const trimmed = email.trim().toLowerCase();
  if (!trimmed || !trimmed.includes("@")) { // basic valid email check
    return { ok: false, reason: "invalid_email", candidates: [] };
  }
  const matched = members.filter(m => m.email && m.email.trim().toLowerCase() === trimmed);
  if (matched.length === 0) {
    return { ok: false, reason: "none", candidates: [] };
  }
  if (matched.length > 1) {
    return { ok: false, reason: "multiple", candidates: matched.map(m => m.id) };
  }
  const first = matched[0];
  if (!first) throw new Error("Unreachable");
  return { ok: true, planeUserId: first.id };
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  // Spec §9: PATs are full-privilege, encrypt at rest
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ct.toString("base64url")}`;
}

export function decryptSecret(blob: string, key: Buffer): string {
  if (!blob.startsWith("v1:")) {
    throw new Error("Invalid blob version");
  }
  const parts = blob.split(":");
  if (parts.length !== 4) {
    throw new Error("Malformed blob");
  }
  const ivStr = parts[1];
  const tagStr = parts[2];
  const ctStr = parts[3];
  if (ivStr === undefined || tagStr === undefined || ctStr === undefined) {
    throw new Error("Malformed blob");
  }
  const iv = Buffer.from(ivStr, "base64url");
  const tag = Buffer.from(tagStr, "base64url");
  const ct = Buffer.from(ctStr, "base64url");
  
  if (iv.length !== 12) {
    throw new Error("Invalid IV length");
  }
  if (tag.length !== 16) {
    throw new Error("Invalid authentication tag length");
  }
  
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

export function loadTokenKey(env: Record<string, string | undefined>): Buffer {
  const b64 = env.GITSYNC_TOKEN_KEY;
  if (!b64) throw new Error("Missing GITSYNC_TOKEN_KEY");
  const buf = Buffer.from(b64, "base64");
  if (buf.toString("base64") !== b64) {
    throw new Error("GITSYNC_TOKEN_KEY must be strict base64");
  }
  if (buf.length !== 32) {
    throw new Error("GITSYNC_TOKEN_KEY must be 32 bytes");
  }
  return buf;
}

export class SecretString {
  #value: string;
  /** The Plane user whose stored token this is, when loaded from the vault. Lets a queued write persist the owner id (never the plaintext) and reload the current token at execution time. */
  readonly planeUserId?: string;
  constructor(value: string, planeUserId?: string) {
    this.#value = value;
    if (planeUserId !== undefined) this.planeUserId = planeUserId;
  }
  reveal(): string {
    return this.#value;
  }
  toString() {
    return "[redacted]";
  }
  toJSON() {
    return "[redacted]";
  }
  [inspect.custom]() {
    return "[redacted]";
  }
}

export type TokenKind = "plane_pat" | "github_oauth";
export interface TokenStore {
  get(planeUserId: string, kind: TokenKind): Promise<string | null>;
  put(planeUserId: string, kind: TokenKind, blob: string): Promise<void>;
  delete(planeUserId: string): Promise<boolean>;
}

export class TokenVault {
  #store: TokenStore;
  #key: Buffer;
  
  constructor(store: TokenStore, key: Buffer) {
    this.#store = store;
    this.#key = key;
  }
  async store(planeUserId: string, kind: TokenKind, token: string): Promise<void> {
    const ciphertext = encryptSecret(token, this.#key);
    await this.#store.put(planeUserId, kind, ciphertext);
  }
  async load(planeUserId: string, kind: TokenKind): Promise<SecretString | null> {
    const ciphertext = await this.#store.get(planeUserId, kind);
    if (!ciphertext) return null;
    return new SecretString(decryptSecret(ciphertext, this.#key), planeUserId);
  }
  async revoke(planeUserId: string): Promise<boolean> {
    return await this.#store.delete(planeUserId);
  }
}

export function loadServiceCredentials(env: Record<string, string | undefined>): { planePat: SecretString } {
  const pat = env.PLANE_SERVICE_PAT;
  if (!pat || pat.trim() === "") {
    throw new Error("Missing variable PLANE_SERVICE_PAT");
  }
  return { planePat: new SecretString(pat) };
}

export function assessServiceAccountRole(role: number): { ok: boolean; warning?: string } {
  // Spec §9: A compromised admin token hands over full admin access.
  if (role >= 20) {
    return { ok: false, warning: "Service account must not be an admin (role 20) to maintain least privilege." };
  }
  return { ok: true };
}
