import test from "node:test";
import { strictEqual, deepStrictEqual, ok, rejects } from "node:assert/strict";
import { buildStatus, categorisedTitle, detectPreviews, prRollupKey, prRollupTitle, prStatus, reviewStatus, upsertRollupLink } from "../../src/sync/dev-info.ts";
import { PlaneApiError } from "../../src/sync/plane.ts";
import { getDevInfoLink } from "../../src/db/ledgers.ts";
import { fakePlaneWriter, freshDb } from "../github/fakes.ts";

test("pr status: OPEN, MERGED, DECLINED", () => {
  strictEqual(prStatus({ state: "open", merged: false }), "OPEN");
  strictEqual(prStatus({ state: "OPEN", merged: false }), "OPEN");
  strictEqual(prStatus({ state: "closed", merged: true }), "MERGED");
  strictEqual(prStatus({ state: "closed", merged: false }), "DECLINED");
});

test("review status: REVIEW until a decision, REJECTED beats APPROVAL, only the latest per reviewer counts", () => {
  strictEqual(reviewStatus([]), "REVIEW");
  strictEqual(reviewStatus([{ state: "COMMENTED" }]), "REVIEW");
  strictEqual(reviewStatus([{ state: "APPROVED", user: { login: "a" } }]), "APPROVAL");
  strictEqual(reviewStatus([{ state: "APPROVED", user: { login: "a" } }, { state: "CHANGES_REQUESTED", user: { login: "b" } }]), "REJECTED");
  strictEqual(reviewStatus([{ state: "CHANGES_REQUESTED", user: { login: "a" } }, { state: "APPROVED", user: { login: "a" } }]), "APPROVAL");
  strictEqual(reviewStatus([{ state: "APPROVED", user: { login: "a" } }, { state: "DISMISSED", user: { login: "a" } }]), "REVIEW");
});

test("rollup title: [PR] prefix, review part only while open", () => {
  strictEqual(prRollupTitle({ number: 12, title: "Add x", state: "open", merged: false, reviews: [{ state: "APPROVED" }] }), "[PR] #12 Add x · OPEN · APPROVAL");
  strictEqual(prRollupTitle({ number: 12, title: "Add x", state: "closed", merged: true, reviews: [{ state: "APPROVED" }] }), "[PR] #12 Add x · MERGED");
  strictEqual(prRollupTitle({ number: 12, title: "Add x", state: "closed", merged: false }), "[PR] #12 Add x · DECLINED");
});

test("build status: pass, fail, pending", () => {
  strictEqual(buildStatus([{ conclusion: "success" }, { conclusion: "skipped" }, { conclusion: "neutral" }]), "pass");
  strictEqual(buildStatus([{ conclusion: "success" }, { conclusion: "timed_out" }]), "fail");
  strictEqual(buildStatus([{ conclusion: "success" }, { conclusion: null }]), "pending");
  strictEqual(buildStatus([{ conclusion: "failure" }, { conclusion: null }]), "fail");
  strictEqual(buildStatus([]), "pending");
});

test("previews: providers match on a real domain suffix, not a substring", () => {
  const p = detectPreviews({ environmentUrls: ["https://a.vercel.app", "https://evilvercel.app", "https://a.vercel.app.evil.example", "javascript:alert(1)", "https://x.pages.dev/"] });
  deepStrictEqual(p, [{ name: "Vercel", url: "https://a.vercel.app" }, { name: "Cloudflare Pages", url: "https://x.pages.dev/" }]);
});

test("previews: markdown links ending in Preview, deduplicated against deployments", () => {
  const body = "[Storybook Preview](https://sb.example.com) [docs](https://d.example.com) [Bad Preview](javascript:alert(1)) [Dup Preview](https://a.netlify.app)";
  const p = detectPreviews({ environmentUrls: ["https://a.netlify.app"], body });
  deepStrictEqual(p.map((x) => x.url), ["https://a.netlify.app", "https://sb.example.com"]);
  strictEqual(p[1]!.name, "Storybook Preview");
});

