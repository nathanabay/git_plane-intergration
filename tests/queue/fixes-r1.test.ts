// Round-1 fixes F2, F5, F6, F9, F12 (implementer SA). Runs on PGlite and the A8 harness fakes.
import test from "node:test";
import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptSecret } from "../../src/auth/identity.ts";
import { createCredentialSource } from "../../src/app/credentials.ts";
import { ensureLinkedByEmail, resetEmailLinkAttempts } from "../../src/app/identity.ts";
import { mappingsForProject } from "../../src/app/mappings.ts";
import { queuedGithubWriter, queuedPlaneWriter, deliveryScope } from "../../src/app/writers.ts";
import { outboundBackoff } from "../../src/queue/workers.ts";
import { migrate } from "../../src/db/migrate.ts";
import { makeHarness, planeJob } from "../a8/harness.ts";

const issueUpdate = (workspace: string, assignees: string[]) =>
  planeJob("issue", { workspace_slug: workspace, action: "update", data: { id: "i1", project: "p-qll", assignees }, activity: { field: "assignees", actor: { id: "u-h" } } });

test("F2: a Plane delivery from another workspace cannot drive a mapping, and is audited", async () => {
  const h = await makeHarness();
  try {
    await h.mapping({ slug: "ws" });
    await h.link("i1", 7);
    await h.db.query("INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id) VALUES ('ws','pu-a','alice',5)");
    strictEqual((await mappingsForProject(h.db, "p-qll", "other")).length, 0);
    strictEqual((await mappingsForProject(h.db, "p-qll", "ws")).length, 1);
    await h.feed(issueUpdate("other", ["pu-a"]));
    deepStrictEqual(h.gh.writes(), []);
    strictEqual((await h.audit("issue"))[0]!.outcome, "workspace_mismatch");
  } finally { await h.close(); }
});

test("F5: assignee sync leaves GitHub assignees that have no user-map row alone", async () => {
  const h = await makeHarness();
  try {
    await h.mapping();
    await h.link("i1", 7);
    await h.db.query("INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id) VALUES ('ws','pu-a','alice',5), ('ws','pu-b','bob',6)");
    h.gh.respond(/GET \/repos\/\{owner\}\/\{repo\}\/issues\/\{issue_number\}$/, () => ({ assignees: [{ login: "alice" }, { login: "bob" }, { login: "stranger" }] }));
    await h.feed(issueUpdate("ws", ["pu-a"]));
    const removed = h.gh.writes().filter((c) => /assignees/.test(c.route) && /DELETE/.test(c.route)).flatMap((c) => c.params.assignees);
    deepStrictEqual(removed, ["bob"]);
  } finally { await h.close(); }
});

test("F5: emptying the mapped set removes mapped assignees only", async () => {
  const h = await makeHarness();
  try {
    await h.mapping();
    await h.link("i1", 7);
    await h.db.query("INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id) VALUES ('ws','pu-a','alice',5)");
    h.gh.respond(/GET \/repos\/\{owner\}\/\{repo\}\/issues\/\{issue_number\}$/, () => ({ assignees: [{ login: "alice" }, { login: "stranger" }] }));
    await h.feed(issueUpdate("ws", []));
    const removed = h.gh.writes().filter((c) => /DELETE/.test(c.route)).flatMap((c) => c.params.assignees);
    deepStrictEqual(removed, ["alice"]);
  } finally { await h.close(); }
});

test("F6: credentials saved in the admin UI win over the environment and changes are picked up", async () => {
  const db = new PGlite(); await db.waitReady; await migrate(db);
  const key = randomBytes(32);
  const keyFile = join(mkdtempSync(join(tmpdir(), "gh-key-")), "key.pem");
  writeFileSync(keyFile, "PEM-ENV");
  const config = { GITHUB_APP_ID: "1", GITHUB_PRIVATE_KEY_PATH: keyFile, GITHUB_WEBHOOK_SECRET: "env-secret" };
  try {
    const src = createCredentialSource(db, key, config, 0);
    strictEqual(await src.webhookSecret(), "env-secret"); // no row: environment fallback
    strictEqual((await src.load()).privateKey, "PEM-ENV");
    await db.query("INSERT INTO github_app_config (id, app_id, private_key_v1, webhook_secret_v1) VALUES (1, 42, $1, $2)", [encryptSecret("PEM-1", key), encryptSecret("db-secret", key)]);
    const first = await src.load();
    deepStrictEqual([first.source, first.appId, first.privateKey, first.webhookSecret], ["database", "42", "PEM-1", "db-secret"]);
    await db.query("UPDATE github_app_config SET webhook_secret_v1 = $1 WHERE id = 1", [encryptSecret("rotated", key)]);
    strictEqual(await src.webhookSecret(), "rotated");
  } finally { await db.close(); }
});

