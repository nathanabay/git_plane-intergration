#!/usr/bin/env node
// Generates the grammar tables of the manual by running every example string through the REAL parsers
// (src/parse/references.ts, src/github/smart-commits.ts), so the tables cannot drift from the code.
//   node manual/scripts/grammar-tables.mjs
// Writes between markers in every manual/content/*.md file:
//   <!-- grammar:references --> … <!-- /grammar -->     reference examples (short set)
//   <!-- grammar:magic --> … <!-- /grammar -->          default magic words, generated from code
//   <!-- grammar:smart-commits --> … <!-- /grammar -->  Smart Commit examples (short set)
//   <!-- grammar:states --> … <!-- /grammar -->         state-command resolution against the demo states
//   <!-- grammar:deny-list --> … <!-- /grammar -->      prefixes that are never work-item keys
//   <!-- grammar:references-full --> / <!-- grammar:smart-commits-full -->  (appendix, all examples)
// A marker with no closing `<!-- /grammar -->` gets one. Idempotent.
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const { parseReferences } = await import(join(root, 'src/parse/references.ts'));
const { DEFAULT_MAGIC_WORDS } = await import(join(root, 'src/parse/magicWords.ts'));
const { parseSmartCommits, resolveTransition } = await import(join(root, 'src/github/smart-commits.ts'));

