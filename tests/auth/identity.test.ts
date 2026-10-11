import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import {
  resolveActor,
  matchPlaneUserByEmail,
  encryptSecret,
  decryptSecret,
  loadTokenKey,
  SecretString,
  TokenVault,
  loadServiceCredentials,
  assessServiceAccountRole
} from "../../src/auth/identity.ts";

test("resolveActor", async () => {
  const users = {
    planeUserIdForGithubLogin: async (login: string) => {
      if (login === "octo") return "u-octo";
      return null;
    }
  };
  
  assert.deepStrictEqual(
    await resolveActor({ login: "octo", id: 1, type: "User" }, users),
    { kind: "user", planeUserId: "u-octo", githubLogin: "octo" }
  );
  
  assert.deepStrictEqual(
    await resolveActor(null, users),
    { kind: "service", reason: "unmapped", githubLogin: null }
  );
});

test("matchPlaneUserByEmail", () => {
  const members = [
    { id: "u1", email: "Test@Example.com" },
    { id: "u2", email: "other@example.com" },
    { id: "u3", email: null }
  ];
  
  assert.deepStrictEqual(
    matchPlaneUserByEmail(" test@EXAMPLE.com ", members),
    { ok: true, planeUserId: "u1" }
  );
  assert.deepStrictEqual(
    matchPlaneUserByEmail("none@example.com", members),
    { ok: false, reason: "none", candidates: [] }
  );
  
  const multiMembers = [...members, { id: "u4", email: "test@example.com" }];
  assert.deepStrictEqual(
    matchPlaneUserByEmail("test@example.com", multiMembers).ok,
    false
  );
});

test("encryptSecret and decryptSecret IV uniqueness", () => {
  const key = randomBytes(32);
  const p1 = "secret";
  const p2 = "secret";
  const e1 = encryptSecret(p1, key);
  const e2 = encryptSecret(p2, key);
  assert.notStrictEqual(e1, e2);
  
  assert.strictEqual(decryptSecret(e1, key), p1);
  assert.strictEqual(decryptSecret(e2, key), p2);
});

test("encryptSecret tamper positions", () => {
  const key = randomBytes(32);
  const e1 = encryptSecret("secret", key);
  const parts = e1.split(":");
  
  const flipBit = (b64url: string | undefined) => {
    if (!b64url) return "";
    const buf = Buffer.from(b64url, "base64url");
    if (buf.length > 0) {
      buf.writeUInt8(buf.readUInt8(0) ^ 0x01, 0);
    }
    return buf.toString("base64url");
  };
  
  const badIv = [...parts];
  badIv[1] = flipBit(badIv[1]);
  assert.throws(() => decryptSecret(badIv.join(":"), key));
  
  const badTag = [...parts];
  badTag[2] = flipBit(badTag[2]);
  assert.throws(() => decryptSecret(badTag.join(":"), key));
  
  const badCt = [...parts];
  badCt[3] = flipBit(badCt[3]);
  assert.throws(() => decryptSecret(badCt.join(":"), key));
});

test("SecretString with JSON.stringify and util.inspect", () => {
  const secret = new SecretString("secret-value-123");
  assert.strictEqual(JSON.stringify(secret), '"[redacted]"');
  assert.strictEqual(inspect(secret), "[redacted]");
  assert.strictEqual(String(secret), "[redacted]");
});

test("TokenVault handles empty store and deletion gracefully", async () => {
  const key = randomBytes(32);
  const store = {
    get: async () => null,
    put: async () => {},
    delete: async () => false
  };
  const vault = new TokenVault(store, key);
  
  assert.strictEqual(await vault.load("user1", "plane_pat"), null);
  assert.strictEqual(await vault.revoke("user1"), false);
});

test("unicode secrets", () => {
  const key = randomBytes(32);
  const secret = "hello 🌍 and secrets!";
  const ct = encryptSecret(secret, key);
  assert.strictEqual(decryptSecret(ct, key), secret);
});

test("loadTokenKey", () => {
  const valid = randomBytes(32).toString("base64");
  const key = loadTokenKey({ GITSYNC_TOKEN_KEY: valid });
  assert.strictEqual(key.length, 32);
});

test("SecretString formatting", () => {
  const secret = new SecretString("hunter2");
  assert.strictEqual(secret.reveal(), "hunter2");
  assert.strictEqual(String(secret), "[redacted]");
  assert.strictEqual(JSON.stringify(secret), '"[redacted]"');
  assert.strictEqual(inspect(secret), "[redacted]");
  
  // Inspect at depth
  const nested = { a: { b: { c: secret } } };
  assert.strictEqual(inspect(nested, { depth: 5 }).includes("hunter2"), false);
});

