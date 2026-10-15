#!/usr/bin/env node
// Label check: every **bold** phrase in manual/content/*.md must appear verbatim (case-sensitive) in a source of truth:
//   - git-sync UI and server code: src/ui/client/*.tsx, src/ui/*.ts (+ src/**/*.ts for audit/comment texts)
//   - the Plane fork patches: apps/**, packages/**
//   - manual/notes/verified-strings.md (strings extracted from the UI code)
//   - docs/handbook/HANDBOOK_NOTES.md and docs/handbook/*.md (Plane CE v1.4.2 labels verified live by the handbook)
//   - manual/notes/label-allowlist.txt (words that are not UI labels, each with a reason)
// "A → B → C" paths are split into parts; trailing punctuation and wrapping quotes are ignored; bold text inside
// fenced code blocks is skipped. Prints unknown labels as file:line and exits 1 when there are any.
//   node manual/scripts/check-labels.mjs [--quiet]
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const walk = (dir, ok) => existsSync(dir) ? readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p, ok) : ok(p) ? [p] : [];
}) : [];

const corpusFiles = [
  ...walk(join(root, 'src'), (p) => /\.(tsx?|css)$/.test(p)),
  ...walk(join(root, 'apps'), () => true),
  ...walk(join(root, 'packages'), () => true),
  join(root, 'manual/notes/verified-strings.md'),
  ...walk(join(root, 'docs/handbook'), (p) => p.endsWith('.md')),
  // GitHub's own form labels (App registration, installation) as documented by the repo's runbooks and the user guide.
  ...walk(join(root, 'docs/manual'), (p) => p.endsWith('.md')), join(root, 'deploy/APPLY.md'), join(root, 'INSTALL.md'), join(root, 'install.sh'),
].filter(existsSync);
// JSX splits text across lines and entities; normalise whitespace and common entities.
const norm = (s) => s.replace(/&apos;|&#39;|\{"'"\}/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&rarr;|\\u2192/g, '→').replace(/\s+/g, ' ');
const corpus = norm(corpusFiles.map((f) => readFileSync(f, 'utf8')).join('\n'));

const allowFile = join(root, 'manual/notes/label-allowlist.txt');
const allow = new Set(existsSync(allowFile)
  ? readFileSync(allowFile, 'utf8').split('\n').map((l) => l.replace(/\s+#.*$/, '').trim()).filter((l) => l && !l.startsWith('#'))
  : []);

const clean = (s) => s.trim().replace(/;$/, '').replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').replace(/[.:,;!?…]+$/, '').trim();
const contentDir = join(root, 'manual/content');
const unknown = [];
let checked = 0, leadIns = 0;
const verified = new Set();
const fix = process.argv.includes('--fix-emphasis');
const known = (label) => allow.has(label) || corpus.includes(label)
  // A setup-check line or a status pair ("App permissions: Needs attention", "Disabled · reason") is checked part by part.
  || (/: | · /.test(label) && label.split(/: | · /).every((x) => allow.has(clean(x)) || corpus.includes(clean(x))));
for (const f of readdirSync(contentDir).filter((x) => x.endsWith('.md')).sort()) {
  const file = join(contentDir, f);
  let fence = false;
  const lines = readFileSync(file, 'utf8').split('\n');
  let changed = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
    if (fence) return;
    const noCode = line.replace(/`([^`]*)`/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    for (const m of noCode.matchAll(/\*\*([^*]+?)\*\*/g)) {
      // A lead-in ("**First match wins.** …", "- **Option A:** …") is typography, not a UI label.
      const before = noCode.slice(0, m.index), after = noCode.slice(m.index + m[0].length);
      if (/^\s*(?:[-*+]|\d+\.|\||>)?\s*$/.test(before) && (/[:.]$/.test(m[1].trim()) || /^[:.]/.test(after)) && !known(clean(m[1]))) { leadIns++; continue; }
      const parts = m[1].split(/\s*(?:→|->)\s*|\s+>\s+/).map(clean).filter(Boolean);
      checked += parts.length;
      const bad = parts.filter((label) => !known(label));
      for (const label of parts) if (known(label) && !allow.has(label)) verified.add(label);
      for (const label of bad) unknown.push(`${relative(root, file)}:${i + 1}: **${label}**`);
      // --fix-emphasis: bold that names no UI label becomes italics (style.md: bold is reserved for on-screen labels).
      if (fix && bad.length === parts.length && !line.includes('`**')) { lines[i] = lines[i].replace(m[0], `*${m[1]}*`); changed = true; }
    }
  });
  if (changed) (await import('node:fs')).writeFileSync(file, lines.join('\n'));
}
(await import('node:fs')).writeFileSync(join(root, 'manual/reports/labels.json'), JSON.stringify([...verified].sort(), null, 1));
if (!process.argv.includes('--quiet') || unknown.length) for (const u of unknown) console.log(u);
console.log(`check-labels: ${checked} bold label(s) checked (${leadIns} lead-ins skipped), ${unknown.length} not found in code, verified captures or the allow-list`);
process.exit(unknown.length && !fix ? 1 : 0);
