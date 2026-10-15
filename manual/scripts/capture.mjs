#!/usr/bin/env node
// Captures the manual's demo-instance screenshots from the local demo server (manual/demo/server.ts).
//   npm run manual:capture                 all shots (restarts the demo server first, so the data is deterministic)
//   npm run manual:capture -- --only <id>  one or more ids (comma separated); the server is reused if running
// Built on scripts/capture-handbook.mjs: same sanitize() redaction and the same orange numbered callouts.
// Writes manual/images/demo/<id>.png, manual/notes/demo-output/dialogs.md and manual/reports/capture-report.md.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import YAML from 'yaml';
import { sanitize } from '../../scripts/capture-handbook.mjs';

const root = resolve(import.meta.dirname, '../..');
const out = resolve(root, 'manual/images/demo');
const PORT = Number(process.env.DEMO_PORT ?? 3199);
const B = `http://127.0.0.1:${PORT}`;
const ORIGIN = 'http://plane.example.com';
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const board = YAML.parse(readFileSync(resolve(root, 'manual/storyboard-new.yaml'), 'utf8'));
const meta = Object.fromEntries(board.map((e) => [e.id, e]));
mkdirSync(out, { recursive: true });

if (!existsSync(resolve(root, 'dist/ui/index.html'))) execFileSync('npm', ['run', 'build:ui'], { cwd: root, stdio: 'inherit' });

