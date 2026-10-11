import test from "node:test";
import { strictEqual, deepStrictEqual, ok, throws } from "node:assert/strict";
import { SecretString } from "../../src/auth/identity.ts";
import { MAX_RANGE_COMMITS, PUSH_PAYLOAD_COMMIT_LIMIT, SmartCommitLockTimeout, SmartCommitRetry, durationToMinutes, parseSmartCommits, processPush, resolveTransition } from "../../src/github/smart-commits.ts";
import type { SmartCommitDeps } from "../../src/github/smart-commits.ts";
import { PlaneApiError } from "../../src/sync/plane.ts";
import { QLL, fakePlaneWriter, freshDb } from "./fakes.ts";
import { deliveryScope } from "../../src/app/writers.ts";
import { rejects } from "node:assert/strict";

test("grammar: the three §7.2 command forms", () => {
  deepStrictEqual(parseSmartCommits("WEB-34 #comment corrected indent issue"), [{ keys: ["WEB-34"], comment: "corrected indent issue", transitions: [] }]);
  deepStrictEqual(parseSmartCommits("WEB-90 #done #comment fixed today"), [{ keys: ["WEB-90"], transitions: ["done"], comment: "fixed today" }]);
  const t = parseSmartCommits("WEB-34 #time 1w 2d 4h 30m logged")[0]!;
  deepStrictEqual(t.time, { raw: "1w 2d 4h 30m", minutes: 3630 });
});

test("grammar: a comment runs to the end of the line, so # inside it is text", () => {
  const [c] = parseSmartCommits("WEB-1 #comment see #123 and #done later");
  deepStrictEqual(c, { keys: ["WEB-1"], comment: "see #123 and #done later", transitions: [] });
});

test("grammar: a key quoted inside a comment is not a target", () => {
  const [c] = parseSmartCommits("WEB-1 #comment blocked by WEB-2");
  deepStrictEqual(c!.keys, ["WEB-1"]);
});

test("grammar: a command never spans lines; each line needs its own key", () => {
  deepStrictEqual(parseSmartCommits("WEB-1 #done\n#comment no key here"), [{ keys: ["WEB-1"], transitions: ["done"] }]);
  deepStrictEqual(parseSmartCommits("WEB-1 is related\n#done"), []);
  deepStrictEqual(parseSmartCommits("#done WEB-1"), []);
});

test("grammar: keys come out in the order written, lowercase prose is not a key", () => {
  deepStrictEqual(parseSmartCommits("see step-2 and WEB-9 and API-2 #done")[0]!.keys, ["WEB-9", "API-2"]);
});

test("grammar: issue numbers like #123 are not commands", () => {
  deepStrictEqual(parseSmartCommits("WEB-1 closes #123"), []);
});

test("grammar: an unparseable #time is reported, not guessed", () => {
  const [c] = parseSmartCommits("WEB-1 #time soon #done");
  deepStrictEqual(c!.transitions, ["done"]);
  ok(c!.time === undefined && c!.errors?.[0]?.includes("#time"));
});

test("grammar: repeated #time on a line adds up", () => {
  deepStrictEqual(parseSmartCommits("WEB-1 #time 1h #time 30m")[0]!.time, { raw: "1h 30m", minutes: 90 });
});

test("duration: Jira defaults, decimals and garbage", () => {
  strictEqual(durationToMinutes("1w"), 2400);
  strictEqual(durationToMinutes("1d"), 480);
  strictEqual(durationToMinutes("1.5h"), 90);
  strictEqual(durationToMinutes("2d 5h"), 1260);
  strictEqual(durationToMinutes("45M"), 45);
  for (const bad of ["", "soon", "5", "1x", "1h banana", "-1h"]) throws(() => durationToMinutes(bad), bad);
});

test("transition: exact hyphenated name beats a prefix; prefixes and ambiguity", () => {
  const states = [{ id: "a", name: "In", group: "started" }, { id: "b", name: "In Review", group: "started" }, { id: "c", name: "In Progress", group: "started" }];
  deepStrictEqual(resolveTransition(states, "in"), { ok: true, stateId: "a" });
  deepStrictEqual(resolveTransition(states, "in-review"), { ok: true, stateId: "b" });
  deepStrictEqual(resolveTransition(QLL, "in"), { ok: false, reason: "ambiguous" });
  deepStrictEqual(resolveTransition(QLL, "prog"), { ok: false, reason: "not_found" });
  deepStrictEqual(resolveTransition(QLL, "in-prog"), { ok: false, reason: "not_found" });
  deepStrictEqual(resolveTransition(QLL, "IN-PROGRESS"), { ok: true, stateId: "s-prog" });
  deepStrictEqual(resolveTransition(QLL, "todo"), { ok: true, stateId: "s-todo" });
  deepStrictEqual(resolveTransition(QLL, ""), { ok: false, reason: "not_found" });
});