test("TokenVault and revocation idempotence", async () => {
  const key = randomBytes(32);
  const m = new Map<string, string>();
  const store = {
    get: async (u: string, k: string) => m.get(`${u}|${k}`) ?? null,
    put: async (u: string, k: string, blob: string) => {
      // Store receives no plaintext
      assert.strictEqual(blob.includes("super-secret-pat"), false);
      m.set(`${u}|${k}`, blob);
    },
    delete: async (u: string) => {
      let any = false;
      for (const [k] of m.entries()) {
        if (k.startsWith(`${u}|`)) {
          m.delete(k);
          any = true;
        }
      }
      return any;
    }
  };
  
  const vault = new TokenVault(store, key);
  await vault.store("user1", "plane_pat", "super-secret-pat");
  const loaded = await vault.load("user1", "plane_pat");
  assert.strictEqual(loaded?.reveal(), "super-secret-pat");
  
  assert.strictEqual(await vault.revoke("user1"), true);
  // Idempotence
  assert.strictEqual(await vault.revoke("user1"), false);
  
  assert.strictEqual(await vault.load("user1", "plane_pat"), null);
});

test("loadServiceCredentials", () => {
  const creds = loadServiceCredentials({ PLANE_SERVICE_PAT: "test-pat" });
  assert.strictEqual(creds.planePat.reveal(), "test-pat");
  assert.throws(() => loadServiceCredentials({}), /PLANE_SERVICE_PAT/);
});

test("assessServiceAccountRole", () => {
  assert.strictEqual(assessServiceAccountRole(15).ok, true);
  assert.strictEqual(assessServiceAccountRole(20).ok, false);
  assert.strictEqual(assessServiceAccountRole(25).ok, false);
});

test("resolveActor malformed senders and ghost", async () => {
  const users = {
    planeUserIdForGithubLogin: async (login: string) => null
  };
  
  // Malformed sender with missing login
  assert.deepStrictEqual(
    await resolveActor({ id: 1, type: "User" } as any, users),
    { kind: "service", reason: "unmapped", githubLogin: null }
  );
  
  // Ghost by id
  assert.deepStrictEqual(
    await resolveActor({ login: "deleted_user", id: 10137, type: "User" }, users),
    { kind: "service", reason: "ghost", githubLogin: "deleted_user" }
  );
});

test("strict base64 for token key", () => {
  const valid = randomBytes(32).toString("base64");
  assert.strictEqual(loadTokenKey({ GITSYNC_TOKEN_KEY: valid }).length, 32);
  
  // Garbage character
  assert.throws(() => loadTokenKey({ GITSYNC_TOKEN_KEY: valid.slice(0, -1) + "-" }), /strict base64/);
});

test("crypto rejects short IV or Tag", () => {
  const key = randomBytes(32);
  const secret = encryptSecret("secret", key);
  const parts = secret.split(":");
  
  const shortIvParts = [...parts];
  shortIvParts[1] = "AAAA"; // 3 bytes decoded
  assert.throws(() => decryptSecret(shortIvParts.join(":"), key), /Invalid IV length/);
  
  const shortTagParts = [...parts];
  shortTagParts[2] = "AAAA"; // 3 bytes decoded
  assert.throws(() => decryptSecret(shortTagParts.join(":"), key), /Invalid authentication tag length/);
});

test("TokenVault.load tags the token with its owner; the tag is not the secret and stays redacted", async () => {
  const key = randomBytes(32);
  const rows = new Map<string, string>();
  const store = {
    get: async (u: string, k: string) => rows.get(`${u}:${k}`) ?? null,
    put: async (u: string, k: string, b: string) => { rows.set(`${u}:${k}`, b); },
    delete: async () => false,
  };
  const vault = new TokenVault(store, key);
  await vault.store("u-7", "plane_pat", "plane_api_SECRET");
  const t = (await vault.load("u-7", "plane_pat"))!;
  assert.strictEqual(t.planeUserId, "u-7");
  assert.strictEqual(t.reveal(), "plane_api_SECRET");
  assert.ok(!JSON.stringify(t).includes("SECRET") && !inspect(t).includes("SECRET"));
  assert.strictEqual(new SecretString("x").planeUserId, undefined);
});
