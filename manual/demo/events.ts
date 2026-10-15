// Webhook scenarios fed through the real reducers. `steps` are run one at a time by the capture script
// (POST /__demo/step {name}) so a screenshot can be taken between them; `scenarioEvents` seeds the rest.
import { createHash } from "node:crypto";

const sha = (s: string) => createHash("sha1").update(s).digest("hex");
const PR_URL = (n: number) => `https://github.com/acme/website/pull/${n}`;
export const WEB42_BRANCH = "WEB-42-make-the-checkout-button-visible-on-small-screens";

function pr(d: any, n: number, o: { title: string; body?: string; head: any; base?: any; draft?: boolean; user?: any; state?: "open" | "closed"; merged?: boolean; labels?: string[] }) {
  const existing = d.gh.prs.get(n);
  if (typeof o.head === "object") o = { ...o, head: o.head.ref };
  if (typeof o.base === "object") o = { ...o, base: o.base.ref };
  const headSha = d.gh.branches.get(o.head) ?? sha(`${o.head}-head`);
  const p = { number: n, title: o.title, body: o.body ?? "", state: o.state ?? "open", merged: o.merged ?? false, draft: o.draft ?? false,
    head: { ref: o.head, sha: headSha }, base: { ref: o.base ?? "main" }, user: { login: (o.user ?? d.USERS.alex.gh).login, id: (o.user ?? d.USERS.alex.gh).id },
    html_url: PR_URL(n), labels: (o.labels ?? []).map((name) => ({ name })), requested_reviewers: [], ...(existing ? { requested_reviewers: existing.requested_reviewers } : {}) };
  d.gh.prs.set(n, p);
  return p;
}
const prEvent = (d: any, action: string, p: any, extra: Record<string, unknown> = {}, sender = d.USERS.alex.gh) =>
  d.feed(d.ghJob("pull_request", { action, number: p.number, pull_request: { ...p }, ...extra }, sender));

async function push(d: any, branch: string, messages: string[], o: { created?: boolean; sender?: any; verified?: boolean } = {}) {
  const before = o.created ? "0".repeat(40) : (d.gh.branches.get(branch) ?? sha(`${branch}-base`));
  const commits = messages.map((message, i) => {
    const id = sha(`${branch}-${message}-${i}-${d.tick(0)}`);
    d.gh.commits.set(id, { sha: id, message, verified: o.verified ?? false, author: (o.sender ?? d.USERS.alex.gh).login });
    return { id, message, distinct: true, url: `https://github.com/acme/website/commit/${id}`, author: { name: "Alex Developer", email: "alex.developer@example.com", username: (o.sender ?? d.USERS.alex.gh).login }, timestamp: d.tick(1) };
  });
  const after = commits.at(-1)?.id ?? before;
  d.gh.branches.set(branch, after);
  const result = await d.feed(d.ghJob("push", { ref: `refs/heads/${branch}`, before, after, created: o.created ?? false, deleted: false, forced: false,
    commits, head_commit: commits.at(-1) ?? null, pusher: { name: (o.sender ?? d.USERS.alex.gh).login } }, o.sender ?? d.USERS.alex.gh));
  // GitHub follows a push to a PR's branch with pull_request.synchronize.
  for (const p of d.gh.prs.values()) if (p.state === "open" && p.head.ref === branch) { p.head = { ref: branch, sha: after }; await prEvent(d, "synchronize", p, { before, after }); }
  return result;
}
function checks(d: any, branch: string, conclusion: "success" | "failure" | null, name = "CI") {
  const head = d.gh.branches.get(branch);
  d.gh.checkSuites.set(head, [{ conclusion, status: conclusion ? "completed" : "in_progress", app: { slug: "github-actions", name } }]);
  return d.feed(d.ghJob("check_suite", { action: conclusion ? "completed" : "requested", check_suite: { id: 3100, head_sha: head, head_branch: branch, status: conclusion ? "completed" : "queued", conclusion,
    app: { slug: "github-actions", name: "GitHub Actions" }, pull_requests: [...d.gh.prs.values()].filter((p: any) => p.head.ref === branch).map((p: any) => ({ number: p.number, head: { ref: branch, sha: head }, base: { ref: p.base.ref } })),
    html_url: `https://github.com/acme/website/actions/runs/31${(Math.random() * 1e6) | 0}` } }));
}
function deployment(d: any, branch: string, env: string, url: string, state = "success") {
  const head = d.gh.branches.get(branch);
  return d.feed(d.ghJob("deployment_status", { action: "created", deployment_status: { id: 6100, state, environment: env, environment_url: url, target_url: url, created_at: d.tick(1) },
    deployment: { id: 6000, sha: head, ref: branch, environment: env, payload: {}, creator: { login: "vercel[bot]", id: 35613825, type: "Bot" } } }, { login: "vercel[bot]", id: 35613825 }));
}
function review(d: any, n: number, state: "approved" | "changes_requested" | "commented", by = d.USERS.sam.gh, body = "") {
  const p = d.gh.prs.get(n);
  const list = d.gh.reviews.get(n) ?? [];
  const r = { id: 9000 + list.length + n * 10, user: { login: by.login, id: by.id, type: "User" }, state: state.toUpperCase(), body, commit_id: p.head.sha, submitted_at: d.tick(1), html_url: `${PR_URL(n)}#pullrequestreview-${9000 + list.length}` };
  d.gh.reviews.set(n, [...list, r]);
  return d.feed(d.ghJob("pull_request_review", { action: "submitted", review: r, pull_request: { ...p } }, by));
}