const push = (sha: string, message: string, sender: unknown, extra: object = {}) => ({
  ref: "refs/heads/main", repository: { id: 555, full_name: "acme/web" }, sender,
  pusher: { name: "victim", email: "v@x.y" },
  commits: [{ id: sha, message, author: { name: "Victim", username: "victim" }, committer: { name: "Victim" } }], ...extra,
});

async function setup(over: Partial<SmartCommitDeps> = {}) {
  const db = await freshDb();
  const writer = fakePlaneWriter();
  const tokens: Record<string, string> = { "u-octo": "plane_api_OCTO", "u-nopat-user": "" };
  const deps: SmartCommitDeps = {
    db, writer,
    users: { planeUserIdForGithubLogin: async (l) => ({ octo: "u-octo", nopat: "u-nopat" })[l.toLowerCase()] ?? null },
    vault: { load: async (id) => (tokens[id] ? new SecretString(tokens[id]!) : null) },
    requireVerified: false,
    mapping: { workspaceSlug: "qelal", smartCommitsEnabled: true },
    listStates: async () => QLL,
    resolveIssue: async (key) => (key === "WEB-404" ? null : { projectId: "p-qll", issueId: `iss-${key}` }),
    getCommitVerified: async () => true,
    ...over,
  };
  return { db, writer, deps };
}
const OCTO = { login: "octo", id: 1, type: "User" };
const sha = (c: string) => c.repeat(40);

test("push: a mapped sender with a stored PAT writes as themselves", async () => {
  const { writer, deps } = await setup();
  await processPush(push(sha("a"), "WEB-1 #comment hi", OCTO), deps);
  strictEqual(writer.writes.length, 1);
  strictEqual(writer.writes[0]!.token, "plane_api_OCTO");
});

test("push: pusher and commit author never choose the actor", async () => {
  const { writer, db, deps } = await setup();
  await processPush(push(sha("b"), "WEB-1 #comment forged", { login: "attacker", id: 9, type: "User" }, { pusher: { name: "octo" } }), deps);
  ok(writer.writes.every((w) => w.token === "SERVICE"));
  const audit = (await db.query<{ kind: string; detail: any }>(`SELECT kind, detail FROM audit_log WHERE kind = 'identity_fallback'`)).rows;
  strictEqual(audit.length, 1);
  strictEqual(audit[0]!.detail.reason, "unmapped");
});

test("push: ghost, bot and a mapped user without a stored token all fall back loudly", async () => {
  const cases: [unknown, string][] = [
    [{ login: "ghost", id: 10137, type: "User" }, "ghost"],
    [{ login: "renovate[bot]", id: 3, type: "Bot" }, "bot"],
    [{ login: "nopat", id: 4, type: "User" }, "no_stored_token"],
  ];
  for (const [sender, reason] of cases) {
    const { writer, db, deps } = await setup();
    await processPush(push(sha("c"), "WEB-1 #comment x", sender), deps);
    ok(writer.writes.length >= 1 && writer.writes.every((w) => w.token === "SERVICE"), reason);
    const row = (await db.query<{ detail: any }>(`SELECT detail FROM audit_log WHERE kind = 'identity_fallback'`)).rows[0];
    strictEqual(row?.detail.reason, reason);
  }
});

test("push: a missing sender acts as the service", async () => {
  const { writer, deps } = await setup();
  await processPush(push(sha("d"), "WEB-1 #comment x", undefined), deps);
  strictEqual(writer.writes[0]!.token, "SERVICE");
});

test("push: each SHA acts once, across pushes, branches and forks", async () => {
  const { writer, deps } = await setup();
  const p = push(sha("e"), "WEB-1 #comment once", OCTO);
  await processPush(p, deps);
  await processPush({ ...p, ref: "refs/heads/other", repository: { id: 7, full_name: "fork/web" } }, deps);
  strictEqual(writer.writes.length, 1);
});

