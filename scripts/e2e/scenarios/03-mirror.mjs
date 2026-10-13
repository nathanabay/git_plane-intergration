// S14–S27: issue mirroring between GitHub and Plane through the real webhooks (G3).
import {
  assert, cfg, ensureGhLabel, ensurePlaneLabel, eq, gh, items, linksForGh, linksForPlane, name, plane, planeAll,
  planeOrmJson, projectLabels, projectStates, scenario, sleep, sql, waitFor,
} from "../lib.mjs";

const POLL = { interval: 4000 };
const LONG = { timeout: 600_000 };
const marker = (id) => `e2e-${cfg.runId}-${id}-${Math.random().toString(36).slice(2, 7)}`;

// ---- reads -------------------------------------------------------------------------------------------------

async function planeItem(id) {
  const r = await plane("GET", items(id));
  assert(r.status === 200, `Plane item ${id} → ${r.status}`);
  return r.data;
}
const planeComments = (id) => planeAll(`${items(id)}comments/`);
const planeLinks = (id) => planeAll(`${items(id)}links/`);
async function ghIssue(n) {
  const r = await gh("GET", `repo:/issues/${n}`);
  assert(r.status === 200, `GitHub issue #${n} → ${r.status}`);
  return r.data;
}
async function ghComments(n) {
  const r = await gh("GET", `repo:/issues/${n}/comments?per_page=100`);
  assert(r.status === 200, `comments of #${n} → ${r.status}`);
  return r.data;
}
const ids = (v) => (Array.isArray(v) ? v : []).map((x) => (typeof x === "string" ? x : x?.id)).filter(Boolean);
let statesCache;
async function stateGroup(stateId) {
  statesCache ??= await projectStates();
  return statesCache.find((s) => s.id === stateId)?.group;
}
async function stateIdOfGroup(group) {
  statesCache ??= await projectStates();
  const s = statesCache.find((x) => x.group === group);
  assert(s, `no ${group} state in the project`);
  return s.id;
}
async function linkedPlaneUser(login = cfg.owner) {
  const [row] = await sql("SELECT plane_user_id FROM user_map WHERE workspace_slug = $1 AND lower(gh_login) = lower($2)", [cfg.slug, login]);
  return row?.plane_user_id;
}

/** The value once `fn` returns the same JSON twice `quietMs` apart (nothing is still changing). */
async function settled(fn, { quietMs = 15_000, timeout = 150_000, label = "a settled value" } = {}) {
  let prev = JSON.stringify(await fn());
  const r = await waitFor(async () => {
    await sleep(quietMs);
    const now = JSON.stringify(await fn());
    if (now === prev) return { value: JSON.parse(now) };
    prev = now;
    return false;
  }, { timeout, interval: 0, label });
  return r.value;
}

/** A delivery from Plane about this item (and field) was processed after `since`. */
async function planeDeliveryProcessed(itemId, field, since) {
  return waitFor(async () => (await sql(`SELECT outcome FROM audit_log WHERE kind = 'inbound_delivery' AND source = 'plane'
      AND created_at >= $1 AND detail->'payload'->'data'->>'id' = $2 AND ($3::text IS NULL OR detail->'payload'->'activity'->>'field' = $3)
      ORDER BY id DESC LIMIT 1`, [since, itemId, field]))[0], { label: `Plane delivery for ${itemId}${field ? ` (${field})` : ""}`, ...POLL });
}

// ---- pairs ---------------------------------------------------------------------------------------------------

/**
 * Cleanup for a linked pair: close on GitHub (Plane follows to Done), then delete the Plane item. Ids are read when
 * the cleanup runs, so a pair registered before its mirror exists is still cleaned.
 */
function pairCleanup(ctx, ref) {
  ctx.cleanup(async () => {
    if (ref.number) await gh("PATCH", `repo:/issues/${ref.number}`, { state: "closed" });
    if (ref.planeId && ref.number) {
      await waitFor(async () => (await stateGroup((await planeItem(ref.planeId)).state)) === "completed",
        { timeout: 60_000, interval: 5000, label: "Done before delete" }).catch(() => {});
    }
    if (ref.planeId) await plane("DELETE", items(ref.planeId));
  });
}