const code = (s) => '`' + String(s).replace(/`/g, 'ˋ').replace(/\|/g, '\\|').replace(/\n/g, '⏎') + '`';
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const tierName = { closing: 'closing', non_closing: 'non-closing', relation: 'relation' };

// ---- references -------------------------------------------------------------------------------------------
// [source, input, short-table?, note]
const REFS = [
  ['branch', 'WEB-42-checkout-button', true, 'bare key in a branch'],
  ['branch', 'feature/web-42-login', true, 'branch keys are case-insensitive'],
  ['title', 'WEB-42 Keep the checkout button visible', true, 'bare key in a PR title'],
  ['title', 'web-42 keep the button visible', false, 'lowercase bare key in a title'],
  ['body', 'Closes WEB-42', true, 'closing magic word'],
  ['body', 'fixes web-42', false, 'key after a magic word is case-insensitive'],
  ['body', 'Refs WEB-41', true, 'non-closing magic word'],
  ['body', 'Part of WEB-41', false, 'two-word non-closing phrase'],
  ['body', 'Relates to WEB-40', true, 'relation magic word'],
  ['body', 'See WEB-40 for context', true, 'bare uppercase key in a body'],
  ['body', 'see web-40', false, 'lowercase bare key in a body'],
  ['body', 'Closes WEB-42, WEB-43 and API2-7', true, 'several keys after one word'],
  ['body', 'Fixes WEB-1 & WEB-2', false, '& joins keys'],
  ['body', 'Closes: WEB-42', true, 'optional colon, then a space'],
  ['body', 'Closes:WEB-42', true, 'no space after the colon: only the bare key counts'],
  ['body', 'Closes WEB-0042', false, 'leading zeros are normalised'],
  ['body', 'X-42 WEB_42 WEB-42more 42-WEB', true, 'not keys'],
  ['body', 'UTF-8 SHA-256 CVE-2024', true, 'deny-listed prefixes'],
  ['body', 'Closes WEB-42\nskip WEB-42', true, 'skip removes the key from this parse'],
  ['body', 'Fixes WEB-42\nignore WEB-43\nFixes WEB-43', false, 'ignore works like skip'],
  ['commit', 'WEB-42 Move the button', false, 'bare key in a commit message'],
];
function describeRefs(source, text) {
  const input = source === 'commit' ? { commits: [text] } : { [source]: text };
  const r = parseReferences(input, DEFAULT_MAGIC_WORDS);
  const parts = r.refs.map((x) => `${x.identifier} (${tierName[x.tier]})`);
  if (r.skipped.length) parts.push(`skipped: ${r.skipped.join(', ')}`);
  if (r.createRequests.length) parts.push(`create in: ${r.createRequests.join(', ')}`);
  return parts.length ? parts.join('; ') : 'no reference';
}
// Combined sources: strongest tier wins; ties go to branch > title > body > commit.
const COMBINED = [
  [{ branch: 'web-42-checkout', body: 'Refs WEB-42' }, 'branch (closing) beats body Refs (non-closing)'],
  [{ title: 'Checkout tweaks', body: 'Refs WEB-42\nRelates to WEB-42' }, 'non-closing beats relation'],
  [{ title: 'WEB-NEW Add rate limiting', body: '' }, 'WEB-NEW asks for a new item'],
  [{ title: 'Tidy styles', body: 'web-NEW and WEB-new' }, 'only uppercase NEW counts'],
];
function refsTable(full) {
  const rows = REFS.filter((r) => full || r[2]).map(([src, text, , note]) => `| ${code(text)} | ${src} | ${cell(describeRefs(src, text))} | ${cell(note)} |`);
  let t = `| Text | Where | Result (real parser) | Why |\n|---|---|---|---|\n${rows.join('\n')}\n`;
  if (full) {
    t += `\n| Inputs | Result (real parser) | Why |\n|---|---|---|\n` + COMBINED.map(([input, note]) => {
      const r = parseReferences(input, DEFAULT_MAGIC_WORDS);
      const res = [...r.refs.map((x) => `${x.identifier} (${tierName[x.tier]}, from ${x.source})`), ...(r.createRequests.length ? [`create in: ${r.createRequests.join(', ')}`] : [])].join('; ') || 'no reference';
      return `| ${Object.entries(input).filter(([, v]) => v).map(([k, v]) => `${k}: ${code(v)}`).join('<br>')} | ${cell(res)} | ${cell(note)} |`;
    }).join('\n') + '\n';
  }
  return t;
}

// ---- magic words / deny-list --------------------------------------------------------------------------------
function magicTable() {
  return `| Tier | Default words and phrases (from \`src/parse/magicWords.ts\`) |\n|---|---|\n` +
    ['closing', 'non_closing', 'relation'].map((t) => `| ${tierName[t]} | ${DEFAULT_MAGIC_WORDS[t].map((w) => code(w)).join(', ')} |`).join('\n') + '\n';
}
function denyList() {
  const src = readFileSync(join(root, 'src/parse/references.ts'), 'utf8');
  const list = JSON.parse('[' + /NOT_PROJECTS = new Set\(\[([^\]]*)\]/.exec(src)[1] + ']');
  return `Prefixes that are never read as work-item keys (\`NOT_PROJECTS\` in \`src/parse/references.ts\`): ${list.map(code).join(', ')}.\n`;
}

// ---- Smart Commits ------------------------------------------------------------------------------------------
const SMART = [
  ['WEB-42 #comment Checked at 320, 375 and 390 px', true],
  ['Fix layout WEB-42 #time 1h 30m', true],
  ['WEB-42 #time 1w 2d 4h 30m', true],
  ['WEB-42 #time 1.5h', false],
  ['WEB-42 #in-review #time 45m #comment Ready for Sam', true],
  ['WEB-33 WEB-34 #in-progress #comment Shared validation helper', true],
  ['WEB-42 #comment see #12 and WEB-7 — this stays text', true],
  ['WEB-42 #time 3x', true],
  ['WEB-42 #comment', true],
  ['#comment no key before the command', true],
  ['Done. #comment WEB-42 after the command', false],
  ['WEB-42 updated the docs', true],
  ['WEB-42 #done\nWEB-43 #comment Second line, own key', true],
  ['WEB-42\n#comment key on the line above', false],
];
function describeSmart(msg) {
  const entries = parseSmartCommits(msg);
  if (!entries.length) return 'nothing runs';
  return entries.map((e) => {
    const p = [`keys ${e.keys.join(', ')}`];
    if (e.transitions.length) p.push(`state ${e.transitions.map((t) => '#' + t).join(', ')}`);
    if (e.time) p.push(`time ${e.time.raw} = ${e.time.minutes} min`);
    if (e.comment) p.push(`comment “${e.comment}”`);
    if (e.errors?.length) p.push(`error: ${e.errors.join('; ')}`);
    return p.join(' · ');
  }).join(' ‖ ');
}
const smartTable = (full) => `| Commit message | Result (real parser) |\n|---|---|\n` +
  SMART.filter((s) => full || s[1]).map(([m]) => `| ${code(m)} | ${cell(describeSmart(m))} |`).join('\n') + '\n';

// ---- state commands -----------------------------------------------------------------------------------------
const STATES = ['Backlog', 'Todo', 'In Progress', 'In Review', 'In QA', 'Done', 'Cancelled'].map((name, i) => ({ id: String(i), name, group: 'x' }));
const TOKENS = ['in-review', 'In-Review', 'inreview', 'done', 'todo', 'in-qa', 'in', 'progress', 'cancel', 'shipped'];
const statesTable = () => `States of the example project: ${STATES.map((s) => s.name).join(', ')}.\n\n| Command | Result (real resolver) |\n|---|---|\n` +
  TOKENS.map((t) => { const r = resolveTransition(STATES, t); return `| ${code('#' + t)} | ${r.ok ? '→ ' + STATES[Number(r.stateId)].name : r.reason === 'ambiguous' ? 'refused: ambiguous' : 'refused: no such state'} |`; }).join('\n') + '\n';

const BLOCKS = {
  references: () => refsTable(false), 'references-full': () => refsTable(true),
  magic: magicTable, 'deny-list': denyList,
  'smart-commits': () => smartTable(false), 'smart-commits-full': () => smartTable(true),
  states: statesTable,
};

const dir = join(root, 'manual/content');
if (!existsSync(dir)) { console.log('grammar-tables: no manual/content yet'); process.exit(0); }
let changed = 0, blocks = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
  const file = join(dir, f);
  const src = readFileSync(file, 'utf8');
  const out = src.replace(/<!-- grammar:([a-z-]+) -->([\s\S]*?)(?=<!-- grammar:|$)/g, (whole, name, rest) => {
    const gen = BLOCKS[name];
    if (!gen) throw new Error(`${f}: unknown grammar block ${name}`);
    blocks++;
    const end = rest.indexOf('<!-- /grammar -->');
    const tail = end >= 0 ? rest.slice(end + '<!-- /grammar -->'.length) : rest;
    return `<!-- grammar:${name} -->\n\n${gen()}\n<!-- /grammar -->${tail.startsWith('\n') ? '' : '\n'}${tail}`;
  });
  if (out !== src) { writeFileSync(file, out); changed++; }
}
console.log(`grammar-tables: ${blocks} block(s) generated, ${changed} file(s) updated`);
