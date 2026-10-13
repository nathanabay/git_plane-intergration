// S01–S04: health, setup checklist, workspace and instance health (G3).
import { cfg, scenario, web, sql, assert, eq } from "../lib.mjs";

const API = "/git-sync/api";
const isIso = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));

scenario("S01", "Health endpoint answers 200 without a session", async ({ evidence }) => {
  const [r, head] = await web([["GET", "/git-sync/healthz"], ["GET", "/git-sync/healthz", undefined, { headers: { cookie: null } }]], { as: "anonymous" });
  eq(r.status, 200, "GET /git-sync/healthz status");
  eq(r.data, { status: "ok" }, "health body");
  assert(/application\/json/.test(r.headers["content-type"] ?? ""), `content-type ${r.headers["content-type"]}`);
  eq(head.status, 200, "second call");
  evidence("GET /git-sync/healthz", `${r.status} ${JSON.stringify(r.data)}`);
}, { needs: ["plane"] });

scenario("S02", "Setup checklist: items and statuses (instance admin)", async ({ evidence, log }) => {
  const [r] = await web([["GET", `${API}/instance/setup-check`]], { admin: true });
  eq(r.status, 200, "setup-check status");
  const checks = r.data?.checks;
  assert(Array.isArray(checks) && checks.length >= 5, `checks list: ${JSON.stringify(r.data).slice(0, 300)}`);
  assert(isIso(r.data.checkedAt), "checkedAt is a timestamp");
  for (const c of checks) {
    assert(typeof c.id === "string" && typeof c.title === "string" && typeof c.detail === "string", `check shape ${JSON.stringify(c).slice(0, 200)}`);
    assert(["pass", "fail", "unknown", "warn"].includes(c.status), `check ${c.id} status ${c.status}`);
    log(`${c.id}: ${c.status} — ${c.title}`);
  }
  const by = Object.fromEntries(checks.map((c) => [c.id, c]));
  for (const id of ["credentials", "github_permissions", "github_events", "github_delivery", "plane_delivery"]) assert(by[id], `missing check ${id}`);
  eq(by.credentials.status, "pass", "credentials");
  eq(by.credentials.data?.decryptOk, true, "credentials decrypt");
  eq(by.github_events.status, "pass", "App webhook events");
  eq(by.github_events.data?.missing ?? [], [], "missing events");
  eq(by.github_delivery.status, "pass", "signed GitHub deliveries");
  eq(by.plane_delivery.status, "pass", "Plane deliveries");
  // Known and correct (e2e-results "Not defects"): the App lacks Organization → Members: Read.
  const missing = (by.github_permissions.data?.missing ?? []).map((m) => m.permission);
  if (by.github_permissions.status === "fail") {
    eq(missing, ["members"], "only Members: Read may be missing from the App permissions");
  } else eq(by.github_permissions.status, "pass", "App permissions");
  eq(r.data.ok, checks.every((c) => c.status === "pass"), "overall ok matches the items");
  evidence("checks", checks.map((c) => `${c.id}=${c.status}`).join(", "));
  evidence("App permissions missing", missing.join(",") || "none");
  // A workspace admin session alone is not an instance admin.
  const [w] = await web([["GET", `${API}/instance/setup-check`]]);
  eq(w.status, 401, "setup-check with a workspace (not God-mode) session");
  evidence("setup-check with web session", w.status);
}, { needs: ["admin"] });

scenario("S03", "Workspace health card data", async ({ evidence }) => {
  const [r] = await web([["GET", `${API}/workspaces/${cfg.slug}/health`]]);
  eq(r.status, 200, "workspace health status");
  const h = r.data;
  eq(h.database, true, "database");
  assert(!h.healthError, `healthError: ${h.healthError}`);
  eq(h.githubAppCredentials?.decryptOk, true, "App credentials decrypt");
  assert(["database", "environment"].includes(h.githubAppCredentials?.source), `credential source ${h.githubAppCredentials?.source}`);
  eq(typeof h.planeWebhookSilent, "boolean", "planeWebhookSilent type");
  const m = (h.mappings ?? []).find((x) => x.mappingId === cfg.mappingId);
  assert(m, `mapping ${cfg.mappingId} in health: ${JSON.stringify(h.mappings)}`);
  eq(m.disabledReason, null, "mapping disabledReason");
  assert(isIso(m.lastGithubDeliveryAt), `lastGithubDeliveryAt ${m.lastGithubDeliveryAt}`);
  assert(isIso(m.lastPlaneDeliveryAt), `lastPlaneDeliveryAt ${m.lastPlaneDeliveryAt}`);
  assert(Number.isInteger(m.failuresLast24h) && m.failuresLast24h >= 0, `failuresLast24h ${m.failuresLast24h}`);
  // The card's numbers come from the gitsync database: cross-check the linked-member count.
  const [{ n }] = await sql("SELECT count(*)::int AS n FROM user_map WHERE workspace_slug = $1", [cfg.slug]);
  eq(h.setup?.membersLinked, n, "membersLinked equals user_map rows");
  assert(["custom", "defaults"].includes(h.setup?.rules) && ["custom", "defaults"].includes(h.setup?.policies), "setup rules/policies");
  assert(h.setup?.membersTotal === null || h.setup.membersTotal >= n, `membersTotal ${h.setup?.membersTotal}`);
  eq(h.setup?.appEventsVerified, true, "appEventsVerified");
  evidence("mapping", `#${m.mappingId}: lastGithub ${m.lastGithubDeliveryAt}, lastPlane ${m.lastPlaneDeliveryAt}, failures24h ${m.failuresLast24h}, rateLimitedUntil ${m.rateLimitedUntil}`);
  evidence("setup", JSON.stringify(h.setup));
}, { needs: ["web"] });

scenario("S04", "Instance health (God mode)", async ({ evidence }) => {
  const [r, d] = await web([["GET", `${API}/instance/health`], ["GET", `${API}/instance/disabled-mappings`]], { admin: true });
  eq(r.status, 200, "instance health status");
  const h = r.data;
  eq(h.database, true, "database");
  assert(!h.healthError, `healthError: ${h.healthError}`);
  eq(h.githubAppConfigured, true, "githubAppConfigured");
  eq(h.githubAppCredentials?.decryptOk, true, "credentials decrypt");
  const [{ n }] = await sql("SELECT count(*)::int AS n FROM repo_mappings");
  eq(h.mappings, n, "mapping count equals repo_mappings rows");
  assert(isIso(h.lastActivityAt), `lastActivityAt ${h.lastActivityAt}`);
  assert(Number.isInteger(h.failuresLast24h), `failuresLast24h ${h.failuresLast24h}`);
  eq(d.status, 200, "disabled-mappings status");
  assert(Array.isArray(d.data), "disabled-mappings is a list");
  assert(!JSON.stringify(d.data).includes(`"mappingId":${cfg.mappingId}`) && !d.data.some((x) => Number(x.id ?? x.mappingId) === cfg.mappingId),
    `mapping ${cfg.mappingId} must not be disabled: ${JSON.stringify(d.data).slice(0, 300)}`);
  evidence("instance health", JSON.stringify(h));
  evidence("disabled mappings", d.data.length);
}, { needs: ["admin"] });
