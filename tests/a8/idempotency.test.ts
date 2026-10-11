// Spec §10: the same delivery twice is one effect; the same commit via two branches, or again after a
// rebase, is one effect.
import test from "node:test";
import { strictEqual, deepStrictEqual } from "node:assert/strict";
import { ghJob, makeHarness, prPayload, sha } from "./harness.ts";

const comments = (h: Awaited<ReturnType<typeof makeHarness>>) => h.plane.writes().filter((c) => c.method === "POST" && /\/comments\/$/.test(c.path));
const push = (ref: string, commits: { id: string; message: string }[], id?: string) => ghJob("push", { ref, commits, head_commit: commits[0] }, id);
const msg = "QLL-1 #comment shipped";

async function setup() { const h = await makeHarness(); await h.mapping(); return h; }

test("the same delivery id twice has one effect", async () => {
  const h = await setup();
  const job = push("refs/heads/main", [{ id: sha("a"), message: msg }], "same-delivery");
  strictEqual(await h.feed(job), "handled");
  strictEqual(await h.feed(job), "duplicate");
  strictEqual(comments(h).length, 1);
  await h.close();
});

test("the same SHA pushed to two branches (two deliveries) has one effect", async () => {
  const h = await setup();
  await h.feed(push("refs/heads/main", [{ id: sha("b"), message: msg }]));
  await h.feed(push("refs/heads/release", [{ id: sha("b"), message: msg }]));
  strictEqual(comments(h).length, 1);
  await h.close();
});

test("the same SHA again after a rebase or force-push has one effect", async () => {
  const h = await setup();
  await h.feed(push("refs/heads/feature", [{ id: sha("c"), message: msg }]));
  await h.feed(push("refs/heads/feature", [{ id: sha("c"), message: msg }, { id: sha("d"), message: "unrelated" }]));
  strictEqual(comments(h).length, 1);
  await h.close();
});

test("a rebased commit with a new SHA is a new commit and acts once", async () => {
  const h = await setup();
  await h.feed(push("refs/heads/feature", [{ id: sha("e"), message: msg }]));
  await h.feed(push("refs/heads/feature", [{ id: sha("f"), message: msg }]));
  strictEqual(comments(h).length, 2);
  await h.close();
});

test("a fork's push of the same SHA (another repository id) is still one effect", async () => {
  const h = await setup();
  await h.feed(push("refs/heads/main", [{ id: sha("1"), message: msg }]));
  const forked = ghJob("push", { ref: "refs/heads/main", repository: { id: 556, full_name: "fork/web", owner: { login: "fork" } }, commits: [{ id: sha("1"), message: msg }] });
  await h.feed(forked);
  strictEqual(comments(h).length, 1);
  await h.close();
});

test("two commands on two keys act once per key, and a redelivery adds nothing", async () => {
  const h = await setup();
  const job = push("refs/heads/main", [{ id: sha("2"), message: "QLL-1 QLL-2 #comment both" }], "two-keys");
  await h.feed(job);
  strictEqual(comments(h).length, 2);
  await h.feed({ ...job, deliveryId: "two-keys-again" });
  strictEqual(comments(h).length, 2);
  await h.close();
});

test("an opened PR delivered twice links and moves the item once", async () => {
  const h = await setup();
  const job = ghJob("pull_request", prPayload("opened", {}, { body: "Fixes QLL-1" }), "pr-1");
  await h.feed(job);
  await h.feed(job);
  strictEqual(h.plane.writes().filter((c) => c.method === "PATCH" && c.body?.state === "s-prog").length, 1);
  strictEqual((await h.db.query("SELECT 1 FROM sync_links WHERE gh_kind = 'pr'")).rows.length, 1);
  await h.close();
});

test("the same PR re-sent as a new delivery keeps a single sync link", async () => {
  const h = await setup();
  await h.feed(ghJob("pull_request", prPayload("opened", {}, { body: "Fixes QLL-1" })));
  await h.feed(ghJob("pull_request", prPayload("edited", {}, { body: "Fixes QLL-1" })));
  deepStrictEqual((await h.db.query<any>("SELECT tier FROM sync_links WHERE gh_kind = 'pr'")).rows.map((r) => r.tier), ["closing"]);
  await h.close();
});
