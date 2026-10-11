// Spec §7.2, §9: attribution comes from the authenticated `sender` only. Git-supplied identity — commit
// author, committer, pusher — never acts as a user.
import test from "node:test";
import { strictEqual, ok, deepStrictEqual } from "node:assert/strict";
import { ghJob, makeHarness, sha } from "./harness.ts";

type H = Awaited<ReturnType<typeof makeHarness>>;
const commentCalls = (h: H) => h.plane.writes().filter((c) => /\/comments\/$/.test(c.path));

async function setup(over: Parameters<typeof makeHarness>[0] = {}) {
  const h = await makeHarness(over);
  await h.mapping();
  // "boss" is a mapped user with a stored PAT; the attacker only forges git metadata naming them.
  await h.db.query("INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id) VALUES ('ws', 'u-boss', 'boss', 500)");
  await h.ctx.vault.store("u-boss", "plane_pat", "boss-pat");
  return h;
}
const forged = {
  author: { name: "Boss", email: "boss@corp", username: "boss" },
  committer: { name: "Boss", email: "boss@corp", username: "boss" },
};
const pushBy = (sender: Record<string, unknown>, extra: Record<string, unknown> = {}, id = sha("a")) =>
  ghJob("push", { ref: "refs/heads/main", sender, commits: [{ id, message: "QLL-1 #comment attributed?", ...forged }], head_commit: { id, ...forged }, ...extra });

test("a forged --author naming a mapped user does not act as that user", async () => {
  const h = await setup();
  await h.feed(pushBy({ login: "stranger", id: 9, type: "User" }));
  const c = commentCalls(h);
  strictEqual(c.length, 1);
  strictEqual(c[0]!.key, "svc-pat");
  await h.close();
});

test("a forged pusher naming a mapped user does not act as that user", async () => {
  const h = await setup();
  await h.feed(pushBy({ login: "stranger", id: 9, type: "User" }, { pusher: { name: "boss", email: "boss@corp" } }));
  strictEqual(commentCalls(h)[0]!.key, "svc-pat");
  await h.close();
});

test("positive control: the real, mapped sender does act as themselves", async () => {
  const h = await setup();
  await h.feed(pushBy({ login: "boss", id: 500, type: "User" }));
  strictEqual(commentCalls(h)[0]!.key, "boss-pat");
  deepStrictEqual(await h.audit("identity_fallback"), []);
  await h.close();
});

test("the fallback to the service identity is audited with its reason", async () => {
  const h = await setup();
  await h.feed(pushBy({ login: "stranger", id: 9, type: "User" }));
  const [row] = await h.audit("identity_fallback");
  ok(row);
  strictEqual(row.detail.reason, "unmapped");
  strictEqual(row.detail.githubLogin, "stranger");
  await h.close();
});

test("a mapped sender with no stored token falls back to the service and says why", async () => {
  const h = await setup();
  await h.db.query("INSERT INTO user_map (workspace_slug, plane_user_id, gh_login, gh_id) VALUES ('ws', 'u-nokey', 'nokey', 501)");
  await h.feed(pushBy({ login: "nokey", id: 501, type: "User" }));
  strictEqual(commentCalls(h)[0]!.key, "svc-pat");
  strictEqual((await h.audit("identity_fallback"))[0]!.detail.reason, "no_stored_token");
  await h.close();
});

test("bots and the ghost user act as the service, even when a mapped login is forged into the commit", async () => {
  const h = await setup();
  await h.feed(pushBy({ login: "dependabot[bot]", id: 49, type: "Bot" }, {}, sha("1")));
  await h.feed(pushBy({ login: "ghost", id: 10137, type: "User" }, {}, sha("2")));
  deepStrictEqual(commentCalls(h).map((c) => c.key), ["svc-pat", "svc-pat"]);
  deepStrictEqual((await h.audit("identity_fallback")).map((r) => r.detail.reason), ["bot", "ghost"]);
  await h.close();
});

test("the provenance in the comment names the sender, not the forged author", async () => {
  const h = await setup();
  await h.feed(pushBy({ login: "stranger", id: 9, type: "User" }));
  const html = JSON.stringify(commentCalls(h)[0]!.body);
  ok(html.includes("stranger"));
  ok(!/boss/i.test(html), html);
  await h.close();
});

test("a sender with no login at all acts as the service", async () => {
  const h = await setup();
  await h.feed(pushBy({}));
  strictEqual(commentCalls(h)[0]!.key, "svc-pat");
  await h.close();
});

test("with signature verification required, an unverified commit is rejected and nothing is written", async () => {
  const h = await setup({ requireVerified: true });
  h.gh.respond(/GET \/repos\/\{owner\}\/\{repo\}\/commits\/\{ref\}$/, () => ({ commit: { verification: { verified: false } } }));
  await h.feed(pushBy({ login: "boss", id: 500, type: "User" }));
  strictEqual(commentCalls(h).length, 0);
  strictEqual((await h.audit("smart_commit_rejected")).length, 1);
  await h.close();
});

test("with signature verification required, a verified commit is honoured", async () => {
  const h = await setup({ requireVerified: true });
  h.gh.respond(/GET \/repos\/\{owner\}\/\{repo\}\/commits\/\{ref\}$/, () => ({ commit: { verification: { verified: true } } }));
  await h.feed(pushBy({ login: "boss", id: 500, type: "User" }));
  strictEqual(commentCalls(h).length, 1);
  await h.close();
});

test("a repository with Smart Commits switched off ignores the commands", async () => {
  const h = await makeHarness();
  await h.mapping({ smartCommits: false });
  await h.feed(pushBy({ login: "stranger", id: 9, type: "User" }));
  strictEqual(commentCalls(h).length, 0);
  await h.close();
});

test("a push for an unmapped repository acts on nothing and is audited", async () => {
  const h = await makeHarness();
  await h.feed(pushBy({ login: "stranger", id: 9, type: "User" }));
  strictEqual(h.plane.writes().length, 0);
  strictEqual((await h.audit("push"))[0]!.outcome, "unmapped_repo");
  await h.close();
});