test("push: a commit without commands is not claimed", async () => {
  const { db, deps } = await setup();
  await processPush(push(sha("f"), "just a message WEB-1", OCTO), deps);
  strictEqual((await db.query(`SELECT 1 FROM processed_commits`)).rows.length, 0);
});

test("push: transition, #time and #comment all land on every key, in that order", async () => {
  const { writer, deps } = await setup();
  await processPush(push(sha("1"), "WEB-1 WEB-2 #in-review #time 2h #comment shipped", OCTO), deps);
  deepStrictEqual(writer.writes.map((w) => [w.kind, (w as any).issueId]),
    [["update_issue", "iss-WEB-1"], ["add_comment", "iss-WEB-1"], ["add_comment", "iss-WEB-1"],
      ["update_issue", "iss-WEB-2"], ["add_comment", "iss-WEB-2"], ["add_comment", "iss-WEB-2"]]);
  const time = writer.writes.find((w) => w.kind === "add_comment") as any;
  ok(/Time logged: 2h \(120 minutes\)/.test(time.commentHtml));
});

test("push: comment text and login are HTML-escaped", async () => {
  const { writer, deps } = await setup();
  await processPush(push(sha("2"), "WEB-1 #comment <img src=x onerror=alert(1)>", OCTO), deps);
  const html = (writer.writes[0] as any).commentHtml as string;
  ok(!html.includes("<img") && html.includes("&lt;img"));
});

