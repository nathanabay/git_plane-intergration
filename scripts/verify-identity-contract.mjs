#!/usr/bin/env node
// Oracle for task B9 (spec §9, §7.2). Driver-held checks of attribution, email matching and
// credential handling, independent of the leaf's own tests.
import { resolve, join } from "node:path";
import { inspect } from "node:util";
import { randomBytes } from "node:crypto";
import { deepStrictEqual, strictEqual, ok, throws, notStrictEqual } from "node:assert/strict";

const root = resolve(import.meta.dirname, "..");
const results = [];
async function check(name, fn, ms = 60000) {
  let timer;
  const limit = new Promise((_, no) => { timer = setTimeout(() => no(new Error(`timed out after ${ms}ms`)), ms); });
  try { await Promise.race([fn(), limit]); results.push([name, null]); console.log(`ok   ${name}`); }
  catch (e) { results.push([name, e]); console.error(`FAIL: ${name}: ${String(e?.message ?? e).split("\n")[0]}`); }
  finally { clearTimeout(timer); }
}

const id = await import(join(root, "src/auth/identity.ts"));
const key = randomBytes(32);
const users = { planeUserIdForGithubLogin: async (login) => ({ octo: "u-octo" })[login.toLowerCase()] ?? null };

await check("a mapped human sender resolves to that Plane user", async () => {
  deepStrictEqual(await id.resolveActor({ login: "Octo", id: 1, type: "User" }, users), { kind: "user", planeUserId: "u-octo", githubLogin: "Octo" });
});
await check("ghost, bots, apps and unmapped senders fall back to the service identity with a reason", async () => {
  deepStrictEqual(await id.resolveActor({ login: "ghost", id: 10137, type: "User" }, users), { kind: "service", reason: "ghost", githubLogin: "ghost" });
  deepStrictEqual(await id.resolveActor({ login: "dependabot[bot]", id: 2, type: "Bot" }, users), { kind: "service", reason: "bot", githubLogin: "dependabot[bot]" });
  deepStrictEqual(await id.resolveActor({ login: "renovate[bot]", id: 3, type: "User" }, users), { kind: "service", reason: "bot", githubLogin: "renovate[bot]" });
  deepStrictEqual(await id.resolveActor({ login: "stranger", id: 4, type: "User" }, users), { kind: "service", reason: "unmapped", githubLogin: "stranger" });
  deepStrictEqual(await id.resolveActor(null, users), { kind: "service", reason: "unmapped", githubLogin: null });
});
await check("a bot is never resolved to a user even if its login is in the user map", async () => {
  const leaky = { planeUserIdForGithubLogin: async () => "u-someone" };
  strictEqual((await id.resolveActor({ login: "ci[bot]", id: 5, type: "Bot" }, leaky)).kind, "service");
  strictEqual((await id.resolveActor({ login: "ghost", id: 10137, type: "User" }, leaky)).kind, "service");
});
await check("resolveActor takes only the sender: a forged pusher/author cannot reach it", () => {
  strictEqual(id.resolveActor.length <= 2, true);
});

const members = [
  { id: "u1", email: "Alice@Example.com" },
  { id: "u2", email: "bob@example.com" },
  { id: "u3", email: "BOB@example.com" },
  { id: "u4", email: null },
];
await check("email matching needs exactly one member, case-insensitive and trimmed", () => {
  deepStrictEqual(id.matchPlaneUserByEmail("  alice@example.COM ", members), { ok: true, planeUserId: "u1" });
  const multi = id.matchPlaneUserByEmail("bob@example.com", members);
  strictEqual(multi.ok, false); strictEqual(multi.reason, "multiple"); deepStrictEqual([...multi.candidates].sort(), ["u2", "u3"]);
  const none = id.matchPlaneUserByEmail("carol@example.com", members);
  strictEqual(none.ok, false); strictEqual(none.reason, "none"); deepStrictEqual(none.candidates, []);
  strictEqual(id.matchPlaneUserByEmail("", members).reason, "invalid_email");
  strictEqual(id.matchPlaneUserByEmail("not-an-email", members).reason, "invalid_email");
});