test("previews: nothing in, nothing out", () => {
  deepStrictEqual(detectPreviews({}), []);
});

test("categorised titles: reserved prefix, no injection of extra brackets or newlines", () => {
  strictEqual(categorisedTitle("CI", "Build #42"), "[CI] Build #42");
  strictEqual(categorisedTitle("Deploy]x[", "production\nnow"), "[Deployx] production now");
  strictEqual(prRollupKey(555, 12), "pr:555:12");
});

const target = { slug: "qelal", projectId: "p", issueId: "i-1" };

test("rollup: first add_link stores the id, later calls update in place", async () => {
  const db = await freshDb();
  const w = fakePlaneWriter();
  const a = await upsertRollupLink({ db, writer: w }, target, "pr:1:2", { title: "[PR] #2 T · OPEN", url: "https://gh/pr/2" });
  const b = await upsertRollupLink({ db, writer: w }, target, "pr:1:2", { title: "[PR] #2 T · MERGED", url: "https://gh/pr/2" });
  deepStrictEqual([a.action, b.action], ["added", "updated"]);
  deepStrictEqual(w.writes.map((x) => x.kind), ["add_link", "update_link"]);
  strictEqual((w.writes[1] as any).linkId, "link-1");
  strictEqual(await getDevInfoLink(db, "i-1", "pr:1:2"), "link-1");
});

test("rollup: different keys and different issues each get their own link", async () => {
  const db = await freshDb();
  const w = fakePlaneWriter();
  await upsertRollupLink({ db, writer: w }, target, "pr:1:2", { title: "a", url: "https://u/1" });
  await upsertRollupLink({ db, writer: w }, target, "build:1:2", { title: "b", url: "https://u/2" });
  await upsertRollupLink({ db, writer: w }, { ...target, issueId: "i-2" }, "pr:1:2", { title: "a", url: "https://u/1" });
  deepStrictEqual(w.writes.map((x) => x.kind), ["add_link", "add_link", "add_link"]);
});

test("rollup: a link deleted in Plane (404 on update) comes back as a new link with a new id", async () => {
  const db = await freshDb();
  const base = fakePlaneWriter();
  await upsertRollupLink({ db, writer: base }, target, "k", { title: "a", url: "https://u/1" });
  const w = fakePlaneWriter({ failOn: (x) => (x.kind === "update_link" ? new PlaneApiError(404, null, "gone") : null) });
  const r = await upsertRollupLink({ db, writer: w }, target, "k", { title: "b", url: "https://u/1" });
  strictEqual(r.action, "added");
  strictEqual(await getDevInfoLink(db, "i-1", "k"), r.linkId);
});

test("rollup: other update errors propagate", async () => {
  const db = await freshDb();
  await upsertRollupLink({ db, writer: fakePlaneWriter() }, target, "k", { title: "a", url: "https://u/1" });
  const w = fakePlaneWriter({ failOn: (x) => (x.kind === "update_link" ? new PlaneApiError(500, null, "boom") : null) });
  await rejects(upsertRollupLink({ db, writer: w }, target, "k", { title: "b", url: "https://u/1" }), /boom/);
});

test("rollup: a duplicate URL we hold no id for is recovered through findLinkId, else reported", async () => {
  const db = await freshDb();
  const dup = { apply: async (x: any) => (x.kind === "add_link" ? { ok: true as const, duplicate: true } : { ok: true as const, id: x.linkId }) };
  const none = await upsertRollupLink({ db, writer: dup }, target, "k", { title: "a", url: "https://u/1" });
  strictEqual(none.action, "unchanged-duplicate");
  strictEqual(await getDevInfoLink(db, "i-1", "k"), null);
  const found = await upsertRollupLink({ db, writer: dup, findLinkId: async () => "link-77" }, target, "k", { title: "a", url: "https://u/1" });
  deepStrictEqual([found.action, found.linkId], ["updated", "link-77"]);
  strictEqual(await getDevInfoLink(db, "i-1", "k"), "link-77");
  ok(true);
});