async function waitLinkForGh(number) {
  return waitFor(async () => (await linksForGh(number)).find((l) => l.status === "active" && l.gh_kind === "issue"),
    { label: `Plane item for GitHub #${number}`, ...POLL });
}

/** A GitHub issue with the `plane` gate label, and its Plane mirror. */
async function fromGithub(ctx, title, { body = "Body written by the e2e suite.", labels = [], assignees } = {}) {
  const ref = {};
  pairCleanup(ctx, ref);
  const r = await gh("POST", "repo:/issues", { title: name(title), body, labels: ["plane", ...labels], ...(assignees ? { assignees } : {}) });
  assert(r.status === 201, `create GitHub issue → ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  ref.number = r.data.number;
  const link = await waitLinkForGh(ref.number);
  ref.planeId = link.plane_issue_id;
  const item = await planeItem(ref.planeId);
  ctx.evidence(`GitHub #${ref.number} → ${cfg.projectKey}-${item.sequence_id}`, r.data.html_url);
  return { number: ref.number, issue: r.data, planeId: ref.planeId, item };
}

/** A Plane item with the `github` gate label, and its GitHub mirror. */
async function fromPlane(ctx, title, descriptionHtml = "<p>e2e</p>") {
  const ref = {};
  pairCleanup(ctx, ref);
  const gate = await ensurePlaneLabel("github");
  const r = await plane("POST", items(), { name: name(title), description_html: descriptionHtml, labels: [gate.id] });
  assert(r.status === 201, `create Plane item → ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  ref.planeId = r.data.id;
  const link = await waitFor(async () => (await linksForPlane(ref.planeId)).find((l) => l.status === "active" && l.gh_kind === "issue"),
    { label: `GitHub issue for ${cfg.projectKey}-${r.data.sequence_id}`, ...POLL });
  ref.number = link.gh_number;
  ctx.evidence(`${cfg.projectKey}-${r.data.sequence_id} → GitHub #${ref.number}`, `https://github.com/${cfg.repo}/issues/${ref.number}`);
  return { number: ref.number, planeId: ref.planeId, item: r.data };
}

// ---- scenarios ------------------------------------------------------------------------------------------------

scenario("S14", "GitHub issue with `plane` → Plane item: mention, issue links, table, code literal, one cross-link each side", async (ctx) => {
  const { evidence } = ctx;
  const body = [
    `Mention @${cfg.owner} and refs #1 and ${cfg.repo}#1.`, "",
    "| col a | col b |", "|---|---|", "| e2e-cell-1 | e2e-cell-2 |", "",
    "```js", `const literal = "@${cfg.owner} #1 <b>bold</b>";`, "```",
  ].join("\n");
  const pair = await fromGithub(ctx, "S14 mirror content", { body });
  const html = String(pair.item.description_html ?? "");
  evidence("description_html", html.slice(0, 1500));
  eq(pair.item.name, name("S14 mirror content"), "Plane title");
  const planeUser = await linkedPlaneUser();
  assert(/<mention-component[^>]*user_mention/.test(html), "mention rendered as a Plane mention component");
  assert(planeUser && html.includes(planeUser), "mention points at the linked Plane user");
  const issueUrl = `https://github.com/${cfg.repo}/issues/1`;
  assert((html.match(new RegExp(`href="${issueUrl.replace(/[/.]/g, "\\$&")}"`, "g")) ?? []).length >= 2, "#1 and owner/repo#1 become links to issue 1");
  assert(/<table/.test(html) && html.includes("e2e-cell-1") && html.includes("e2e-cell-2"), "table kept");
  const pre = html.match(/<pre[\s\S]*?<\/pre>/)?.[0] ?? "";
  assert(pre, "code block kept as <pre>");
  assert(pre.includes(`@${cfg.owner} #1`) && !/mention-component|<a /.test(pre), `code stays literal: ${pre}`);
  assert(pre.includes("&lt;b&gt;bold&lt;/b&gt;") && !/<b>bold/.test(pre), "HTML inside code is escaped");

  // One cross-link each side, still one after the echoes settle.
  const counts = await settled(async () => {
    const [links, comments, ghc] = await Promise.all([planeLinks(pair.planeId), planeComments(pair.planeId), ghComments(pair.number)]);
    return {
      planeLinksToIssue: links.filter((l) => l.url === pair.issue.html_url).length,
      mirroredFrom: comments.filter((c) => /Mirrored from GitHub issue/.test(c.comment_html ?? "")).length,
      ghLinkback: ghc.filter((c) => /Linked to Plane work item/.test(c.body ?? "")).length,
    };
  }, { label: "cross-links" });
  eq(counts, { planeLinksToIssue: 1, mirroredFrom: 1, ghLinkback: 1 }, "cross-links");
  evidence("cross-links", JSON.stringify(counts));
}, { needs: ["github", "plane", "db"] });

scenario("S15", "Plane item with `github` label → GitHub issue, cross-linked", async (ctx) => {
  const { evidence } = ctx;
  const m = marker("S15");
  const pair = await fromPlane(ctx, "S15 from Plane", `<p>Created in Plane ${m}</p>`);
  const issue = await waitFor(async () => { const i = await ghIssue(pair.number); return i.title === name("S15 from Plane") && i; }, { label: "GitHub title", ...POLL });
  eq(issue.user?.type, "Bot", "issue author is the App");
  assert(issue.labels.some((l) => l.name === "plane"), "GitHub issue carries the `plane` label");
  assert(!issue.labels.some((l) => l.name === "github"), "the Plane gate label is not copied");
  assert(issue.body.includes(m), "description mirrored");
  assert(/Mirrored from Plane/.test(issue.body), "footer names Plane");
  const counts = await settled(async () => {
    const [links, ghc, comments] = await Promise.all([planeLinks(pair.planeId), ghComments(pair.number), planeComments(pair.planeId)]);
    return {
      planeLinkToIssue: links.filter((l) => l.url === issue.html_url).length,
      ghLinkback: ghc.filter((c) => /Linked to Plane work item/.test(c.body ?? "")).length,
      mirroredTo: comments.filter((c) => /Mirrored to GitHub issue/.test(c.comment_html ?? "")).length,
    };
  }, { label: "cross-links" });
  eq(counts, { planeLinkToIssue: 1, ghLinkback: 1, mirroredTo: 1 }, "cross-links");
  evidence("GitHub issue", `${issue.html_url} by ${issue.user.login}, labels ${issue.labels.map((l) => l.name).join(",")}`);
  evidence("cross-links", JSON.stringify(counts));
}, { needs: ["github", "plane", "db"] });

scenario("S16", "GitHub title edit → Plane", async (ctx) => {
  const pair = await fromGithub(ctx, "S16 before");
  const r = await gh("PATCH", `repo:/issues/${pair.number}`, { title: name("S16 after") });
  eq(r.status, 200, "edit title");
  const item = await waitFor(async () => { const i = await planeItem(pair.planeId); return i.name === name("S16 after") && i; }, { label: "Plane title", ...POLL });
  ctx.evidence("Plane title", item.name);
}, { needs: ["github", "plane"] });

scenario("S17", "GitHub description edit → Plane", async (ctx) => {
  const pair = await fromGithub(ctx, "S17 description", { body: "first body" });
  const m = marker("S17");
  eq((await gh("PATCH", `repo:/issues/${pair.number}`, { body: `edited body **${m}**` })).status, 200, "edit body");
  const item = await waitFor(async () => { const i = await planeItem(pair.planeId); return String(i.description_html).includes(m) && i; }, { label: "Plane description", ...POLL });
  assert(/<strong>[^<]*e2e-/.test(item.description_html), "markdown rendered");
  assert(!item.description_html.includes("first body"), "old body replaced");
  ctx.evidence("description_html", item.description_html.slice(0, 300));
}, { needs: ["github", "plane"] });

scenario("S18", "Plane title edit is not applied to GitHub (source_of_truth: github)", async (ctx) => {
  const policy = await sql("SELECT policy FROM conflict_policies WHERE mapping_id = $1 AND field = 'title'", [cfg.mappingId]);
  if (policy[0] && policy[0].policy !== "source_of_truth:github") ctx.skip(`mapping title policy is ${policy[0].policy}`);
  const pair = await fromGithub(ctx, "S18 GitHub title");
  const since = new Date().toISOString();
  eq((await plane("PATCH", items(pair.planeId), { name: name("S18 Plane title") })).status, 200, "edit in Plane");
  const delivery = await planeDeliveryProcessed(pair.planeId, "name", since);
  ctx.evidence("Plane delivery outcome", delivery.outcome);
  await sleep(10_000);
  const issue = await ghIssue(pair.number);
  eq(issue.title, name("S18 GitHub title"), "GitHub title unchanged");
  const writes = await sql(`SELECT count(*)::int AS n FROM outbound_writes WHERE side = 'github' AND target_key = $1 AND write->>'kind' = 'update_issue'
    AND write->'fields' ? 'title' AND created_at >= $2`, [JSON.stringify(["github", Number((await sql("SELECT gh_repo_id FROM repo_mappings WHERE id = $1", [cfg.mappingId]))[0].gh_repo_id), ["issue", pair.number]]), since]);
  eq(writes[0].n, 0, "no GitHub title write queued");
  ctx.evidence("GitHub title", issue.title);
}, { needs: ["github", "plane", "db"] });

scenario("S19", "GitHub assignee (linked user) → Plane assignee, and unassign", async (ctx) => {
  const planeUser = await linkedPlaneUser();
  if (!planeUser) ctx.skip(`${cfg.owner} is not linked to a Plane user`);
  const pair = await fromGithub(ctx, "S19 assignee");
  eq((await gh("POST", `repo:/issues/${pair.number}/assignees`, { assignees: [cfg.owner] })).status, 201, "assign on GitHub");
  await waitFor(async () => ids((await planeItem(pair.planeId)).assignees).includes(planeUser), { label: "Plane assignee", ...POLL });
  ctx.evidence("assigned", `${cfg.owner} → Plane user ${planeUser}`);
  eq((await gh("DELETE", `repo:/issues/${pair.number}/assignees`, { assignees: [cfg.owner] })).status, 200, "unassign on GitHub");
  await waitFor(async () => !ids((await planeItem(pair.planeId)).assignees).includes(planeUser), { label: "Plane unassigned", ...POLL });
  ctx.evidence("unassigned", "Plane assignees no longer include the linked user");
}, { needs: ["github", "plane", "db"], ...LONG });

scenario("S20", "Labels added and removed, both ways", async (ctx) => {
  const ghName = "e2e-label-a", planeName = "e2e-label-b";
  await ensureGhLabel(ghName);
  const planeB = await ensurePlaneLabel(planeName);
  const pair = await fromGithub(ctx, "S20 labels");
  // GitHub → Plane
  eq((await gh("POST", `repo:/issues/${pair.number}/labels`, { labels: [ghName] })).status, 200, "label on GitHub");
  const added = await waitFor(async () => {
    const a = (await projectLabels()).find((l) => l.name === ghName);
    return a && ids((await planeItem(pair.planeId)).labels).includes(a.id) && a;
  }, { label: `Plane label ${ghName}`, ...POLL });
  ctx.evidence("GitHub → Plane add", ghName);
  eq((await gh("DELETE", `repo:/issues/${pair.number}/labels/${ghName}`)).status, 200, "unlabel on GitHub");
  await waitFor(async () => !ids((await planeItem(pair.planeId)).labels).includes(added.id), { label: `Plane label ${ghName} removed`, ...POLL });
  ctx.evidence("GitHub → Plane remove", ghName);
  // Plane → GitHub
  const current = ids((await planeItem(pair.planeId)).labels);
  eq((await plane("PATCH", items(pair.planeId), { labels: [...current, planeB.id] })).status, 200, "label in Plane");
  await waitFor(async () => (await ghIssue(pair.number)).labels.some((l) => l.name === planeName), { label: `GitHub label ${planeName}`, ...POLL });
  ctx.evidence("Plane → GitHub add", planeName);
  const now = ids((await planeItem(pair.planeId)).labels).filter((id) => id !== planeB.id);
  eq((await plane("PATCH", items(pair.planeId), { labels: now })).status, 200, "unlabel in Plane");
  await waitFor(async () => !(await ghIssue(pair.number)).labels.some((l) => l.name === planeName), { label: `GitHub label ${planeName} removed`, ...POLL });
  ctx.evidence("Plane → GitHub remove", planeName);
  const final = await ghIssue(pair.number);
  assert(final.labels.some((l) => l.name === "plane"), "gate label kept on GitHub");
}, { needs: ["github", "plane"], ...LONG });

scenario("S21", "GitHub comment → Plane, attributed", async (ctx) => {
  const pair = await fromGithub(ctx, "S21 comment");
  const m = marker("S21");
  eq((await gh("POST", `repo:/issues/${pair.number}/comments`, { body: `A comment from GitHub ${m}` })).status, 201, "comment on GitHub");
  const c = await waitFor(async () => (await planeComments(pair.planeId)).find((x) => String(x.comment_html).includes(m)), { label: "Plane comment", ...POLL });
  assert(new RegExp(`<strong>${cfg.owner}</strong> commented`).test(c.comment_html), `attribution: ${c.comment_html}`);
  assert(/href="https:\/\/github\.com\/[^"]+#issuecomment-\d+"/.test(c.comment_html), "links back to the GitHub comment");
  ctx.evidence("Plane comment", c.comment_html.slice(0, 300));
  const n = await settled(async () => (await planeComments(pair.planeId)).filter((x) => String(x.comment_html).includes(m)).length, { label: "comment count" });
  eq(n, 1, "mirrored once");
}, { needs: ["github", "plane"] });

scenario("S22", "Plane comment → GitHub, posted as the linked user", async (ctx) => {
  const planeUser = await linkedPlaneUser();
  if (!planeUser) ctx.skip(`${cfg.owner} is not linked to a Plane user`);
  const pair = await fromGithub(ctx, "S22 comment");
  const m = marker("S22");
  const r = await plane("POST", `${items(pair.planeId)}comments/`, { comment_html: `<p>A comment from Plane ${m}</p>` });
  eq(r.status, 201, "comment in Plane");
  const c = await waitFor(async () => (await ghComments(pair.number)).find((x) => String(x.body).includes(m)), { label: "GitHub comment", ...POLL });
  assert(/commented in Plane/.test(c.body), `body: ${c.body}`);
  ctx.evidence("GitHub comment", `${c.html_url} by ${c.user.login} (${c.user.type})`);
  eq(c.user.login, cfg.owner, "posted as the linked GitHub user, not the App");
  const n = await settled(async () => ({
    gh: (await ghComments(pair.number)).filter((x) => String(x.body).includes(m)).length,
    plane: (await planeComments(pair.planeId)).filter((x) => String(x.comment_html).includes(m)).length,
  }), { label: "comment counts" });
  eq(n, { gh: 1, plane: 1 }, "one comment each side (no echo back into Plane)");
}, { needs: ["github", "plane", "db"] });

scenario("S23", "GitHub close and reopen → Plane completed / unstarted", async (ctx) => {
  const pair = await fromGithub(ctx, "S23 states");
  eq((await gh("PATCH", `repo:/issues/${pair.number}`, { state: "closed", state_reason: "completed" })).status, 200, "close");
  await waitFor(async () => (await stateGroup((await planeItem(pair.planeId)).state)) === "completed", { label: "Plane completed", ...POLL });
  ctx.evidence("closed", "Plane state group completed");
  eq((await gh("PATCH", `repo:/issues/${pair.number}`, { state: "open" })).status, 200, "reopen");
  await waitFor(async () => (await stateGroup((await planeItem(pair.planeId)).state)) === "unstarted", { label: "Plane unstarted", ...POLL });
  ctx.evidence("reopened", "Plane state group unstarted");
  // GitHub stays open: the Plane state change caused by the mirror is not echoed back as a close.
  await sleep(15_000);
  eq((await ghIssue(pair.number)).state, "open", "GitHub still open");
}, { needs: ["github", "plane"], ...LONG });

scenario("S24", "Plane cancelled → GitHub closed as not planned", async (ctx) => {
  const pair = await fromGithub(ctx, "S24 cancelled");
  eq((await plane("PATCH", items(pair.planeId), { state: await stateIdOfGroup("cancelled") })).status, 200, "cancel in Plane");
  const issue = await waitFor(async () => { const i = await ghIssue(pair.number); return i.state === "closed" && i; }, { label: "GitHub closed", ...POLL });
  eq(issue.state_reason, "not_planned", "state_reason");
  ctx.evidence("GitHub", `${issue.state} / ${issue.state_reason}`);
  await sleep(10_000);
  eq(await stateGroup((await planeItem(pair.planeId)).state), "cancelled", "Plane stays cancelled (the close is not echoed as Done)");
}, { needs: ["github", "plane"] });

scenario("S25", "Two rapid GitHub title edits → the final value wins", async (ctx) => {
  const pair = await fromGithub(ctx, "S25 v0");
  // Back to back (GitHub orders them), well inside the webhook latency, so both deliveries are in flight together.
  const t0 = Date.now();
  const a = await gh("PATCH", `repo:/issues/${pair.number}`, { title: name("S25 v1") });
  const b = await gh("PATCH", `repo:/issues/${pair.number}`, { title: name("S25 v2") });
  eq([a.status, b.status], [200, 200], "edits");
  ctx.evidence("edits sent within", `${Date.now() - t0} ms`);
  const ghTitle = (await ghIssue(pair.number)).title;
  const finalTitle = await settled(async () => (await planeItem(pair.planeId)).name, { quietMs: 20_000, label: "Plane title" });
  eq(finalTitle, ghTitle, "Plane title equals GitHub's final title");
  eq(ghTitle, name("S25 v2"), "GitHub kept the last edit");
  ctx.evidence("final", finalTitle);
}, { needs: ["github", "plane"] });

scenario("S26", "An issue without the `plane` label is not mirrored", async (ctx) => {
  const r = await gh("POST", "repo:/issues", { title: name("S26 unlabelled"), body: "no gate label" });
  eq(r.status, 201, "create issue");
  const number = r.data.number;
  ctx.cleanup(async () => { await gh("PATCH", `repo:/issues/${number}`, { state: "closed" }); });
  ctx.evidence("GitHub issue", r.data.html_url);
  const seen = await waitFor(async () => (await sql(`SELECT outcome, delivery_id FROM audit_log WHERE kind = 'inbound_delivery' AND source = 'github'
      AND detail->>'event' = 'issues' AND detail->'payload'->>'action' = 'opened' AND (detail->'payload'->'issue'->>'number')::int = $1`, [number]))[0],
    { label: "the opened delivery to be processed", ...POLL });
  ctx.evidence("delivery processed", `${seen.delivery_id}: ${seen.outcome}`);
  await sleep(8000);
  eq((await linksForGh(number)).length, 0, "no sync link");
  const found = await planeOrmJson(`from plane.db.models import Issue
print(json.dumps(Issue.all_objects.filter(project_id=${JSON.stringify(cfg.projectId)}, name=${JSON.stringify(name("S26 unlabelled"))}).count()))`);
  eq(found, 0, "no Plane item with that title");
  eq((await ghComments(number)).length, 0, "no linkback comment");
}, { needs: ["github", "db", "orm"] });

scenario("S27", "Echo safety: outbound writes and comments settle (no loop)", async (ctx) => {
  const pair = await fromGithub(ctx, "S27 echo");
  const repoId = Number((await sql("SELECT gh_repo_id FROM repo_mappings WHERE id = $1", [cfg.mappingId]))[0].gh_repo_id);
  const ghKey = JSON.stringify(["github", repoId, ["issue", pair.number]]);
  const planeKey = JSON.stringify(["plane", cfg.slug, cfg.projectId, ["issue", pair.planeId]]);
  // One change each way: a GitHub title edit and a Plane comment.
  eq((await gh("PATCH", `repo:/issues/${pair.number}`, { title: name("S27 echo edited") })).status, 200, "GitHub edit");
  const m = marker("S27");
  eq((await plane("POST", `${items(pair.planeId)}comments/`, { comment_html: `<p>${m}</p>` })).status, 201, "Plane comment");
  await waitFor(async () => (await ghComments(pair.number)).some((c) => String(c.body).includes(m)), { label: "Plane comment on GitHub", ...POLL });
  await waitFor(async () => (await planeItem(pair.planeId)).name === name("S27 echo edited"), { label: "title in Plane", ...POLL });
  const snapshot = async () => {
    const w = await sql(`SELECT target_key, count(*)::int AS n FROM outbound_writes WHERE target_key IN ($1, $2) GROUP BY target_key`, [ghKey, planeKey]);
    const by = Object.fromEntries(w.map((r) => [r.target_key === ghKey ? "githubWrites" : "planeWrites", r.n]));
    return { githubWrites: by.githubWrites ?? 0, planeWrites: by.planeWrites ?? 0,
      githubComments: (await ghComments(pair.number)).length, planeComments: (await planeComments(pair.planeId)).length,
      title: (await ghIssue(pair.number)).title };
  };
  const s = await settled(snapshot, { quietMs: 30_000, timeout: 240_000, label: "write counts to stop growing" });
  ctx.evidence("settled", JSON.stringify(s));
  // GitHub: linkback + the mirrored Plane comment. Plane: "Mirrored from" + the comment made there.
  eq(s.githubComments, 2, "GitHub comments");
  eq(s.planeComments, 2, "Plane comments");
  eq(s.title, name("S27 echo edited"), "GitHub title not rewritten by an echo");
  assert(s.githubWrites <= 6 && s.planeWrites <= 12, `outbound writes bounded: ${JSON.stringify(s)}`);
  const echoes = await sql(`SELECT count(*)::int AS n FROM audit_log WHERE kind = 'inbound_delivery' AND outcome = 'echo' AND created_at > now() - interval '15 minutes'
    AND ((detail->'payload'->'issue'->>'number')::int = $1 OR detail->'payload'->'data'->>'id' = $2 OR detail->'payload'->'data'->>'issue' = $2)`, [pair.number, pair.planeId]);
  assert(echoes[0].n >= 1, "the service's own changes came back and were recognised as echoes");
  ctx.evidence("echo deliveries dropped", echoes[0].n);
}, { needs: ["github", "plane", "db"], ...LONG });

// Found by this suite: Plane v1.4.2 answers 400 "Invalid HTML passed" to `description_html: ""`, which is what an
// issue with no body renders to, so the create plan fails for good and the issue is never mirrored.
scenario("S60", "A GitHub issue with an empty body is mirrored, and clearing the body mirrors", async (ctx) => {
  const problems = [];
  // 1) Clearing the body of a linked issue reaches Plane.
  const pair = await fromGithub(ctx, "S60 body cleared", { body: "to be cleared" });
  const since = new Date().toISOString();
  eq((await gh("PATCH", `repo:/issues/${pair.number}`, { body: "" })).status, 200, "clear body");
  try {
    await waitFor(async () => {
      const f = (await sql(`SELECT error->>'message' AS m FROM outbound_writes WHERE status = 'failed' AND created_at >= $1 AND target_key = $2`,
        [since, JSON.stringify(["plane", cfg.slug, cfg.projectId, ["issue", pair.planeId]])]))[0];
      if (f) return { failed: f.m };
      return !String((await planeItem(pair.planeId)).description_html).includes("to be cleared") && { ok: true };
    }, { label: "Plane description cleared", timeout: 90_000, ...POLL }).then((r) => { if (r.failed) throw new Error(r.failed); });
    ctx.evidence("cleared body", "Plane description cleared");
  } catch (e) { problems.push(`clearing the body: ${e.message}`); }
  // 2) An issue created without a body is mirrored.
  const ref = {};
  pairCleanup(ctx, ref);
  const r = await gh("POST", "repo:/issues", { title: name("S60 empty body"), labels: ["plane"] });
  eq(r.status, 201, "create issue without a body");
  ref.number = r.data.number;
  ctx.evidence("GitHub issue without body", r.data.html_url);
  try {
    const out = await waitFor(async () => {
      const f = (await sql(`SELECT error->>'message' AS m FROM outbound_writes WHERE status = 'failed' AND write->>'kind' = 'create_issue'
        AND write->'_plan'->'after'->0->'link'->>'ghNumber' = $1`, [String(ref.number)]))[0];
      if (f) return { failed: f.m };
      const l = (await linksForGh(ref.number)).find((x) => x.status === "active");
      return l && { link: l };
    }, { label: `Plane item for #${ref.number}`, timeout: 90_000, ...POLL });
    if (out.failed) throw new Error(`Plane create failed: ${out.failed}`);
    ref.planeId = out.link.plane_issue_id;
    ctx.evidence("mirrored", ref.planeId);
  } catch (e) { problems.push(`empty-body create: ${e.message}`); }
  if (problems.length) throw new Error(problems.join(" ; "));
}, { needs: ["github", "plane", "db"], defect: "E2E-3" });