await check("AES-256-GCM secrets round-trip, are randomized, and never contain the plaintext", () => {
  const pt = "plane_api_0123456789abcdef";
  const a = id.encryptSecret(pt, key), b = id.encryptSecret(pt, key);
  ok(a.startsWith("v1:"), "blob must be versioned v1:");
  notStrictEqual(a, b);
  ok(!a.includes(pt) && !a.includes(Buffer.from(pt).toString("base64")));
  strictEqual(id.decryptSecret(a, key), pt);
});
await check("tampering, a wrong key, or a malformed blob fails closed", () => {
  const blob = id.encryptSecret("secret-token", key);
  const parts = blob.split(":");
  const last = parts[parts.length - 1];
  const flipped = (last[0] === "A" ? "B" : "A") + last.slice(1);
  throws(() => id.decryptSecret([...parts.slice(0, -1), flipped].join(":"), key));
  throws(() => id.decryptSecret(blob, randomBytes(32)));
  throws(() => id.decryptSecret("v2:" + blob.slice(3), key));
  throws(() => id.decryptSecret("garbage", key));
});
await check("a truncated GCM tag or a short IV is rejected, not accepted", () => {
  const blob = id.encryptSecret("secret-token", key);
  const [v, iv, tag, ct] = blob.split(":");
  const shortTag = Buffer.from(tag, "base64url").subarray(0, 4).toString("base64url");
  throws(() => id.decryptSecret([v, iv, shortTag, ct].join(":"), key), Error, "4-byte tag accepted");
  const shortIv = Buffer.from(iv, "base64url").subarray(0, 8).toString("base64url");
  throws(() => id.decryptSecret([v, shortIv, tag, ct].join(":"), key), Error, "8-byte IV accepted");
});
await check("a malformed sender (missing or non-string login) falls back to the service identity", async () => {
  strictEqual((await id.resolveActor({ id: 7, type: "User" }, users)).kind, "service");
  strictEqual((await id.resolveActor({ login: 42, id: 7, type: "User" }, users)).kind, "service");
  strictEqual((await id.resolveActor({ login: "GHOST", id: 10137, type: "User" }, users)).reason, "ghost");
});
await check("the token key must be strict base64", () => {
  throws(() => id.loadTokenKey({ GITSYNC_TOKEN_KEY: "!!" + key.toString("base64") }));
});
await check("the token key must be 32 bytes of base64 from GITSYNC_TOKEN_KEY", () => {
  strictEqual(id.loadTokenKey({ GITSYNC_TOKEN_KEY: key.toString("base64") }).length, 32);
  throws(() => id.loadTokenKey({ GITSYNC_TOKEN_KEY: randomBytes(31).toString("base64") }));
  throws(() => id.loadTokenKey({}));
});
await check("SecretString never reveals its value through string, JSON or inspect", () => {
  const s = new id.SecretString("hunter2-token");
  strictEqual(s.reveal(), "hunter2-token");
  for (const shown of [String(s), `${s}`, JSON.stringify({ s }), inspect(s), inspect({ nested: { s } }, { depth: 5 })]) {
    ok(!shown.includes("hunter2"), `leaked via: ${shown}`);
  }
});

function memStore() {
  const m = new Map(); const deleted = [];
  return {
    m, deleted,
    get: async (u, k) => m.get(`${u}|${k}`) ?? null,
    put: async (u, k, blob) => { m.set(`${u}|${k}`, blob); },
    delete: async (u) => { let any = false; for (const kk of [...m.keys()]) if (kk.startsWith(`${u}|`)) { m.delete(kk); any = true; } deleted.push(u); return any; },
  };
}
await check("TokenVault stores ciphertext only, loads a SecretString, and revocation invalidates it", async () => {
  const store = memStore();
  const vault = new id.TokenVault(store, key);
  await vault.store("u1", "plane_pat", "plane_api_SECRET1");
  await vault.store("u1", "github_oauth", "gho_SECRET2");
  for (const v of store.m.values()) ok(!v.includes("SECRET"), "store received plaintext");
  const t = await vault.load("u1", "plane_pat");
  ok(t instanceof id.SecretString); strictEqual(t.reveal(), "plane_api_SECRET1");
  strictEqual(await vault.revoke("u1"), true);
  strictEqual(await vault.load("u1", "plane_pat"), null);
  strictEqual(await vault.load("u1", "github_oauth"), null);
  strictEqual(await vault.revoke("u1"), false);
});

await check("service credentials load from env and errors name variables without echoing values", () => {
  const creds = id.loadServiceCredentials({ PLANE_SERVICE_PAT: "plane_api_SERVICE" });
  ok(creds.planePat instanceof id.SecretString); strictEqual(creds.planePat.reveal(), "plane_api_SERVICE");
  let msg = "";
  try { id.loadServiceCredentials({ PLANE_SERVICE_PAT: "   ", UNRELATED: "decoy-value-xyz" }); } catch (e) { msg = String(e.message); }
  ok(msg.includes("PLANE_SERVICE_PAT"), "error must name the missing variable");
  ok(!msg.includes("decoy-value-xyz"));
});
await check("the service account must not be a workspace admin (Plane role 20)", () => {
  strictEqual(id.assessServiceAccountRole(15).ok, true);
  strictEqual(id.assessServiceAccountRole(5).ok, true);
  const admin = id.assessServiceAccountRole(20);
  strictEqual(admin.ok, false); ok(typeof admin.warning === "string" && admin.warning.length > 0);
});

let bad = 0;
for (const [, err] of results) if (err) bad++;
if (bad) process.exit(1);
console.log(`identity contract verification passed (${results.length} checks)`);
process.exit(0); // lingering client sockets must not keep a passed oracle alive