// ---- the WEB-42 day-in-the-life loop (one step per screenshot) ------------------------------------------------
export const steps: Record<string, (d: any) => Promise<unknown>> = {
  // Create branch from the Development panel is done by the capture script through the real UI; GitHub then sends a push.
  "web42-first-push": (d) => push(d, WEB42_BRANCH, [
    "WEB-42 Move the Place order button into a sticky footer\n\nKeeps the button inside the viewport on phones.",
    "WEB-42 #comment Checked at 320, 375 and 390 px widths; the button stays visible.",
    "WEB-42 #time 1h 30m",
  ], { created: !d.gh.branches.has(WEB42_BRANCH) || d.gh.branches.get(WEB42_BRANCH) === d.gh.branches.get("main") }),
  "web42-open-draft": (d) => prEvent(d, "opened", pr(d, 121, { title: "WEB-42 Keep the checkout button visible on small screens", head: WEB42_BRANCH, draft: true,
    body: "Closes WEB-42\n\nThe **Place order** button now lives in a sticky footer on narrow screens.\n\n- [x] 320 px\n- [x] 375 px\n- [x] 390 px" })),
  "web42-ci-pending": (d) => checks(d, WEB42_BRANCH, null),
  "web42-ci-pass": (d) => checks(d, WEB42_BRANCH, "success"),
  "web42-preview": (d) => deployment(d, WEB42_BRANCH, "Preview", "https://website-git-web-42-acme.vercel.app"),
  "web42-ready-for-review": (d) => { const p = pr(d, 121, { ...d.gh.prs.get(121), head: WEB42_BRANCH, draft: false }); return prEvent(d, "ready_for_review", p); },
  "web42-review-requested": (d) => { const p = d.gh.prs.get(121); p.requested_reviewers = [{ login: d.USERS.sam.gh.login, id: d.USERS.sam.gh.id }];
    return prEvent(d, "review_requested", p, { requested_reviewer: { login: d.USERS.sam.gh.login, id: d.USERS.sam.gh.id, type: "User" } }); },
  "web42-changes-requested": (d) => review(d, 121, "changes_requested", d.USERS.sam.gh, "Please keep the focus ring visible on the button."),
  "web42-fix-push": (d) => push(d, WEB42_BRANCH, ["WEB-42 Keep the focus ring visible on the sticky button #comment Addressed review: focus ring restored."]),
  "web42-ci-pass-2": (d) => checks(d, WEB42_BRANCH, "success"),
  "web42-approved": (d) => review(d, 121, "approved", d.USERS.sam.gh, "Looks good on my phone too."),
  "web42-merged": (d) => { const p = pr(d, 121, { ...d.gh.prs.get(121), head: WEB42_BRANCH, state: "closed", merged: true });
    d.gh.branches.set("main", sha("main-after-121")); return prEvent(d, "closed", p, {}, d.USERS.alex.gh); },
};

