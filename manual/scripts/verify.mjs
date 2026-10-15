#!/usr/bin/env node
// Verifies the built manual. Exit 1 on any hard failure; soft findings go to manual/reports/verify.json.
//   node manual/scripts/verify.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const m = (p) => join(root, 'manual', p);
const hard = [], soft = [], facts = {};
const fail = (msg) => hard.push(msg), warn = (msg) => soft.push(msg);

// 1. Outputs.
for (const f of ['dist/git-sync-user-manual.pdf', 'dist/git-sync-user-manual.html', 'dist/cheat-sheet.pdf']) if (!existsSync(m(f)) || statSync(m(f)).size < 1000) fail(`missing output ${f}`);
const pages = (f) => Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [m(f)], { encoding: 'utf8' }))?.[1] ?? 0);
if (!hard.length) {
  facts.pdfPages = pages('dist/git-sync-user-manual.pdf'); facts.cheatPages = pages('dist/cheat-sheet.pdf');
  facts.pdfMB = +(statSync(m('dist/git-sync-user-manual.pdf')).size / 1e6).toFixed(1);
  if (facts.cheatPages !== 1) fail(`cheat sheet has ${facts.cheatPages} pages`);
  const info = execFileSync('pdfinfo', [m('dist/git-sync-user-manual.pdf')], { encoding: 'utf8' });
  facts.tagged = /Tagged:\s+yes/.test(info);
}
const build = existsSync(m('reports/build.json')) ? JSON.parse(readFileSync(m('reports/build.json'), 'utf8')) : null;
if (!build) fail('no build report'); else { facts.figures = build.figures; facts.placeholders = build.placeholders; if (build.issues.length) fail(`layout issues: ${build.issues.join('; ')}`); }