test("push: a missing or ambiguous transition fails loudly and the other commands still run", async () => {
  const { writer, db, deps } = await setup();
  await processPush(push(sha("3"), "WEB-1 #deployed #in #comment still here", OCTO), deps);
  ok(writer.writes.some((w) => w.kind === "add_comment" && /still here/.test((w as any).commentHtml)));
  const errors = (await db.query<{ error: string }>(`SELECT error FROM audit_log WHERE kind = 'smart_commit_failed'`)).rows.map((r) => r.error);
  ok(errors.some((e) => /#deployed.*no state/.test(e)), errors.join("|"));
  ok(errors.some((e) => /#in.*several states/.test(e)), errors.join("|"));
  strictEqual((await db.query<{ outcome: string }>(`SELECT outcome FROM audit_log WHERE kind = 'smart_commit'`)).rows[0]!.outcome, "partial");
});

test("push: an unknown work item is a failure for that key only", async () => {
  const { writer, db, deps } = await setup();
  await processPush(push(sha("4"), "WEB-404 WEB-1 #comment x", OCTO), deps);
  strictEqual(writer.writes.length, 1);
  ok((await db.query(`SELECT 1 FROM audit_log WHERE error ILIKE '%WEB-404%'`)).rows.length >= 1);
});

test("push: A4's triage ban surfaces as an audit failure, not a crash", async () => {
  const { writer, db, deps } = await setup();
  await processPush(push(sha("5"), "WEB-1 #triage #comment after", OCTO), deps);
  ok(writer.writes.some((w) => w.kind === "add_comment"));
  ok((await db.query(`SELECT 1 FROM audit_log WHERE error ILIKE '%triage%'`)).rows.length >= 1);
});

test("push: the per-repo toggle off does nothing and claims nothing", async () => {
  const { writer, db, deps } = await setup({ mapping: { workspaceSlug: "qelal", smartCommitsEnabled: false } });
  await processPush(push(sha("7"), "WEB-1 #comment x", OCTO), deps);
  strictEqual(writer.writes.length, 0);
  strictEqual((await db.query(`SELECT 1 FROM processed_commits`)).rows.length, 0);
});

test("push: requireVerified ignores unsigned commits, records why, and allows signed ones", async () => {
  const { writer, db, deps } = await setup({ requireVerified: true, getCommitVerified: async (s) => s.startsWith("9") });
  await processPush(push(sha("8"), "WEB-1 #comment unsigned", OCTO), deps);
  strictEqual(writer.writes.length, 0);
  ok((await db.query(`SELECT 1 FROM audit_log WHERE kind = 'smart_commit_rejected'`)).rows.length === 1);
  await processPush(push(sha("9"), "WEB-1 #comment signed", OCTO), deps);
  strictEqual(writer.writes.length, 1);
});

test("push: malformed payloads and bad SHAs are ignored", async () => {
  const { writer, deps } = await setup();
  await processPush({}, deps);
  await processPush({ repository: { id: 1 }, commits: [{ id: "nothex!", message: "WEB-1 #done" }] }, deps);
  strictEqual(writer.writes.length, 0);
});

test("push: the audit trail carries the workspace so the workspace audit view can show it", async () => {
  const { db, deps } = await setup();
  await processPush(push("a1".repeat(20), "WEB-1 #comment x", OCTO), deps);
  const row = (await db.query<{ workspace_slug: string }>(`SELECT workspace_slug FROM audit_log WHERE kind = 'smart_commit'`)).rows[0];
  strictEqual(row?.workspace_slug, "qelal");
});

// ---- F8: transient failures are retried without redoing what already happened ------------------------
const flaky = (failures: { n: number }, error: Error) => fakePlaneWriter({ failOn: (w) => (w.kind === "add_comment" && failures.n-- > 0 ? error : null) });

test("F8: a transient failure leaves the commit unclaimed, rethrows, and the retry applies only what is missing", async () => {
  const { db, deps } = await setup();
  const failures = { n: 1 };
  const writer = flaky(failures, new PlaneApiError(503, null, "Plane 503"));
  const p = push(sha("a"), "WEB-1 WEB-2 #in-review #comment shipped", OCTO);
  await rejects(processPush(p, { ...deps, writer }), SmartCommitRetry);
  // WEB-1's transition and WEB-2's transition and comment are done; WEB-1's comment is pending.
  strictEqual(writer.writes.filter((w) => w.kind === "update_issue").length, 2);
  strictEqual((await db.query(`SELECT 1 FROM processed_commits`)).rows.length, 0, "an unfinished commit must not be claimed");
  const summary = await processPush(p, { ...deps, writer });
  deepStrictEqual(writer.writes.map((w) => [w.kind, (w as any).issueId]),
    [["update_issue", "iss-WEB-1"], ["update_issue", "iss-WEB-2"], ["add_comment", "iss-WEB-2"], ["add_comment", "iss-WEB-1"]]);
  strictEqual(summary.retry, 0);
  strictEqual((await db.query(`SELECT 1 FROM processed_commits WHERE workspace_slug = 'qelal'`)).rows.length, 1);
  await processPush(p, { ...deps, writer });
  strictEqual(writer.writes.length, 4, "a finished commit is never redone");
});

test("F8: network errors, 429 and 5xx are retried; other 4xx and the triage ban are final and audited once", async () => {
  for (const [error, retried] of [[new Error("Plane POST failed: fetch failed"), true], [new PlaneApiError(429, null, "slow down"), true],
    [new PlaneApiError(500, null, "boom"), true], [new PlaneApiError(400, null, "bad"), false], [new PlaneApiError(404, null, "gone"), false]] as const) {
    const { db, deps } = await setup();
    const writer = flaky({ n: 99 }, error);
    const p = push(sha("b"), "WEB-1 #comment x", OCTO);
    if (retried) await rejects(processPush(p, { ...deps, writer }), SmartCommitRetry, error.message);
    else {
      const out = await processPush(p, { ...deps, writer });
      strictEqual(out.failed, 1);
      await processPush(p, { ...deps, writer });
      strictEqual((await db.query(`SELECT 1 FROM audit_log WHERE kind = 'smart_commit_failed'`)).rows.length, 1, "a final failure is audited once, not per retry");
    }
  }
});

test("F8: a retry audits the transient failure but records no finished step for it", async () => {
  const { db, deps } = await setup();
  const writer = flaky({ n: 1 }, new PlaneApiError(502, null, "bad gateway"));
  await rejects(processPush(push(sha("c"), "WEB-1 #comment x", OCTO), { ...deps, writer }), SmartCommitRetry);
  strictEqual((await db.query(`SELECT 1 FROM audit_log WHERE kind = 'smart_commit_retry'`)).rows.length, 1);
  strictEqual((await db.query(`SELECT 1 FROM audit_log WHERE kind = 'smart_commit_step'`)).rows.length, 0);
});

test("F8: a failing key lookup is retried; an unknown key is final", async () => {
  const { deps } = await setup({ resolveIssue: async () => { throw new PlaneApiError(503, null, "down"); } });
  await rejects(processPush(push(sha("d"), "WEB-1 #done", OCTO), deps), SmartCommitRetry);
});

test("F8: a failing signature lookup is retried and the commit is not consumed", async () => {
  const { writer, db, deps } = await setup({ requireVerified: true, getCommitVerified: async () => { throw new Error("GitHub 502"); } });
  await rejects(processPush(push(sha("e"), "WEB-1 #comment x", OCTO), deps), SmartCommitRetry);
  strictEqual(writer.writes.length, 0);
  strictEqual((await db.query(`SELECT 1 FROM processed_commits`)).rows.length, 0);
});

test("F8: a crash mid-commit loses nothing: the next delivery resumes after the steps already recorded", async () => {
  const { db, deps } = await setup();
  let calls = 0;
  const crashing = fakePlaneWriter({ failOn: () => { if (++calls === 2) throw new Error("process died"); return null; } });
  const p = push(sha("f"), "WEB-1 #in-review #comment hi", OCTO);
  await rejects(processPush(p, { ...deps, writer: crashing }), SmartCommitRetry);
  const writer = fakePlaneWriter();
  await processPush(p, { ...deps, writer });
  deepStrictEqual(writer.writes.map((w) => w.kind), ["add_comment"], "the finished transition must not be applied twice");
  ok(db);
});

test("F8: concurrent deliveries of one SHA still act once", async () => {
  const { writer, deps } = await setup();
  const p = push(sha("1"), "WEB-1 #comment once", OCTO);
  await Promise.all([processPush(p, deps), processPush({ ...p, ref: "refs/heads/b" }, deps)]);
  strictEqual(writer.writes.length, 1);
});

// ---- F16: one effect per workspace --------------------------------------------------------------------
test("F16: the same SHA acts once in each workspace and once only within a workspace", async () => {
  const { db, deps } = await setup();
  const w2 = fakePlaneWriter();
  const p = push(sha("2"), "WEB-1 #comment x", OCTO);
  await processPush(p, deps);
  await processPush(p, { ...deps, writer: w2, mapping: { workspaceSlug: "other", smartCommitsEnabled: true } });
  strictEqual(w2.writes.length, 1, "the second workspace must act too");
  await processPush({ ...p, repository: { id: 9, full_name: "fork/web" } }, { ...deps, writer: w2, mapping: { workspaceSlug: "other", smartCommitsEnabled: true } });
  strictEqual(w2.writes.length, 1);
  const claims = (await db.query<{ workspace_slug: string }>(`SELECT workspace_slug FROM processed_commits ORDER BY workspace_slug`)).rows.map((r) => r.workspace_slug);
  deepStrictEqual(claims, ["other", "qelal"]);
});

test("F16: a pre-F16 global claim still counts as done", async () => {
  const { writer, db, deps } = await setup();
  await db.query(`INSERT INTO processed_commits (sha, repo_id, workspace_slug) VALUES ($1, 555, '')`, [sha("3")]);
  await processPush(push(sha("3"), "WEB-1 #comment x", OCTO), deps);
  strictEqual(writer.writes.length, 0);
});

// ---- F18: pushes with more than 20 commits ------------------------------------------------------------
const bigPush = () => {
  const commits = Array.from({ length: PUSH_PAYLOAD_COMMIT_LIMIT }, (_, i) => ({ id: (i + 1).toString(16).padStart(40, "0"), message: `plain ${i}` }));
  return { ...push(sha("a"), "", OCTO), before: "b".repeat(40), after: "c".repeat(40), commits };
};
const hexId = (i: number) => (i + 1).toString(16).padStart(40, "0");

test("F18: a full 20-commit payload is completed from the compare range, in order, without duplicates", async () => {
  const { writer, deps } = await setup();
  const p = bigPush();
  const ranges: string[] = [];
  const all = Array.from({ length: 23 }, (_, i) => ({ id: hexId(i), message: i === 22 ? "WEB-9 #comment the 23rd" : i === 3 ? "WEB-8 #comment the 4th" : `plain ${i}` }));
  await processPush(p, { ...deps, listCommitRange: async (b, a) => { ranges.push(`${b.slice(0, 1)}...${a.slice(0, 1)}`); return all; } });
  deepStrictEqual(ranges, ["b...c"]);
  deepStrictEqual(writer.writes.map((w) => (w as any).issueId), ["iss-WEB-8", "iss-WEB-9"]);
});

test("F18: fewer than 20 commits never calls the compare API", async () => {
  const { writer, deps } = await setup();
  await processPush({ ...push(sha("a"), "WEB-1 #comment x", OCTO), before: "b".repeat(40), after: "c".repeat(40) }, { ...deps, listCommitRange: async () => { throw new Error("must not be called"); } });
  strictEqual(writer.writes.length, 1);
});

test("F18: without a lookup, or for a new branch, the truncation is audited instead of silent", async () => {
  const { db, deps } = await setup();
  await processPush(bigPush(), deps);
  await processPush({ ...bigPush(), before: "0".repeat(40) }, { ...deps, listCommitRange: async () => { throw new Error("must not be called"); } });
  const rows = (await db.query<{ detail: any }>(`SELECT detail FROM audit_log WHERE kind = 'smart_commit_truncated'`)).rows;
  strictEqual(rows.length, 2);
});

test("F18: a failing compare lookup fails the delivery so it is retried", async () => {
  const { deps } = await setup();
  await rejects(processPush(bigPush(), { ...deps, listCommitRange: async () => { throw new Error("GitHub 502"); } }), /GitHub 502/);
});

test("r2 F14: malformed range entries are dropped, duplicates collapse, and an empty range keeps the payload's commits", async () => {
  const { writer, deps } = await setup();
  const p = { ...bigPush(), commits: bigPush().commits.map((c, i) => (i === 0 ? { ...c, message: "WEB-1 #comment from payload" } : c)) };
  await processPush(p, { ...deps, listCommitRange: async () => [null, { id: 5 }, { id: hexId(30), message: "WEB-2 #comment from range" }, { id: hexId(30), message: "dup" }] as any });
  deepStrictEqual(writer.writes.map((w) => (w as any).issueId), ["iss-WEB-2", "iss-WEB-1"]);
  const w2 = await setup();
  await processPush(p, { ...w2.deps, listCommitRange: async () => [] });
  strictEqual(w2.writer.writes.length, 1, "an empty range must not lose the listed commits");
});

test("r2 F14: a range larger than the cap is cut and audited", async () => {
  const { db, deps } = await setup();
  const big = Array.from({ length: MAX_RANGE_COMMITS + 5 }, (_, i) => ({ id: hexId(i), message: `plain ${i}` }));
  await processPush(bigPush(), { ...deps, listCommitRange: async () => big });
  const rows = (await db.query<{ detail: any }>(`SELECT detail FROM audit_log WHERE kind = 'smart_commit_truncated'`)).rows;
  strictEqual(rows.length, 1);
  ok(String(rows[0]!.detail.reason).includes(String(MAX_RANGE_COMMITS)));
});

test("r2 F16: a delivery stuck inside the lock cannot stall the next one forever; the waiter fails retriably and the lock is reusable", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const stuck = await setup();
  const hung = { ...stuck.deps, writer: { apply: async (w: any, o: any) => { await gate; return stuck.writer.apply(w, o); } } };
  const p = push(sha("1"), "WEB-1 #comment held", OCTO);
  const first = processPush(p, hung);
  await new Promise((r) => setTimeout(r, 300)); // let the first delivery take the lock and block in the writer
  const t0 = Date.now();
  await rejects(() => processPush({ ...p, ref: "refs/heads/b" }, { ...stuck.deps, lockTimeoutMs: 200 }), (e) => e instanceof SmartCommitLockTimeout && e instanceof SmartCommitRetry);
  ok(Date.now() - t0 < 3000, "bounded wait");
  release();
  await first;
  strictEqual(stuck.writer.writes.length, 1);
  // a timed-out waiter must not poison the queue: a later delivery of another commit proceeds
  await processPush(push(sha("2"), "WEB-1 #comment after", OCTO), { ...stuck.deps, lockTimeoutMs: 200 });
  strictEqual(stuck.writer.writes.length, 2);
});

test("r3 F12: the webhook limit is 2048; a refused compare keeps the payload's commits with an audit, outages still retry", async () => {
  strictEqual(PUSH_PAYLOAD_COMMIT_LIMIT, 2048);
  for (const status of [404, 422]) {
    const { db, writer, deps } = await setup();
    const p = { ...bigPush(), commits: bigPush().commits.map((c, i) => (i === 0 ? { ...c, message: "WEB-1 #comment kept" } : c)) };
    await processPush(p, { ...deps, listCommitRange: async () => { throw Object.assign(new Error("refused"), { status }); } });
    strictEqual(writer.writes.length, 1, `status ${status}: the listed commit's command still runs`);
    const rows = (await db.query<{ detail: any }>(`SELECT detail FROM audit_log WHERE kind = 'smart_commit_truncated'`)).rows;
    strictEqual(rows.length, 1);
    ok(String(rows[0]!.detail.reason).includes(String(status)));
  }
  for (const err of [Object.assign(new Error("boom"), { status: 502 }), Object.assign(new Error("slow"), { status: 429 }), new Error("ECONNRESET")]) {
    const { deps } = await setup();
    await rejects(processPush(bigPush(), { ...deps, listCommitRange: async () => { throw err; } }), (e) => e === err);
  }
  const { deps } = await setup();
  const nineteenHundred = { ...bigPush(), commits: bigPush().commits.slice(0, 1999) };
  await processPush(nineteenHundred, { ...deps, listCommitRange: async () => { throw new Error("must not be called below the limit"); } });
});

test("r3 F16: after a waiter times out, a later delivery still queues behind the holder that is still running", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const s = await setup();
  let running = 0, peak = 0;
  const slow = { ...s.deps, writer: { apply: async (w: any, o: any) => { running++; peak = Math.max(peak, running); await gate; running--; return s.writer.apply(w, o); } } };
  const watched = { ...s.deps, writer: { apply: async (w: any, o: any) => { running++; peak = Math.max(peak, running); running--; return s.writer.apply(w, o); } } };
  const p = push(sha("9"), "WEB-1 #comment x", OCTO);
  const holder = processPush(p, slow);
  await new Promise((r) => setTimeout(r, 300));
  await rejects(processPush({ ...p, ref: "refs/heads/b" }, { ...watched, lockTimeoutMs: 150 }), (e) => e instanceof SmartCommitLockTimeout);
  // the timed-out waiter was the last link; the retried delivery must not start while the holder runs
  const retry = processPush({ ...p, ref: "refs/heads/c" }, { ...watched, lockTimeoutMs: 5000 });
  await new Promise((r) => setTimeout(r, 300));
  strictEqual(running, 1, "only the holder is inside the lock");
  release();
  await Promise.all([holder, retry]);
  strictEqual(peak, 1, "never two holders at once");
  strictEqual(s.writer.writes.length, 1, "the command was applied once");
});

test("r3 F1: every Smart Commit write runs under its step id; a partial retry re-issues only the unfinished step under the same id", async () => {
  const { deps } = await setup();
  const seen: Array<{ kind: string; issueId: string; operationId: string | undefined; deliveryId: string | undefined }> = [];
  const failures = { n: 1 };
  const inner = flaky(failures, new PlaneApiError(503, null, "Plane 503"));
  const writer = { writes: inner.writes, apply: (w: any, o: any) => {
    const store = deliveryScope.getStore();
    seen.push({ kind: w.kind, issueId: w.issueId, operationId: store?.operationId, deliveryId: store?.deliveryId });
    return inner.apply(w, o);
  } };
  // two commands on different keys with the identical comment text: identical writes except for the target, plus a repeated key
  const p = push(sha("e"), "WEB-1 WEB-2 #comment same", OCTO);
  await rejects(processPush(p, { ...deps, writer }), SmartCommitRetry);
  await processPush(p, { ...deps, writer });
  const id = (key: string) => `sc:${sha("e")}:0:${key}:comment`;
  // attempt 1: WEB-1's comment fails (503) and WEB-2's succeeds; attempt 2 re-issues only WEB-1's
  deepStrictEqual(seen.map((x) => [x.issueId, x.operationId]), [["iss-WEB-1", id("WEB-1")], ["iss-WEB-2", id("WEB-2")], ["iss-WEB-1", id("WEB-1")]]);
  ok(seen.every((x) => x.deliveryId), "a delivery id is always present so the outbox can scope the write");
  strictEqual(new Set(seen.map((x) => x.operationId)).size, 2, "different commands never share a step identity");
  // an enclosing delivery scope is kept and only the operation is replaced
  const q = await setup();
  let got: unknown;
  const spy = { writes: [] as any[], apply: async (w: any) => { got = deliveryScope.getStore(); return { id: "x" } as any; } };
  await deliveryScope.run({ deliveryId: "github-D1", workspaceSlug: "qelal" }, () => processPush(push(sha("f"), "WEB-1 #comment hi", OCTO), { ...q.deps, writer: spy as any }));
  deepStrictEqual([(got as any).deliveryId, (got as any).workspaceSlug, (got as any).operationId], ["github-D1", "qelal", `sc:${sha("f")}:0:WEB-1:comment`]);
});