// ---- everything else the manual shows ------------------------------------------------------------------------
export async function scenarioEvents(d: any, h: { api: any; step: any; COOKIES: any }) {
  const s = (label: string, fn: () => Promise<unknown>) => h.step(label, async () => { const r = await fn(); if (r && r !== "handled" && r !== "processed") console.log(`   outcome: ${JSON.stringify(r)}`); return r; });

  // Smart Commits: multi-key, state transition, malformed, unknown key (report problems is on).
  await s("smart commit: multi-key + state", () => push(d, "WEB-33-validate-postcode", [
    "WEB-33 WEB-34 #in-progress #comment Shared validation helper for the checkout form",
  ], { created: true }));
  await s("smart commit: malformed + unknown state", () => push(d, "WEB-35-apple-pay", [
    "WEB-35 #time 3x #shipped",
  ], { created: true }));
  await s("smart commit: unknown work item", () => push(d, "WEB-35-apple-pay", ["WEB-999 #comment typo in the key"]));

  // Non-closing (Refs) and relation (Relates to) references.
  await s("PR refs WEB-41", () => prEvent(d, "opened", pr(d, 118, { title: "Tidy checkout focus styles", head: "focus-styles", body: "Refs WEB-41" })));
  await s("PR relates to WEB-40", () => prEvent(d, "opened", pr(d, 119, { title: "Shared button component", head: "shared-button", body: "Relates to WEB-40" })));

  // PR-first: WEB-NEW creates a work item.
  await s("PR WEB-NEW", () => prEvent(d, "opened", pr(d, 122, { title: "WEB-NEW Add rate limiting to the sign-up form", head: "signup-rate-limit", body: "Limits sign-up attempts to 5 per minute per IP address." })));

  // Failing check on WEB-37.
  d.gh.branches.set("WEB-37-rounding", sha("WEB-37-rounding"));
  await s("PR WEB-37 + failing check", async () => {
    await prEvent(d, "opened", pr(d, 123, { title: "WEB-37 Fix total rounding on discounted items", head: "WEB-37-rounding" }));
    return checks(d, "WEB-37-rounding", "failure");
  });

  // Merge guard: two PRs close WEB-36; one merged while the other is still open → item does not move to Done.
  await s("merge guard (WEB-36)", async () => {
    await prEvent(d, "opened", pr(d, 124, { title: "WEB-36 Guest checkout: backend", head: "WEB-36-guest-backend" }));
    await prEvent(d, "opened", pr(d, 125, { title: "WEB-36 Guest checkout: form", head: "WEB-36-guest-form" }));
    return prEvent(d, "closed", pr(d, 124, { title: "WEB-36 Guest checkout: backend", head: "WEB-36-guest-backend", state: "closed", merged: true }));
  });

  // Branch-aware rule: WEB-39 merged into staging → In QA.
  await s("merge to staging (WEB-39)", async () => {
    await prEvent(d, "opened", pr(d, 126, { title: "WEB-39 Speed up the checkout page", head: "WEB-39-speed", base: "staging" }));
    return prEvent(d, "closed", pr(d, 126, { title: "WEB-39 Speed up the checkout page", head: "WEB-39-speed", base: "staging", state: "closed", merged: true }));
  });

  // Issue mirroring GitHub → Plane: a bug report labelled `plane`, a comment, then closed as completed.
  d.gh.issues.set(131, { number: 131, title: "Coupon field accepts expired codes", body: "Steps:\n1. Add any item\n2. Enter `SUMMER24`\n\nExpected: *Code expired*.\n\ncc @sam-reviews", state: "open", labels: [{ name: "plane" }, { name: "bug" }], assignees: [{ login: "alex-dev" }], html_url: "https://github.com/acme/website/issues/131", user: { login: "sam-reviews" } });
  await s("GitHub issue #131 labelled plane", () => d.feed(d.ghJob("issues", { action: "labeled", label: { name: "plane" }, issue: { ...d.gh.issues.get(131) } }, d.USERS.sam.gh)));
  await s("GitHub comment on #131", () => d.feed(d.ghJob("issue_comment", { action: "created", issue: { ...d.gh.issues.get(131) }, comment: { id: 77001, body: "Reproduced on staging. @alex-dev can you take this?", user: { login: "sam-reviews", id: d.USERS.sam.gh.id }, html_url: "https://github.com/acme/website/issues/131#issuecomment-77001" } }, d.USERS.sam.gh)));

  // Issue mirroring Plane → GitHub: WEB-44 gets the `github` label in Plane.
  const web44 = d.itemByKey("WEB-44");
  const githubLabel = "1abe1000-0000-4000-8000-000000000004";
  web44.labels = [githubLabel]; web44.assignees = [d.USERS.alex.id];
  await s("Plane WEB-44 labelled github", () => d.feed({ source: "plane", deliveryId: `demo-plane-${Date.now()}`, event: "issue", receivedAt: d.tick(1),
    payload: { event: "issue", action: "updated", workspace_slug: d.SLUG, webhook_id: "wh-1", workspace_id: "ws",
      data: { id: web44.id, project: d.PROJECT.id, name: web44.name, description_html: "<p>Limit failed sign-ins to <strong>5 per minute</strong>.</p>", labels: [{ id: githubLabel, name: "github" }], assignees: [d.USERS.alex.id], state: { id: web44.state } },
      activity: { field: "labels", old_value: null, new_value: "github", actor: { id: d.USERS.admin.id, email: d.USERS.admin.email } } } }));
}