test("F9: reducers enqueue writes; results-needed writes stay inline and actor writes require outbox", async () => {
  const jobs = new Map<string, any>();
  const added: { name: string; data: any; opts: any }[] = [];
  const queue = {
    add: async (name: string, data: any, opts: any = {}) => {
      const id = opts.jobId ?? `job-${jobs.size}`;
      added.push({ name, data, opts });
      if (!jobs.has(id)) jobs.set(id, { id, data, getState: async () => "completed" });
      return jobs.get(id);
    },
    getJob: async (id: string) => jobs.get(id),
  } as any;
  const inlineCalls: string[] = [];
  const planeInline = { apply: async (w: any) => { inlineCalls.push(w.kind); return { ok: true as const }; }, preflight: async () => {} } as any;
  const ghInline = { apply: async (w: any) => { inlineCalls.push("gh:" + w.kind); return { ok: true as const, number: 3 }; } } as any;
  const plane = queuedPlaneWriter(planeInline, queue);
  const github = queuedGithubWriter(ghInline, queue);
  await deliveryScope.run({ deliveryId: "plane-d/1", seq: 0 }, async () => {
    await plane.apply({ kind: "add_comment" } as any);
    await github.apply({ kind: "comment" } as any);
    await plane.apply({ kind: "create_issue" } as any);
    await github.apply({ kind: "create_issue" } as any);
    await rejects(
      plane.apply({ kind: "add_comment" } as any, { actorToken: {} as any }),
      /actor writes require the ordered outbox/
    );
  });
  deepStrictEqual(added.map((a) => a.data.kind), ["add_comment", "comment"]);
  ok(added.length === 2 && added.every((a) => typeof a.opts.jobId === "string" && a.opts.jobId.startsWith("write-")));
  deepStrictEqual(inlineCalls, ["create_issue", "gh:create_issue"]);
});

test("F9: outbound backoff rides out hours, inbound stays short", () => {
  strictEqual(outboundBackoff(1), 5000);
  strictEqual(outboundBackoff(30), 10 * 60_000);
  let total = 0; for (let n = 1; n < 30; n++) total += outboundBackoff(n);
  ok(total > 3 * 3600_000);
});

async function emailHarness(profileEmail: string | null, members: { id: string; email: string }[]) {
  resetEmailLinkAttempts();
  const h = await makeHarness();
  const mappingId = await h.mapping();
  void mappingId;
  h.gh.respond(/GET \/users\/\{username\}$/, () => ({ id: 1, login: "octo", email: profileEmail }));
  (h.ctx.planeClient as any).listAll = async () => members.map((m) => ({ member: m }));
  const mapping = (await mappingsForProject(h.db, "p-qll", "ws"))[0]!;
  return { h, mapping };
}

test("F12: exactly one email match links the sender", async () => {
  const { h, mapping } = await emailHarness("octo@corp.io", [{ id: "pu-1", email: "OCTO@corp.io" }, { id: "pu-2", email: "x@corp.io" }]);
  try {
    strictEqual(await ensureLinkedByEmail(h.ctx, mapping, { login: "octo", id: 1, type: "User" }), "pu-1");
    strictEqual((await h.db.query<any>("SELECT plane_user_id FROM user_map WHERE gh_login = 'octo'")).rows[0].plane_user_id, "pu-1");
    strictEqual((await h.audit("identity_email_match"))[0]!.outcome, "linked");
  } finally { await h.close(); }
});

test("F12: zero or several matches fail loudly and link nobody", async () => {
  for (const [members, reason] of [[[{ id: "pu-2", email: "x@corp.io" }], "none"], [[{ id: "pu-1", email: "octo@corp.io" }, { id: "pu-2", email: "octo@corp.io" }], "multiple"]] as const) {
    const { h, mapping } = await emailHarness("octo@corp.io", [...members]);
    try {
      strictEqual(await ensureLinkedByEmail(h.ctx, mapping, { login: "octo", id: 1, type: "User" }), null);
      strictEqual((await h.db.query<any>("SELECT 1 FROM user_map")).rows.length, 0);
      const row = (await h.audit("identity_email_match"))[0]!;
      strictEqual(row.outcome, "failed");
      strictEqual(row.detail.reason, reason);
    } finally { await h.close(); }
  }
});

test("F12: a sender with no public email is audited, never guessed", async () => {
  const { h, mapping } = await emailHarness(null, [{ id: "pu-1", email: "octo@corp.io" }]);
  try {
    strictEqual(await ensureLinkedByEmail(h.ctx, mapping, { login: "octo", id: 1, type: "User" }), null);
    strictEqual((await h.audit("identity_email_match"))[0]!.detail.reason, "no_public_email");
  } finally { await h.close(); }
});