// ---- demo server ----------------------------------------------------------------------------------------------
async function up() { try { return (await fetch(`${B}/__demo/world`)).ok; } catch { return false; } }
if (!only || !(await up())) {
  execFileSync('sh', [resolve(root, 'manual/demo/restart.sh')], { env: { ...process.env, PORT: String(PORT), LOG: process.env.DEMO_LOG ?? resolve(root, 'manual/reports/demo-server.log') }, stdio: 'inherit' });
  if (!(await up())) throw new Error('demo server did not start');
}
const world = async () => (await fetch(`${B}/__demo/world`)).json();
const step = async (name) => { const r = await (await fetch(`${B}/__demo/feed`, { method: 'POST', body: JSON.stringify({ step: name }) })).json(); if (String(r.outcome).startsWith('error')) throw new Error(`${name}: ${r.outcome}`); };
const sql = async (q, params = []) => (await fetch(`${B}/__demo/sql`, { method: 'POST', body: JSON.stringify({ sql: q, params }) })).json();
const flags = async (f) => (await fetch(`${B}/__demo/flags`, { method: 'POST', body: JSON.stringify(f) })).json();
const apiAs = async (cookie, method, path, body) => { const r = await fetch(`${B}/git-sync/api${path}`, { method, headers: { cookie, origin: ORIGIN, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return r.status === 204 ? null : r.json(); };
const PROJECTS = { WEB: 'bb57e81d-c161-441f-b50e-907af28f08c2', API: '0c4b7a52-31d8-4f0e-8d6c-9e2a1b3c4d5e', DES: '4d5e6f70-8192-4a3b-8c4d-5e6f708192a3' };
async function devUrl(key) {
  const item = (await world()).items.find((i) => i.key === key);
  if (!item) throw new Error(`no work item ${key}`);
  return `/git-sync/ui/workspaces/acme/projects/${PROJECTS[key.split('-')[0]]}/work-items/${item.id}/development`;
}

// ---- browser ----------------------------------------------------------------------------------------------------
const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP plane.example.com:80 127.0.0.1:${PORT}`] });
const COOKIE = { admin: ['session-id', 'admin'], alex: ['session-id', 'alex'], sam: ['session-id', 'sam'], riley: ['session-id', 'riley'], god: ['admin-session-id', 'god'] };
const dialogs = [];
const contexts = [];
const closeContexts = async () => { for (const c of contexts.splice(0)) await c.close().catch(() => {}); };
let lastPage = null;
async function open(account, url, { width = 1440, height = 900 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, locale: 'en-US', timezoneId: 'Africa/Addis_Ababa', colorScheme: 'light', reducedMotion: 'reduce', bypassCSP: true });
  contexts.push(ctx);
  const [name, value] = COOKIE[account];
  await ctx.addCookies([{ name, value, domain: 'plane.example.com', path: '/' }]);
  const page = await ctx.newPage();
  page.on('dialog', async (d) => { dialogs.push({ account, url, message: d.message() }); await d.accept(); });
  lastPage = page;
  if (url.startsWith('dev:')) url = await devUrl(url.slice(4));
  await page.goto(ORIGIN + url, { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: '*{animation:none!important;transition:none!important;caret-color:transparent!important}' });
  await settle(page);
  return page;
}
const settle = async (page) => { await page.waitForLoadState('networkidle'); await page.waitForFunction(() => !/Loading…/.test(document.body.innerText)).catch(() => {}); await page.waitForTimeout(250); };

const SECRET = [/gh[pousr]_[A-Za-z0-9]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /plane_api_[A-Za-z0-9]{8,}/, /demo-(?:client|webhook)-secret/, /demo-token-/, /\b(?:\d{1,3}\.){3}\d{1,3}\b/, /[A-Z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Z0-9.-]+\.[A-Z]{2,}/i];
async function secretScan(page, id) {
  const text = await page.evaluate(() => document.body.innerText + '\n' + [...document.querySelectorAll('input,textarea')].map((e) => e.value).join('\n'));
  for (const re of SECRET) if (re.test(text)) throw new Error(`secret scan failed for ${id}: ${re}`);
}

/** Region = locators to keep (union, padded); callouts = locators in caption order. */
async function snap(id, page, { region, callouts = [], pad = 14, full = false } = {}) {
  await page.evaluate(() => { document.querySelectorAll('[data-manual-callout]').forEach((e) => e.remove()); scrollTo(0, 0); });
  await sanitize(page);
  await secretScan(page, id);
  const boxes = [];
  for (const [i, c] of callouts.entries()) {
    const box = await c.boundingBox();
    if (!box) throw new Error(`${id}: callout ${i + 1} not found`);
    boxes.push(box);
  }
  const scroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  let clip;
  if (!full) {
    const regions = Array.isArray(region) ? region : [region ?? page.locator('main, body').first()];
    const rs = [];
    for (const r of regions) { const b = await r.boundingBox(); if (!b) throw new Error(`${id}: region not found`); rs.push(b); }
    for (const b of boxes) rs.push({ x: b.x - 50, y: b.y - 48, width: b.width + 100, height: b.height + 96 });
    const x0 = Math.max(0, Math.min(...rs.map((b) => b.x)) - pad), y0 = Math.max(0, Math.min(...rs.map((b) => b.y)) - pad);
    const x1 = Math.max(...rs.map((b) => b.x + b.width)) + pad, y1 = Math.max(...rs.map((b) => b.y + b.height)) + pad;
    clip = { x: x0 + scroll.x, y: y0 + scroll.y, width: x1 - x0, height: y1 - y0 };
  }
  // Badge (27px) + leader (17px) outside the target. Tries left, above, below, right and keeps the first spot that
  // covers no text or control and stays inside the crop (the handbook's placement rule).
  const bounds = clip ? { x: clip.x - scroll.x, y: clip.y - scroll.y, w: clip.width, h: clip.height } : null;
  for (const [i, box] of boxes.entries()) {
    await page.evaluate(({ i, box, bounds }) => {
      const obstacles = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n; while ((n = walker.nextNode())) { if (!n.nodeValue.trim() || n.parentElement.closest('[data-manual-callout]')) continue; const r = document.createRange(); r.selectNodeContents(n); for (const rect of r.getClientRects()) obstacles.push(rect); }
      for (const el of document.querySelectorAll('button,input,select,textarea,a,img,[role=status]')) { const r = el.getBoundingClientRect(); if (r.width && r.height) obstacles.push(r); }
      for (const el of document.querySelectorAll('[data-manual-callout]')) obstacles.push(el.getBoundingClientRect());
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      const cands = [
        { side: 'left', x: box.x - 48, y: cy - 14, lx: 27, ly: 10, lw: 17, lh: 3 },
        { side: 'above', x: Math.min(Math.max(box.x + 6, cx - 14), box.x + box.width - 27), y: box.y - 46, lx: 10, ly: 27, lw: 3, lh: 17 },
        { side: 'below', x: Math.min(Math.max(box.x + 6, cx - 14), box.x + box.width - 27), y: box.y + box.height + 19, lx: 10, ly: -18, lw: 3, lh: 17 },
        { side: 'right', x: box.x + box.width + 21, y: cy - 14, lx: -18, ly: 10, lw: 17, lh: 3 },
      ];
      const hits = (c) => { const r = { l: Math.min(c.x, c.x + c.lx), t: Math.min(c.y, c.y + c.ly), r: Math.max(c.x + 27, c.x + c.lx + c.lw), b: Math.max(c.y + 27, c.y + c.ly + c.lh) };
        if (bounds && (r.l < bounds.x + 2 || r.t < bounds.y + 2 || r.r > bounds.x + bounds.w - 2 || r.b > bounds.y + bounds.h - 2)) return true;
        if (r.l < 0 || r.t < 0) return true;
        return obstacles.some((o) => !(o.right <= r.l + 1 || o.left >= r.r - 1 || o.bottom <= r.t + 1 || o.top >= r.b - 1) && !(o.left >= box.x - 1 && o.right <= box.x + box.width + 1 && o.top >= box.y - 1 && o.bottom <= box.y + box.height + 1)); };
      const c = cands.find((k) => !hits(k)) ?? cands[0];
      const e = document.createElement('div'); e.dataset.manualCallout = c.side; e.textContent = String(i + 1);
      Object.assign(e.style, { position: 'absolute', left: c.x + scrollX + 'px', top: c.y + scrollY + 'px', height: '27px', width: '27px', borderRadius: '50%', background: '#e34d26', color: 'white', font: 'bold 17px Arial', display: 'grid', placeItems: 'center', zIndex: '2147483647', border: '2px solid white', boxShadow: '0 1px 5px #0008', pointerEvents: 'none' });
      const a = document.createElement('span'); Object.assign(a.style, { position: 'absolute', left: c.lx + 'px', top: c.ly + 'px', width: c.lw + 'px', height: c.lh + 'px', background: '#e34d26' });
      e.append(a); document.body.append(e);
    }, { i, box, bounds });
  }
  await page.screenshot({ path: resolve(out, `${id}.png`), fullPage: true, ...(clip ? { clip } : {}) });
  done.push({ id, callouts: callouts.length, url: new URL(page.url()).pathname + new URL(page.url()).search });
}

const panel = (page, heading) => page.locator('section.panel').filter({ has: page.getByRole('heading', { name: heading, exact: true }) }).first();
const btn = (page, name) => page.getByRole('button', { name, exact: true }).first();
const txt = (page, t) => page.getByText(t, { exact: false }).first();
const label = (page, t) => page.getByText(t, { exact: true }).first();
const done = [], failed = [];

// ---- shots (in storyboard order; later shots depend on earlier ones) --------------------------------------------
const shots = {
  'acct-01-not-connected': async () => { const p = await open('riley', '/git-sync/ui/workspaces/acme/account'); await snap('acct-01-not-connected', p, { region: panel(p, 'My GitHub account'), callouts: [txt(p, 'No personal GitHub account connected.'), btn(p, 'Connect personal account')] }); },
  'acct-02-connected': async () => { const p = await open('alex', '/git-sync/ui/workspaces/acme/account?github=linked'); await snap('acct-02-connected', p, { region: panel(p, 'My GitHub account'), callouts: [txt(p, 'Your personal GitHub account is connected.'), txt(p, 'GitHub account:')] }); },
  'acct-03-connected-idle': async () => { const p = await open('alex', '/git-sync/ui/workspaces/acme/account'); await snap('acct-03-connected-idle', p, { region: panel(p, 'My GitHub account'), callouts: [txt(p, 'GitHub account:'), btn(p, 'Reconnect'), btn(p, 'Disconnect personal account')] }); },
  'acct-04-needs-reauth': async () => {
    await sql(`UPDATE user_tokens SET needs_reauth = true WHERE plane_user_id = $1 AND kind = 'github_oauth'`, ['6a57833d-4e43-49be-924c-f093cddfae76']);
    const p = await open('alex', '/git-sync/ui/workspaces/acme/account');
    await snap('acct-04-needs-reauth', p, { region: panel(p, 'My GitHub account'), callouts: [txt(p, 'Needs re-authorization'), btn(p, 'Reconnect')] });
    await sql(`UPDATE user_tokens SET needs_reauth = false WHERE plane_user_id = $1 AND kind = 'github_oauth'`, ['6a57833d-4e43-49be-924c-f093cddfae76']);
  },
  'acct-06-error-denied': async () => { const p = await open('riley', '/git-sync/ui/workspaces/acme/account?github=error&reason=denied'); await snap('acct-06-error-denied', p, { region: panel(p, 'My GitHub account'), callouts: [p.locator('[role=alert], .error, .panel-error').first()] }); },
  'acct-07-error-already-linked': async () => { const p = await open('riley', '/git-sync/ui/workspaces/acme/account?github=error&reason=already_linked'); await snap('acct-07-error-already-linked', p, { region: panel(p, 'My GitHub account'), callouts: [p.locator('[role=alert], .error, .panel-error').first()] }); },
  'acct-08-member-no-admin': async () => { const p = await open('alex', '/git-sync/ui/workspaces/acme'); await snap('acct-08-member-no-admin', p, { region: [p.locator('h1').first(), panel(p, 'My GitHub account')], callouts: [p.locator('.panel-error, [role=alert]').first()] }); },
  'acct-05-disconnect-confirm': async () => {
    // Native confirm() dialogs are not drawn in screenshots: the dialog text is recorded verbatim, the result is captured.
    const p = await open('riley', '/git-sync/ui/workspaces/acme/account');
    await snap('acct-05-disconnect-confirm', p, { region: panel(p, 'My GitHub account'), callouts: [txt(p, 'No personal GitHub account connected.')] });
  },
  'dev-01-not-mapped': async () => { const p = await open('alex', 'dev:DES-7', { width: 560 }); await snap('dev-01-not-mapped', p, { region: p.locator('main'), callouts: [txt(p, 'No GitHub repository is mapped to this project.')] }); },
  'dev-02-start-work': async () => { const p = await open('alex', 'dev:WEB-42', { width: 560 }); await snap('dev-02-start-work', p, { region: p.locator('main'), callouts: [p.locator('main input').first(), btn(p, 'Copy branch name'), btn(p, 'Create branch')] }); },
  'dev-03-branch-created': async () => { const p = await open('alex', 'dev:WEB-42', { width: 560 }); await btn(p, 'Create branch').click(); await txt(p, 'Branch created').waitFor(); await settle(p); await snap('dev-03-branch-created', p, { region: p.locator('main'), callouts: [txt(p, 'Branch created')] }); },
  'dev-04-branch-exists': async () => { const p = await open('alex', 'dev:WEB-42', { width: 560 }); await btn(p, 'Create branch').click(); await txt(p, 'Branch already exists').waitFor(); await snap('dev-04-branch-exists', p, { region: p.locator('main'), callouts: [txt(p, 'Branch already exists')] }); },
  'dev-05-first-push': async () => { await step('web42-first-push'); const p = await open('alex', 'dev:WEB-42', { width: 560 }); await snap('dev-05-first-push', p, { region: p.locator('main'), callouts: [label(p, 'Branches')] }); },
  'dev-06-draft-pr': async () => { await step('web42-open-draft'); const p = await open('alex', 'dev:WEB-42', { width: 560 }); await snap('dev-06-draft-pr', p, { region: p.locator('main'), callouts: [txt(p, 'PRs:'), p.locator('main a[href*="/pull/"]').first()] }); },
  'dev-07-build-pending': async () => { await step('web42-ci-pending'); const p = await open('alex', 'dev:WEB-42', { width: 560 }); await snap('dev-07-build-pending', p, { region: p.locator('main'), callouts: [label(p, 'Builds')] }); },
  'dev-08-build-pass-preview': async () => { await step('web42-ci-pass'); await step('web42-preview'); const p = await open('alex', 'dev:WEB-42', { width: 560 }); await snap('dev-08-build-pass-preview', p, { region: p.locator('main'), callouts: [label(p, 'Builds'), label(p, 'Deployments'), label(p, 'Previews')] }); },
  'dev-09-review-requested': async () => { await step('web42-ready-for-review'); await step('web42-review-requested'); const p = await open('alex', 'dev:WEB-42', { width: 560 }); await snap('dev-09-review-requested', p, { region: p.locator('main'), callouts: [p.locator('main a[href*="/pull/"]').first()] }); },
  'dev-10-changes-requested': async () => { await step('web42-changes-requested'); const p = await open('alex', 'dev:WEB-42', { width: 560 }); await snap('dev-10-changes-requested', p, { region: p.locator('main'), callouts: [p.locator('main a[href*="/pull/"]').first()] }); },
  'dev-11-approved': async () => { await step('web42-fix-push'); await step('web42-ci-pass-2'); await step('web42-approved'); const p = await open('alex', 'dev:WEB-42', { width: 560 }); await snap('dev-11-approved', p, { region: p.locator('main'), callouts: [p.locator('main a[href*="/pull/"]').first()] }); },
  'dev-12-merged': async () => {
    await step('web42-merged');
    const w = await world(); const s = w.items.find((i) => i.key === 'WEB-42').state;
    if (s !== 'Done') throw new Error(`WEB-42 should be Done after the merge, is ${s}`);
    const p = await open('alex', 'dev:WEB-42', { width: 560 }); await snap('dev-12-merged', p, { region: p.locator('main'), callouts: [txt(p, 'PRs: MERGED')] });
  },
  'dev-13-failing-build': async () => { const p = await open('alex', 'dev:WEB-37', { width: 560 }); await snap('dev-13-failing-build', p, { region: p.locator('main'), callouts: [txt(p, '· fail')] }); },
  'dev-14-merge-guard': async () => { const p = await open('alex', 'dev:WEB-36', { width: 560 }); await snap('dev-14-merge-guard', p, { region: p.locator('main'), callouts: [txt(p, 'MERGED'), p.locator('main a', { hasText: '· OPEN' }).first()] }); },
  'dev-15-web-new': async () => { const p = await open('alex', 'dev:WEB-46', { width: 560 }); await snap('dev-15-web-new', p, { region: p.locator('main'), callouts: [p.locator('main h2').first(), p.locator('main a[href*="/pull/"]').first()] }); },
  'dev-16-mirrored-issue': async () => { const p = await open('alex', 'dev:WEB-47', { width: 560 }); await snap('dev-16-mirrored-issue', p, { region: p.locator('main') }); },
  'dev-17-refs-non-closing': async () => { const p = await open('alex', 'dev:WEB-41', { width: 560 }); await snap('dev-17-refs-non-closing', p, { region: p.locator('main'), callouts: [p.locator('main a[href*="/pull/"]').first()] }); },

  'ws-01-setup-checklist': async () => { const p = await open('admin', '/git-sync/ui/workspaces/beta'); await snap('ws-01-setup-checklist', p, { region: [panel(p, 'Workspace GitHub connection'), panel(p, 'Mapped repositories')], callouts: [txt(p, 'Set up GitHub sync'), btn(p, 'Connect GitHub'), btn(p, 'Send a link to an organization owner')] }); },
  'ws-02-connected': async () => { const p = await open('admin', '/git-sync/ui/workspaces/acme'); await snap('ws-02-connected', p, { region: panel(p, 'Workspace GitHub connection'), callouts: [txt(p, 'installation 51234567'), btn(p, 'Refresh connection'), btn(p, 'Disconnect')] }); },
  'ws-03-owner-link': async () => {
    // The UI asks for the organization login with window.prompt (recorded verbatim in dialogs.md), then shows the link.
    const p = await open('admin', '/git-sync/ui/workspaces/beta'); p.removeAllListeners('dialog');
    p.on('dialog', async (d) => { dialogs.push({ account: 'admin', url: 'Workspace GitHub connection → Send a link to an organization owner', message: d.message() }); await d.accept('acme-labs'); });
    await btn(p, 'Send a link to an organization owner').click(); await settle(p);
    const s = panel(p, 'Workspace GitHub connection');
    await snap('ws-03-owner-link', p, { region: s, callouts: [s.getByRole('heading', { name: 'Send a link to an organization owner' }).or(btn(p, 'Send a link to an organization owner')).first(), s.locator('input, a, code').filter({ hasText: /http|install/ }).first().or(s.locator('input').first()).first()] });
  },
  'ws-04-map-form': async () => {
    await apiAs('session-id=admin', 'DELETE', '/workspaces/acme/mappings/2');
    const p = await open('admin', '/git-sync/ui/workspaces/acme'); const f = panel(p, 'Map a repository');
    await f.locator('select').nth(0).selectOption({ label: 'acme/public-api (private)' }); await settle(p);
    await f.locator('select').nth(1).selectOption({ label: 'API · Public API' }); await settle(p);
    await f.getByRole('combobox').filter({ hasText: 'Two-way' }).selectOption({ label: 'GitHub to Plane only' }).catch(async () => { await f.locator('select').last().selectOption({ label: 'GitHub to Plane only' }); });
    await settle(p);
    await snap('ws-04-map-form', p, { region: f, callouts: [f.getByText('GitHub repository', { exact: true }), f.getByText('Plane project', { exact: true }), f.getByText('Sync direction', { exact: true }), f.getByText('Smart Commits', { exact: true }), btn(p, 'Add mapping')] });
  },
  'ws-05-custom-states': async () => {
    const p = await open('admin', '/git-sync/ui/workspaces/acme'); const f = panel(p, 'Map a repository');
    await f.locator('select').nth(0).selectOption({ label: 'acme/public-api (private)' }); await f.locator('select').nth(1).selectOption({ label: 'API · Public API' }); await settle(p);
    const toggle = f.getByText('Choose different states for open and closed.', { exact: false }).first();
    if (await toggle.count()) await toggle.click().catch(() => {});
    await settle(p);
    await snap('ws-05-custom-states', p, { region: f, callouts: [f.getByText('Open state', { exact: true }), f.getByText('Closed state', { exact: true })] });
  },
  'ws-06-backfill-offer': async () => {
    const p = await open('admin', '/git-sync/ui/workspaces/acme'); const f = panel(p, 'Map a repository');
    await f.locator('select').nth(0).selectOption({ label: 'acme/public-api (private)' }); await settle(p);
    await f.locator('select').nth(1).selectOption({ label: 'API · Public API' }); await settle(p);
    const dir = f.locator('select').filter({ has: p.locator('option', { hasText: 'GitHub to Plane only' }) }).first(); await dir.selectOption({ label: 'GitHub to Plane only' });
    await btn(p, 'Add mapping').click(); await txt(p, 'Repository mapped').waitFor(); await settle(p);
    await snap('ws-06-backfill-offer', p, { region: [p.getByRole('heading', { name: 'Repository mapped' }), btn(p, 'Not now')], callouts: [label(p, 'Backfill'), btn(p, 'Not now')] });
    await btn(p, 'Not now').click().catch(() => {});
  },
  'ws-07-mapped-list': async () => { const p = await open('admin', '/git-sync/ui/workspaces/acme'); const t = panel(p, 'Mapped repositories'); await snap('ws-07-mapped-list', p, { region: t, callouts: [t.getByText('Last GitHub delivery').first(), t.getByText('Errors in the last 24 hours').first(), t.getByRole('link', { name: 'Edit' }).first(), t.getByRole('button', { name: 'Remove' }).first()] }); },
  'ws-08-remove-confirm': async () => { /* dialog text recorded by recordDialogs() */ },
  'map-01-settings': async () => { const p = await open('admin', '/git-sync/ui/workspaces/acme/mappings/1'); await snap('map-01-settings', p, { region: p.locator('main'), callouts: [p.getByRole('link', { name: 'Conflict policies' }).first(), label(p, 'Sync direction'), p.getByText('Smart Commits', { exact: true }).first(), p.getByRole('button', { name: /^Save/ }).first()] }); },
  'map-02-policies': async () => { const p = await open('admin', '/git-sync/ui/workspaces/acme/mappings/1/policies'); await snap('map-02-policies', p, { region: p.locator('main'), callouts: [p.locator('main table, main fieldset, main form').first(), p.locator('main select').first(), btn(p, 'Save policies')] }); },
  'map-03-rules-table': async () => { const p = await open('admin', '/git-sync/ui/workspaces/acme/mappings/1/rules'); const h = label(p, 'Lifecycle points → Plane state'); await snap('map-03-rules-table', p, { region: [h, btn(p, 'Save mapping table')], callouts: [h, btn(p, 'Save mapping table')] }); },
  'map-04-branch-rules': async () => {
    const p = await open('admin', '/git-sync/ui/workspaces/acme/mappings/1/rules'); const h = label(p, 'Branch-aware rules');
    const row = p.locator('main table').filter({ has: p.getByRole('columnheader', { name: 'Base branch (regex)' }) }).locator('tbody tr').first();
    await snap('map-04-branch-rules', p, { region: [h, btn(p, '+ Add branch rule')], callouts: [row.locator('input'), row.locator('select').first(), row.locator('select').nth(1)] });
  },
  'map-05-yaml': async () => { const p = await open('admin', '/git-sync/ui/workspaces/acme/mappings/1/rules'); await btn(p, 'Raw YAML editor').click(); await settle(p); const ta = p.locator('textarea').first(); await snap('map-05-yaml', p, { region: [label(p, 'Rules (YAML)'), ta, btn(p, 'Validate and save YAML')], callouts: [btn(p, 'Raw YAML editor'), ta, btn(p, 'Validate and save YAML')] }); },
  'map-06-yaml-error': async () => {
    const p = await open('admin', '/git-sync/ui/workspaces/acme/mappings/1/rules'); await btn(p, 'Raw YAML editor').click(); await settle(p); const ta = p.locator('textarea').first();
    await ta.fill('- name: Merged into staging\n  when: pull_request.merged\n  if:\n    base_branch: "^staging$"\n  then:\n    - move_to: In QA\n');
    await btn(p, 'Validate and save YAML').click(); await settle(p);
    const err = p.getByText(/Rule at index|unknown action/i).first();
    await snap('map-06-yaml-error', p, { region: [ta, err], callouts: [err] });
  },
  'map-07-versions': async () => { const p = await open('admin', '/git-sync/ui/workspaces/acme/mappings/1/rules'); const h = label(p, 'Rule versions'); await snap('map-07-versions', p, { region: [h, p.getByRole('button', { name: 'Restore' }).last()], callouts: [h, p.locator('button:not([disabled])', { hasText: 'Restore' }).first()] }); },
  'map-08-dryrun-input': async () => { const p = await open('admin', '/git-sync/ui/workspaces/acme/mappings/1/dry-run'); await fillDryRun(p, 'pull_request.merged', 'staging'); await snap('map-08-dryrun-input', p, { region: p.locator('main'), callouts: [p.locator('main select').first(), p.locator('main label.field', { hasText: 'Rule trigger' }).locator('input'), p.locator('main label.field', { hasText: 'Rule context (JSON)' }).locator('textarea'), p.locator('main label.field', { hasText: 'Rules to test (YAML, optional)' }).locator('textarea'), btn(p, 'Run dry-run')] }); },
  'map-09-dryrun-result': async () => { const p = await open('admin', '/git-sync/ui/workspaces/acme/mappings/1/dry-run'); await fillDryRun(p, 'pull_request.merged', 'staging'); await btn(p, 'Run dry-run').click(); await settle(p); await snap('map-09-dryrun-result', p, { region: p.locator('main'), callouts: [p.locator('main').getByText(/staging/).last(), p.locator('main').getByText(/set_state|In QA/).last()] }); },
  'map-10-dryrun-none': async () => { const p = await open('admin', '/git-sync/ui/workspaces/acme/mappings/1/dry-run'); await fillDryRun(p, 'pull_request.approved', 'main'); await btn(p, 'Run dry-run').click(); await txt(p, 'No actions would run.').waitFor(); await snap('map-10-dryrun-none', p, { region: p.locator('main'), callouts: [txt(p, 'No actions would run.')] }); },
  'users-01-list': async () => { const p = await open('admin', '/git-sync/ui/workspaces/acme/users'); const t = panel(p, 'Linked GitHub accounts'); await snap('users-01-list', p, { region: t, callouts: [p.getByRole('heading', { name: 'Linked GitHub accounts' }), t.getByRole('button', { name: 'Unlink' }).first()] }); },
  'users-02-link-form': async () => {
    const p = await open('admin', '/git-sync/ui/workspaces/acme/users'); const f = panel(p, 'Link a user');
    const sel = f.locator('select').first(); await sel.selectOption({ label: 'riley · riley.new@example.com' });
    const login = f.locator('input').first(); await login.fill('riley-codes');
    const look = btn(p, 'Look up id'); if (await look.count()) { await look.click(); await settle(p); }
    await snap('users-02-link-form', p, { region: f, callouts: [sel, login, look, btn(p, 'Link account')] });
  },
  'users-03-unlink-confirm': async () => { /* dialog text recorded by recordDialogs() */ },
  'health-02-disabled': async () => {
    await fetch(`${B}/__demo/installation-event`, { method: 'POST', body: JSON.stringify({ payload: { action: 'removed', repositories_removed: [{ id: 812345679, full_name: 'acme/public-api' }], repositories_added: [] } }) });
    const p = await open('admin', '/git-sync/ui/workspaces/acme'); const t = panel(p, 'Mapped repositories');
    await snap('health-02-disabled', p, { region: t, callouts: [t.getByText(/Disabled|not been verified|no longer approved/).first()] });
  },
  'health-01-rate-limited': async () => {
    await flags({ githubRateLimited: true });
    await fetch(`${B}/__demo/feed`, { method: 'POST', body: JSON.stringify({ event: 'pull_request', payload: { action: 'opened', number: 127, pull_request: { number: 127, title: 'WEB-38 Friendlier empty-cart message', body: '', state: 'open', merged: false, draft: false, head: { ref: 'WEB-38-empty-cart', sha: 'c'.repeat(40) }, base: { ref: 'main' }, user: { login: 'alex-dev', id: 7100002 }, html_url: 'https://github.com/acme/website/pull/127', labels: [] } } }) });
    await flags({ githubRateLimited: false });
    const p = await open('admin', '/git-sync/ui/workspaces/acme'); const t = panel(p, 'Mapped repositories');
    await snap('health-01-rate-limited', p, { region: t, callouts: [t.getByText('Rate-limited until').first()] });
  },
  'audit-01-log': async () => { const p = await open('admin', '/git-sync/ui/workspaces/acme/audit'); const a = panel(p, 'Audit log'); await snap('audit-01-log', p, { region: [p.getByRole('heading', { name: 'Audit log' }), a.locator('tbody tr').nth(9)], callouts: [a.locator('tbody tr').first().locator('td').nth(1), a.locator('tbody tr').first().locator('td').first(), a.locator('summary').first(), a.getByRole('button', { name: 'Replay' }).first()] }); },
  'audit-02-raw': async () => { const p = await open('admin', '/git-sync/ui/workspaces/acme/audit'); const a = panel(p, 'Audit log'); const b = a.locator('tbody tr').nth(1).locator('summary'); await b.click(); await settle(p); const pre = a.locator('tbody tr').nth(1).locator('pre'); await snap('audit-02-raw', p, { region: [a.locator('tbody tr').nth(1)], callouts: [b, pre] }); },
  'audit-03-errors-only': async () => { const p = await open('admin', '/git-sync/ui/workspaces/acme/audit?errors=1'); const a = panel(p, 'Audit log'); await snap('audit-03-errors-only', p, { region: [p.getByRole('heading', { name: 'Audit log' }), a.locator('tbody tr').nth(Math.min(5, (await a.locator('tbody tr').count()) - 1))], callouts: [a.locator('tbody tr').first()] }); },
  'audit-04-replay': async () => { const p = await open('admin', '/git-sync/ui/workspaces/acme/audit'); const a = panel(p, 'Audit log'); await a.getByRole('button', { name: 'Replay' }).first().click(); await settle(p); await p.waitForTimeout(500); await settle(p); const row = a.locator('tbody tr', { hasText: 'replay requested' }).first(); await snap('audit-04-replay', p, { region: [p.getByRole('heading', { name: 'Audit log' }), a.locator('tbody tr').nth(3)], callouts: [row.locator('td').nth(1)] }); },
  'audit-05-retry-write': async () => {
    await flags({ failPlaneWrites: 8 });
    await fetch(`${B}/__demo/feed`, { method: 'POST', body: JSON.stringify({ event: 'push', payload: { ref: 'refs/heads/WEB-38-empty-cart', before: 'c'.repeat(40), after: 'd'.repeat(40), created: false, deleted: false, forced: false, commits: [{ id: 'd'.repeat(40), message: 'WEB-38 #comment New empty-cart copy drafted', url: 'https://github.com/acme/website/commit/' + 'd'.repeat(40) }], pusher: { name: 'alex-dev' } } }) });
    await flags({ failPlaneWrites: 0 });
    const p = await open('admin', '/git-sync/ui/workspaces/acme/audit?errors=1'); const a = panel(p, 'Audit log');
    const retry = a.getByRole('button', { name: /Retry/ }).first();
    await snap('audit-05-retry-write', p, { region: [p.getByRole('heading', { name: 'Audit log' }), retry], callouts: [retry] });
  },
  'map-11-dryrun-custom-yaml': async () => {
    const p = await open('admin', '/git-sync/ui/workspaces/acme/mappings/1/dry-run'); await fillDryRun(p, 'pull_request.merged', 'release/2.0');
    const ta = p.locator('main label.field', { hasText: 'Rules to test (YAML, optional)' }).locator('textarea');
    await ta.fill('- name: Release branches go to QA\n  when: pull_request.merged\n  if:\n    base_branch: "^release/"\n  then:\n    - set_state: In QA\n    - comment: "Merged into a release branch; QA will pick it up."\n');
    await btn(p, 'Run dry-run').click(); await settle(p);
    await snap('map-11-dryrun-custom-yaml', p, { region: [ta, p.locator('main').getByText(/Matched rule/).first(), p.locator('main pre').last()], callouts: [ta, p.locator('main').getByText(/Matched rule/).first()] });
  },
  'audit-06-mapping-filter': async () => { const p = await open('admin', '/git-sync/ui/workspaces/acme/audit?mappingId=1&hours=24'); const a = panel(p, 'Audit log'); await snap('audit-06-mapping-filter', p, { region: [p.getByRole('heading', { name: 'Audit log' }), a.locator('tbody tr').nth(3)], callouts: [p.locator('main').getByText(/mapping|hours/i).first().or(a.locator('tbody tr').first()).first()] }); },
  'users-04-after-link': async () => {
    const p = await open('admin', '/git-sync/ui/workspaces/acme/users'); const f = panel(p, 'Link a user');
    await f.locator('select').first().selectOption({ label: 'riley · riley.new@example.com' }); await f.locator('input').first().fill('riley-codes');
    await btn(p, 'Look up id').click(); await settle(p); await btn(p, 'Link account').click(); await settle(p); await p.waitForTimeout(400); await settle(p);
    const t = panel(p, 'Linked GitHub accounts'); await snap('users-04-after-link', p, { region: t, callouts: [t.getByText('riley-codes').first()] });
  },
  'ws-09-overview': async () => { const p = await open('admin', '/git-sync/ui/workspaces/acme', { height: 1400 }); await snap('ws-09-overview', p, { region: [p.locator('h1').first(), panel(p, 'Mapped repositories')], callouts: [p.getByRole('link', { name: 'Repositories' }).first(), p.getByRole('link', { name: 'User links' }).first(), p.getByRole('link', { name: 'My GitHub account' }).first(), p.getByRole('link', { name: 'Audit log' }).first()] }); },
  'acct-09-admin-tab': async () => { const p = await open('admin', '/git-sync/ui/workspaces/acme/account'); await snap('acct-09-admin-tab', p, { region: [p.locator('h1').first(), panel(p, 'My GitHub account')], callouts: [p.getByRole('link', { name: 'My GitHub account' }).first(), txt(p, 'GitHub account:')] }); },
  'gm-12-instance-audit-default': async () => { const p = await open('god', '/git-sync/ui/admin/audit'); await snap('gm-12-instance-audit-default', p, { region: [p.locator('h1').first(), panel(p, 'Audit log')], callouts: [txt(p, 'Showing activity with no workspace.')] }); },
  'gm-01-overview': async () => { const p = await open('god', '/git-sync/ui/admin'); await snap('gm-01-overview', p, { region: [panel(p, 'Connection health'), panel(p, 'Setup checks')], callouts: [p.getByRole('heading', { name: 'Connection health' }), p.getByRole('heading', { name: 'Setup checks' }), btn(p, 'Check setup again')] }); },
  'gm-03-github-app': async () => { const p = await open('god', '/git-sync/ui/admin'); const s = panel(p, 'GitHub App'); await snap('gm-03-github-app', p, { region: s, callouts: [s.getByText('App ID', { exact: true }), s.getByText('Private key (PEM)', { exact: true }), s.getByText('Webhook secret', { exact: true }), s.getByText('App slug', { exact: true }), s.getByText('GitHub edition', { exact: true }), btn(p, 'Save GitHub App')] }); },
  'gm-04-edition': async () => { const p = await open('god', '/git-sync/ui/admin'); const s = panel(p, 'GitHub App'); const sel = s.locator('select').last(); await sel.selectOption({ index: 2 }).catch(() => {}); await settle(p); await snap('gm-04-edition', p, { region: [s.getByText('GitHub edition', { exact: true }), btn(p, 'Save GitHub App')], callouts: [sel] }); },
  'gm-05-defaults': async () => { const p = await open('god', '/git-sync/ui/admin'); const s = panel(p, 'Defaults'); await snap('gm-05-defaults', p, { region: s, callouts: [s.getByText('Enable Smart Commits for newly mapped repositories'), s.getByText('Require signed commits for Smart Commits'), btn(p, 'Save defaults')] }); },
  'gm-06-magic-words': async () => { const p = await open('god', '/git-sync/ui/admin'); const s = panel(p, 'Magic words'); await snap('gm-06-magic-words', p, { region: s, callouts: [s.locator('textarea').first(), btn(p, 'Save magic words')] }); },
  'gm-07-installations': async () => { const p = await open('god', '/git-sync/ui/admin'); const s = panel(p, 'Workspace GitHub App installations'); await snap('gm-07-installations', p, { region: s, callouts: [s.getByText('51234567').first(), s.getByText('Allow-list an installation', { exact: true })] }); },
  'gm-08-mappings': async () => { const p = await open('god', '/git-sync/ui/admin'); const d = panel(p, 'Disabled repository mappings'); await snap('gm-08-mappings', p, { region: d, callouts: [p.getByRole('heading', { name: 'Disabled repository mappings' }), d.getByText('acme/public-api').first()] }); },
  'gm-09-manual-recovery': async () => { const p = await open('god', '/git-sync/ui/admin'); const s = panel(p, 'Manual mapping recovery'); await snap('gm-09-manual-recovery', p, { region: s, callouts: [s.locator('select, input').first(), s.locator('input').nth(1), btn(p, 'Add manual mapping')] }); },
  'gm-10-instance-audit': async () => { const p = await open('god', '/git-sync/ui/admin/audit?scope=all'); const a = p.locator('section.panel').filter({ has: p.locator('table') }).first(); await snap('gm-10-instance-audit', p, { region: [p.locator('main h1, main h2').first(), a.locator('tbody tr').nth(8)], callouts: [a.locator('thead th', { hasText: 'Workspace' }), a.locator('tbody tr').first().locator('td').nth(2)] }); },
  'gm-02-setup-fail': async () => { await flags({ appEvents: ['issues', 'issue_comment', 'pull_request', 'pull_request_review', 'push', 'status'] }); const p = await open('god', '/git-sync/ui/admin'); await btn(p, 'Check setup again').click(); await settle(p); const s = panel(p, 'Setup checks'); await snap('gm-02-setup-fail', p, { region: s, callouts: [s.getByText(/App webhook events/).first()] }); await flags({ appEvents: null }); },
  'gm-11-decrypt-error': async () => {
    await sql(`UPDATE github_app_config SET private_key_v1 = 'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAA' WHERE id = 1`);
    const p = await open('god', '/git-sync/ui/admin'); await settle(p);
    await snap('gm-11-decrypt-error', p, { region: [panel(p, 'Connection health'), panel(p, 'Setup checks')], callouts: [p.getByText(/cannot be decrypted|could not be decrypted|decrypt/i).first()] });
  },
};
async function fillDryRun(p, trigger, base) {
  await p.locator('main select').first().selectOption('trigger'); await settle(p);
  await p.locator('main label.field', { hasText: 'Rule trigger' }).locator('input').fill(trigger);
  await p.locator('main label.field', { hasText: 'Rule context (JSON)' }).locator('textarea').fill(JSON.stringify({ base_branch: base, head_branch: 'WEB-39-speed', repo: 'acme/website' }, null, 2));
  await settle(p);
}
// Records the exact text of every confirmation dialog the UI shows (native dialogs are not drawn in screenshots).
async function recordDialogs() {
  const before = dialogs.length;
  { const p = await open('admin', '/git-sync/ui/workspaces/acme'); p.removeAllListeners('dialog'); p.on('dialog', async (d) => { dialogs.push({ account: 'admin', url: 'Mapped repositories → Remove', message: d.message() }); await d.dismiss(); }); await panel(p, 'Mapped repositories').getByRole('button', { name: 'Remove' }).first().click(); await p.waitForTimeout(300); }
  { const p = await open('admin', '/git-sync/ui/workspaces/acme/users'); p.removeAllListeners('dialog'); p.on('dialog', async (d) => { dialogs.push({ account: 'admin', url: 'User links → Unlink', message: d.message() }); await d.dismiss(); }); await panel(p, 'Linked GitHub accounts').getByRole('button', { name: 'Unlink' }).first().click(); await p.waitForTimeout(300); }
  { const p = await open('alex', '/git-sync/ui/workspaces/acme/account'); p.removeAllListeners('dialog'); p.on('dialog', async (d) => { dialogs.push({ account: 'alex', url: 'My GitHub account → Disconnect personal account', message: d.message() }); await d.dismiss(); }); await btn(p, 'Disconnect personal account').click(); await p.waitForTimeout(300); }
  { const p = await open('admin', '/git-sync/ui/workspaces/acme/mappings/1/rules'); p.removeAllListeners('dialog'); p.on('dialog', async (d) => { dialogs.push({ account: 'admin', url: 'Rules → Rule versions → Restore', message: d.message() }); await d.dismiss(); }); await p.locator('button:not([disabled])', { hasText: 'Restore' }).first().click(); await p.waitForTimeout(300); }
  { const p = await open('admin', '/git-sync/ui/workspaces/acme/audit'); p.removeAllListeners('dialog'); p.on('dialog', async (d) => { dialogs.push({ account: 'admin', url: 'Audit log → Replay', message: d.message() }); await d.dismiss(); }); await panel(p, 'Audit log').getByRole('button', { name: 'Replay' }).first().click(); await p.waitForTimeout(300); }
  { const p = await open('admin', '/git-sync/ui/workspaces/acme'); p.removeAllListeners('dialog'); p.on('dialog', async (d) => { dialogs.push({ account: 'admin', url: 'Workspace GitHub connection → Disconnect', message: d.message() }); await d.dismiss(); }); await btn(p, 'Disconnect').click(); await p.waitForTimeout(300); }
  await closeContexts();
  return dialogs.length - before;
}

// ---- terminal captures ------------------------------------------------------------------------------------------
async function terminal(id, command, output) {
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 400 }, deviceScaleFactor: 2 })).newPage();
  await page.setContent(`<body style="margin:0;background:#fff"><div id=t style="margin:12px;background:#1e2430;color:#e6e9ef;border-radius:8px;padding:14px 18px;font:13px/1.45 'DejaVu Sans Mono',monospace;white-space:pre-wrap;width:1040px"><div style="color:#8a93a6;margin-bottom:6px">● ● ●</div><span style="color:#7ee787">$</span> ${esc(command)}\n${esc(output)}</div></body>`);
  await page.locator('#t').screenshot({ path: resolve(out, `${id}.png`) });
  await page.context().close();
  done.push({ id, callouts: 0, url: `terminal: ${command}` });
}

// ---- run ----------------------------------------------------------------------------------------------------------
const order = Object.keys(shots);
const selected = only ? order.filter((id) => only.includes(id)) : order;
for (const id of selected) {
  try { await closeContexts(); await shots[id](); await closeContexts(); if (!done.some((d) => d.id === id) && !/confirm$/.test(id)) throw new Error('no image written'); console.log(`✓ ${id}`); }
  catch (e) { failed.push({ id, error: e.message.split('\n')[0] }); console.warn(`✗ ${id}: ${e.message.split('\n')[0]}`); await lastPage?.screenshot({ path: resolve(root, `manual/reports/debug-${id}.png`), fullPage: true }).catch(() => {}); }
}
await closeContexts();
if (!only || only.includes('dialogs')) { try { console.log(`✓ dialogs (${await recordDialogs()})`); } catch (e) { failed.push({ id: 'dialogs', error: e.message.split('\n')[0] }); console.warn(`✗ dialogs: ${e.message.split('\n')[0]}`); } }
if (!only || only.includes('term-01-install-help')) {
  try { await terminal('term-01-install-help', './install.sh --help', execFileSync('bash', [resolve(root, 'install.sh'), '--help'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } }).trimEnd()); }
  catch (e) { failed.push({ id: 'term-01-install-help', error: e.message.split('\n')[0] }); }
}
if (!only || only.includes('term-02-healthz')) {
  try { const r = await fetch(`${B}/git-sync/healthz`); await terminal('term-02-healthz', 'curl -i http://git-sync.internal:3100/git-sync/healthz', `HTTP/1.1 ${r.status} ${r.statusText}\ncontent-type: ${r.headers.get('content-type')}\n\n${await r.text()}`); }
  catch (e) { failed.push({ id: 'term-02-healthz', error: e.message }); }
}
// Before → after strip: frames side by side.
async function strip(id, frames) {
  const imgs = frames.map((f) => `data:image/png;base64,${readFileSync(resolve(out, `${f}.png`)).toString('base64')}`);
  const page = await (await browser.newContext({ viewport: { width: 1800, height: 900 }, deviceScaleFactor: 1 })).newPage();
  await page.setContent(`<body style="margin:0;background:#fff;font:600 15px Arial"><div id=s style="display:flex;gap:10px;align-items:flex-start;padding:10px;width:max-content">${imgs.map((src, i) => `<figure style="margin:0;width:420px"><div style="color:#e34d26;margin:0 0 6px">${i + 1}. ${meta[frames[i]]?.caption?.split(':')[0] ?? ''}</div><img src="${src}" style="width:420px;border:1px solid #d0d7de;border-radius:6px"></figure>`).join('<div style="align-self:center;font-size:28px;color:#94a3b8">→</div>')}</div></body>`);
  await page.locator('#s').screenshot({ path: resolve(out, `${id}.png`) });
  await page.context().close();
  done.push({ id, callouts: 0, url: `strip of ${frames.join(', ')}` });
}
for (const sid of ['strip-web42-loop', 'strip-account-states', 'strip-review-badges']) if (!only || only.includes(sid)) { try { await strip(sid, meta[sid].frames); } catch (e) { failed.push({ id: sid, error: e.message }); } }
await browser.close();

// ---- reports ------------------------------------------------------------------------------------------------------
mkdirSync(resolve(root, 'manual/reports'), { recursive: true });
mkdirSync(resolve(root, 'manual/notes/demo-output'), { recursive: true });
if (dialogs.length) writeFileSync(resolve(root, 'manual/notes/demo-output/dialogs.md'), '# Confirmation dialogs (verbatim, recorded from the running UI)\n\n' + dialogs.map((d) => `- **${d.url}** (${d.account}): “${d.message}”`).join('\n') + '\n');
const placeholders = board.filter((e) => e.placeholder);
const report = ['# Capture report', '', `Run: ${new Date().toISOString()} · demo server ${B} · ${only ? `only ${only.join(',')}` : 'full run'}`, '',
  `Captured: ${done.length} · failed: ${failed.length} · placeholders (need a signed-in browser): ${placeholders.length}`, '',
  '| Id | Callouts | Source |', '|---|---|---|', ...done.map((d) => `| ${d.id} | ${d.callouts} | \`${d.url}\` |`), '',
  '## Failures', '', ...(failed.length ? failed.map((f) => `- **${f.id}**: ${f.error}`) : ['None.']), '',
  '## Placeholders', '', ...placeholders.map((p) => `- **${p.id}** (${p.account}): ${p.caption}`)];
const reportPath = resolve(root, only ? 'manual/reports/capture-report-partial.md' : 'manual/reports/capture-report.md');
writeFileSync(reportPath, report.join('\n') + '\n');
console.log(`captured ${done.length}, failed ${failed.length} → ${reportPath}`);
process.exit(failed.length ? 1 : 0);