// 2. Content: images exist, alt texts carry an honest label, placeholders are listed in REVIEW_NOTES.
const files = readdirSync(m('content')).filter((f) => f.endsWith('.md')).sort();
const all = files.map((f) => ({ f, s: readFileSync(m('content/' + f), 'utf8') }));
const images = new Set(); const placeholders = [];
for (const { f, s } of all) {
  for (const [, alt, src] of s.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
    if (!/^(Screenshot \((test Plane|GitHub|demo instance|terminal)\)|Diagram|Illustration|Strip \(demo instance\)):/.test(alt)) fail(`${f}: image alt lacks a provenance label: ${alt.slice(0, 60)}`);
    if (!existsSync(resolve(m('content'), src))) fail(`${f}: missing image ${src}`);
    images.add(src);
    if (/Screenshot \(demo instance\)/.test(alt) && !/images\/demo\//.test(src)) fail(`${f}: demo label on non-demo image ${src}`);
    if (/images\/demo\//.test(src) && !/demo instance|terminal/.test(alt)) fail(`${f}: demo image without demo label ${src}`);
  }
  for (const [, t] of s.matchAll(/^\[\[SCREENSHOT NEEDED:\s*([^\]]+)\]\]/gm)) placeholders.push({ f, id: t.split(/\s+—\s+|\s+-\s+/)[0].trim(), t });
}
facts.distinctImages = images.size; facts.pngFiles = ['demo', 'handbook', 'userguide'].reduce((n, d) => n + readdirSync(m('images/' + d)).filter((x) => x.endsWith('.png')).length, 0);
facts.placeholderIds = [...new Set(placeholders.map((p) => p.id))];
const review = existsSync(m('REVIEW_NOTES.md')) ? readFileSync(m('REVIEW_NOTES.md'), 'utf8') : '';
for (const id of facts.placeholderIds) if (!review.includes(id)) fail(`placeholder ${id} not listed in REVIEW_NOTES.md`);
for (const h of ['Decisions made without asking', 'Blocked items']) if (!review.includes(h)) fail(`REVIEW_NOTES.md lacks "${h}"`);
const unused = readdirSync(m('images/demo')).filter((x) => x.endsWith('.png') && ![...images].some((i) => i.endsWith('/' + x)));
if (unused.length) warn(`demo images not used in any chapter: ${unused.join(', ')}`);

// 3. Secrets and private data in sources, HTML and PDF text.
const SECRET = [[/gh[pousr]_[A-Za-z0-9]{20,}/, 'GitHub token'], [/-----BEGIN [A-Z ]*PRIVATE KEY-----\s*\n\s*[A-Za-z0-9+/=]{40,}/, 'private key'], [/plane_api_[A-Za-z0-9]{12,}/, 'Plane API key'],
  [/demo-token-|demo-client-secret|demo-webhook-secret/, 'demo secret'], [/\b100\.85\.\d+\.\d+\b/, 'test host address'], [/[A-Z0-9._%+-]+@(?!example\.(?:com|org|net)\b)(?!users\.noreply)[A-Z0-9.-]+\.[A-Z]{2,}/i, 'non-example email']];
const pdfText = existsSync(m('dist/git-sync-user-manual.pdf')) ? execFileSync('pdftotext', ['-layout', m('dist/git-sync-user-manual.pdf'), '-'], { encoding: 'utf8', maxBuffer: 1 << 28 }) : '';
for (const [name, text] of [...all.map(({ f, s }) => [f, s]), ['PDF text', pdfText]]) for (const [re, what] of SECRET) { const hit = re.exec(text); if (hit && !/noreply@anthropic\.com|git@github\.com/.test(hit[0])) fail(`${name}: ${what} (${hit[0].slice(0, 24)}…)`); }

// 4. UI labels.
const labels = spawnSync('node', [m('scripts/check-labels.mjs')], { encoding: 'utf8' });
facts.labelCheck = (labels.stdout.match(/(\d+) bold phrase[^\n]*/) ?? [labels.stdout.split('\n').slice(-2).join(' ')])[0];
if (labels.status !== 0) fail(`label check: ${labels.stdout.trim().split('\n').slice(-12).join(' | ')}`);

// 5. Coverage of the catalogue sections A–L (text terms + at least one figure or placeholder in the chapters).
const COVER = {
  A: [['02-', '03-', '04-', '05-', '06-', '07-'], ['Preferences', 'Your work', 'Board', 'Spreadsheet', 'Gantt', 'Drafts', 'Cycles', 'Modules', 'Pages', 'Intake', 'Estimates', 'Inbox']],
  B: [['08-'], ['installation', 'one workspace', 'personal']],
  C: [['08-'], ['Connect personal account', 'Reconnect', 'Disconnect personal account', 'Needs re-authorization', 'Your personal GitHub account is connected.']],
  D: [['09-', '10-'], ['skip WEB-42', 'WEB-NEW', 'Relates to', 'Refs', 'Closes', 'deny']],
  E: [['12-'], ['Copy branch name', 'Create branch', 'Branch already exists', 'Previews', 'No GitHub repository is mapped to this project.']],
  F: [['11-'], ['#comment', '#time', 'Time logged', 'REQUIRE_VERIFIED_COMMITS', 'Report problems']],
  G: [['13-'], ['last_write_wins', 'source_of_truth:github', 'not_planned', 'GitHub to Plane only', 'echo']],
  H: [['14-', '26-'], ['ready_for_merge', 'base_branch', 'set_state', 'merge guard', 'staging']],
  I: [['24-', '25-', '26-', '27-', '28-'], ['Map a repository', 'Add mapping', 'Conflict policies', 'Validate and save YAML', 'Run dry-run', 'Link account', 'Rate-limited until', 'Show raw', 'Replay']],
  J: [['23-'], ['Check setup again', 'Private key (PEM)', 'Save GitHub App', 'Enterprise Server', 'Save magic words', 'Allow-list an installation', 'Add manual mapping']],
  K: [['21-', '22-', '29-'], ['--plane-dir', '--public-url', 'WEBHOOK_ALLOWED_HOSTS', '/git-sync/webhooks/github', '/git-sync/healthz', '--purge']],
  L: [['94-'], ['comment', 'autolink', 'template', 'delete']],
};
facts.coverage = {};
for (const [sec, [prefixes, terms]] of Object.entries(COVER)) {
  const text = all.filter(({ f }) => prefixes.some((p) => f.startsWith(p))).map(({ s }) => s).join('\n');
  const missing = terms.filter((t) => !text.toLowerCase().includes(t.toLowerCase()));
  const figs = (text.match(/!\[/g) ?? []).length, ph = (text.match(/\[\[SCREENSHOT NEEDED/g) ?? []).length;
  facts.coverage[sec] = { terms: terms.length - missing.length + '/' + terms.length, figures: figs, placeholders: ph };
  if (missing.length) fail(`coverage ${sec}: missing ${missing.join(', ')}`);
  if (sec !== 'L' && !figs && !ph) fail(`coverage ${sec}: no figure or placeholder`);
}

// 6. Spelling (soft; cspell with the project word list).
const cs = spawnSync('npx', ['--no-install', 'cspell', '--no-progress', '--no-summary', '--words-only', '--unique', '-c', m('scripts/cspell.json'), m('content/*.md')], { encoding: 'utf8' });
facts.spelling = cs.error ? 'cspell not installed (npm i --no-save cspell)' : [...new Set(cs.stdout.split('\n').filter(Boolean))];
if (Array.isArray(facts.spelling) && facts.spelling.length) warn(`possible misspellings: ${facts.spelling.slice(0, 60).join(', ')}`);

writeFileSync(m('reports/verify.json'), JSON.stringify({ hard, soft, facts }, null, 2));
console.log(JSON.stringify(facts, null, 1));
for (const s of soft) console.warn('warn:', s);
for (const h of hard) console.error('FAIL:', h);
console.log(hard.length ? `MANUAL NOT VERIFIED (${hard.length} failure(s))` : 'MANUAL VERIFIED');
process.exit(hard.length ? 1 : 0);
