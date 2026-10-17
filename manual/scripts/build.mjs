#!/usr/bin/env node
// Builds the manual from manual/content/*.md (extends scripts/build-handbook.mjs: same A4 sheets, paginator and checks).
//   npm i --no-save --package-lock=false playwright markdown-it mermaid@11 && npx playwright install chromium
//   node manual/scripts/build.mjs
// Outputs: manual/dist/git-sync-user-manual.pdf, git-sync-user-manual.html, cheat-sheet.pdf, manual/reports/build.json.
// Fails on page overflow, orphan headings, broken images, unresolved links or a cheat sheet longer than one page.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import MarkdownIt from 'markdown-it';

const root = resolve(import.meta.dirname, '../..');
const contentDir = join(root, 'manual/content');
const dist = join(root, 'manual/dist');
mkdirSync(dist, { recursive: true });
const require = createRequire(import.meta.url);
const mermaidJs = require.resolve('mermaid/dist/mermaid.min.js');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const today = '15 October 2026';
const TITLE = 'git-sync for Plane — Developer & Admin Manual';

// ---- Markdown → HTML -------------------------------------------------------------------------------------------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// GitHub-style anchors (what the chapter authors link to): lowercase, punctuation dropped, each space becomes a hyphen.
const slug = (s) => s.toLowerCase().replace(/<[^>]+>/g, '').trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
const files = readdirSync(contentDir).filter((f) => /^\d\d[a-z]?-.*\.md$/.test(f)).sort();
const stem = (f) => f.replace(/\.md$/, '');
const md = new MarkdownIt({ html: true, linkify: false, typographer: true });
const fence = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, i, o, env, self) => tokens[i].info.trim() === 'mermaid'
  ? `<div class="mermaid-src">${esc(tokens[i].content)}</div>` : fence(tokens, i, o, env, self);
const linkOpen = md.renderer.rules.link_open ?? ((t, i, o, e, s) => s.renderToken(t, i, o));
const unresolved = [];
md.renderer.rules.link_open = (tokens, i, o, env, self) => {
  const href = tokens[i].attrGet('href') ?? '';
  const m = /^(?:\.\/)?(\d\d[a-z]?-[^#/]+)\.md(?:#(.*))?$/.exec(href);
  if (m) {
    if (!files.includes(`${m[1]}.md`)) unresolved.push(`${env.file}: ${href}`);
    tokens[i].attrSet('href', m[2] ? `#${m[1]}--${m[2]}` : `#${m[1]}`);
  } else if (href.startsWith('#')) tokens[i].attrSet('href', `#${env.stem}--${href.slice(1)}`);
  else if (/^(\.\.\/)+(?!images|diagrams)/.test(href)) tokens[i].attrSet('href', `https://github.com/nathanabay/git_plane-intergration/blob/master/${href.replace(/^(\.\.\/)+/, '')}`);
  return linkOpen(tokens, i, o, env, self);
};
const headingOpen = md.renderer.rules.heading_open ?? ((t, i, o, e, s) => s.renderToken(t, i, o));
md.renderer.rules.heading_open = (tokens, i, o, env, self) => {
  const text = tokens[i + 1].content;
  tokens[i].attrSet('id', tokens[i].tag === 'h1' ? env.stem : `${env.stem}--${slug(text)}`);
  return headingOpen(tokens, i, o, env, self);
};
const chapters = files.map((file) => {
  let src = readFileSync(join(contentDir, file), 'utf8');
  // Placeholders: one paragraph each, kept visible and counted.
  src = src.replace(/^\[\[SCREENSHOT NEEDED:\s*([^\]]+)\]\]\s*$/gm, (_, t) => `<div class="placeholder"><strong>Screenshot needed</strong> — ${esc(t)}</div>`);
  const title = src.match(/^# (.+)$/m)?.[1] ?? '';
  const isPart = /class="part"/.test(src) && !title;
  return { file, stem: stem(file), title: title.replace(/^\d\d · /, ''), num: (title.match(/^(\d\d) · /) ?? [])[1] ?? null, isPart,
    appendix: /^Appendix/.test(title), html: md.render(src, { file, stem: stem(file) }) };
});
if (unresolved.length) throw new Error('Unresolved chapter links:\n' + unresolved.join('\n'));

// ---- page template -----------------------------------------------------------------------------------------------
const css = readFileSync(join(root, 'manual/scripts/manual.css'), 'utf8');
const coverHtml = `<section class="sheet cover"><div class="eyebrow">Plane Community Edition v1.4.2 · git-sync ${esc(version)}</div>
<h1>git-sync for Plane</h1><h2>Developer &amp; Admin Manual</h2><div class="stripe"></div>
<p>Plane for tasks, GitHub for code, and git-sync keeping the two connected — from your first work item to a merged pull request, and from installing the service to keeping it healthy.</p>
<div class="cover-bottom">Bespo EMS PLC<br>git-sync ${esc(version)} · commit ${esc(commit)} · Plane CE v1.4.2<br>${today}</div></section>`;
const src = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(TITLE)}</title>
<base href="${new URL('file://' + contentDir + '/').href}"><style>${css}</style><script src="${new URL('file://' + mermaidJs).href}"></script></head>
<body>${coverHtml}<main id="pages"></main><div id="source">${chapters.map((c) => `<article data-stem="${c.stem}" data-title="${esc(c.title)}" data-num="${c.num ?? ''}" data-part="${c.isPart ? 1 : 0}" data-appendix="${c.appendix ? 1 : 0}">${c.html}</article>`).join('')}</div></body></html>`;
const buildDir = join(root, 'manual/reports/build'); mkdirSync(buildDir, { recursive: true });
writeFileSync(join(buildDir, 'source.html'), src);

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1200 } });
  const pageErrors = []; page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(new URL('file://' + join(buildDir, 'source.html')).href);
  // Images must all load; mermaid renders to inline SVG.
  const broken = await page.evaluate(async () => {
    await document.fonts.ready;
    const bad = [];
    await Promise.all([...document.images].map((i) => i.decode().catch(() => bad.push(i.getAttribute('src')))));
    window.mermaid.initialize({ startOnLoad: false, theme: 'neutral', flowchart: { htmlLabels: false }, fontFamily: 'Arial' });
    let n = 0;
    for (const el of document.querySelectorAll('.mermaid-src')) {
      const { svg } = await window.mermaid.render(`mmd${n++}`, el.textContent);
      const d = document.createElement('div'); d.className = 'mermaid'; d.innerHTML = svg; el.replaceWith(d);
    }
    return bad;
  });
  if (broken.length) throw new Error('Images failed to load:\n' + broken.join('\n'));

  console.log('assets ready; paginating…');
  const verifiedLabels = existsSync(join(root, 'manual/reports/labels.json')) ? JSON.parse(readFileSync(join(root, 'manual/reports/labels.json'), 'utf8')) : null;
  const result = await page.evaluate(({ TITLE, verifiedLabels }) => {
    const issues = [], sheets = [], tocEntries = [], figures = [], labels = new Map();
    const pages = document.querySelector('#pages');
    function newSheet(header, cls = '') {
      const s = document.createElement('section'); s.className = 'sheet ' + cls;
      if (header !== null) { const h = document.createElement('div'); h.className = 'running'; h.innerHTML = header; s.append(h); }
      const c = document.createElement('div'); c.className = 'content'; s.append(c); pages.append(s); sheets.push(s); return c;
    }
    const fits = (c) => c.scrollHeight <= c.clientHeight + 1;
    // A new page that takes the previous page's trailing headings with it (no heading is left at the foot of a page).
    function carry(prev, header, cls) {
      const tail = []; while (/^H[1-6]$/.test(prev.lastElementChild?.tagName || '')) { const h = prev.lastElementChild; h.remove(); tail.unshift(h); }
      const c = newSheet(header, cls); c.append(...tail); return c;
    }
    const articles = [...document.querySelectorAll('#source article')];

    // 1. Prepare: figures (numbered per chapter), boxes, placeholders, mermaid captions.
    let partName = '';
    for (const a of articles) {
      const num = (a.dataset.num ? String(Number(a.dataset.num)) : '') || (a.dataset.appendix === '1' ? a.dataset.title.match(/Appendix ([A-Z])/)?.[1] : '');
      let f = 0;
      for (const p of [...a.querySelectorAll('p')]) if (p.children.length === 1 && p.firstElementChild.tagName === 'IMG' && p.textContent.trim() === '') {
        const img = p.firstElementChild; const fig = document.createElement('figure'); const cap = document.createElement('figcaption');
        const id = `${a.dataset.stem}--fig-${++f}`; fig.id = id;
        const alt = img.getAttribute('alt') ?? '';
        cap.innerHTML = `<span class="fig-no">Figure ${num}.${f}</span> ${alt.replace(/&/g, '&amp;').replace(/</g, '&lt;')}`;
        if (/images\/demo\//.test(img.getAttribute('src'))) img.style.maxWidth = (img.naturalWidth / 2) + 'px';
        if (/images\/demo\/(dev-|acct-)/.test(img.getAttribute('src'))) fig.classList.add('narrow');
        fig.append(img, cap); p.replaceWith(fig);
        figures.push({ id, no: `${num}.${f}`, alt, chapter: a.dataset.stem });
      }
      for (const m of [...a.querySelectorAll('.mermaid')]) {
        const next = m.nextElementSibling; const fig = document.createElement('figure'); fig.className = 'diagram'; const id = `${a.dataset.stem}--fig-${++f}`; fig.id = id;
        const cap = document.createElement('figcaption');
        const text = next?.tagName === 'P' && /^Diagram:/.test(next.textContent.trim()) ? next.textContent.trim() : 'Diagram.';
        cap.innerHTML = `<span class="fig-no">Figure ${num}.${f}</span> ${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}`;
        if (next?.tagName === 'P' && /^Diagram:/.test(next.textContent.trim())) next.remove();
        m.replaceWith(fig); fig.append(m, cap); figures.push({ id, no: `${num}.${f}`, alt: text, chapter: a.dataset.stem });
      }
      for (const q of a.querySelectorAll('blockquote')) {
        const w = q.querySelector('strong')?.textContent.replace(/:$/, '').trim().toLowerCase() ?? '';
        const kind = { tip: 'tip', note: 'note', warning: 'warning', example: 'example', 'admin only': 'admin' }[w]; if (kind) q.classList.add(kind);
      }
      for (const s of a.querySelectorAll('strong')) { if (!s.closest('blockquote') || s !== s.closest('blockquote').querySelector('strong')) s.dataset.label = '1'; }
    }

    // 2. Front matter sheets: contents and list of figures (page numbers filled after pagination).
    const tocBox = newSheet(TITLE, 'toc'); const h = document.createElement('h1'); h.textContent = 'Contents'; tocBox.append(h);
    const tocRows = [];
    for (const a of articles) {
      if (a.dataset.part === '1') { const t = a.querySelector('.part h1')?.textContent ?? ''; const lbl = a.querySelector('.part-label')?.textContent ?? ''; tocRows.push({ kind: 'part', text: `${lbl} · ${t}`, target: a.dataset.stem }); continue; }
      const n = a.dataset.num; tocRows.push({ kind: 'chapter', text: (n ? `${Number(n) || n}  ` : '') + a.dataset.title, target: a.dataset.stem });
    }
    tocRows.push({ kind: 'chapter', text: 'List of figures', target: 'list-of-figures' }, { kind: 'chapter', text: 'Index of UI labels', target: 'label-index' });
    let tocContent = tocBox; const tocLinks = [];
    for (const r of tocRows) {
      const row = document.createElement('div'); row.className = 'toc-row ' + r.kind;
      const l = document.createElement('a'); l.href = '#' + r.target; l.textContent = r.text; const n = document.createElement('span'); n.textContent = '000';
      row.append(l, n); tocContent.append(row); if (!fits(tocContent)) { row.remove(); tocContent = newSheet(TITLE, 'toc'); tocContent.append(row); }
      tocLinks.push({ n, target: r.target });
    }
    let lofContent = newSheet(TITLE, 'lof'); const lh = document.createElement('h1'); lh.id = 'list-of-figures'; lh.textContent = 'List of figures'; lofContent.append(lh);
    const lofLinks = [];
    for (const fgr of figures) {
      const row = document.createElement('div'); row.className = 'toc-row lof';
      const l = document.createElement('a'); l.href = '#' + fgr.id; l.textContent = `${fgr.no}  ${fgr.alt.replace(/\s*\(\d\).*$/, '').slice(0, 110)}`; const n = document.createElement('span'); n.textContent = '000';
      row.append(l, n); lofContent.append(row); if (!fits(lofContent)) { row.remove(); lofContent = newSheet(TITLE, 'lof'); lofContent.append(row); }
      lofLinks.push({ n, target: fgr.id });
    }

    // 3. Body: the handbook paginator (headings travel with their next block; tables split by row with repeated header;
    //    lists split by item; figures never split).
    for (const a of articles) {
      const title = a.dataset.title; const n = a.dataset.num;
      if (a.dataset.part === '1') { partName = a.querySelector('.part h1')?.textContent ?? ''; const c = newSheet(null, 'part-sheet'); c.append(...a.children); c.firstElementChild.id = a.dataset.stem; continue; }
      const header = `<span>${partName && a.dataset.appendix !== '1' ? partName.replace(/</g, '&lt;') + ' · ' : ''}${n ? Number(n) + ' · ' : ''}${title.replace(/</g, '&lt;')}</span>`;
      const cheat = a.querySelector('.cheat') !== null;
      let content = newSheet(header, cheat ? 'cheat-sheet' : '');
      const queue = [...a.children];
      if (cheat) { content.append(...queue); if (!fits(content)) issues.push('Cheat sheet is longer than one page'); continue; }
      while (queue.length) {
        const el = queue.shift();
        content.append(el);
        const isHeading = /^H[1-6]$/.test(el.tagName);
        const room = content.clientHeight - (el.offsetTop - content.offsetTop + el.offsetHeight);
        if (fits(content) && (!isHeading || !queue.length || room >= 110)) continue;
        el.remove();
        if (/^H[1-6]$/.test(content.lastElementChild?.tagName || '')) {
          const tail = []; while (/^H[1-6]$/.test(content.lastElementChild?.tagName || '')) { const hh = content.lastElementChild; hh.remove(); tail.unshift(hh); }
          if (content.children.length) content = newSheet(header); content.append(...tail);
        }
        if (el.tagName === 'TABLE') {
          const rows = [...el.querySelectorAll('tbody tr')]; const head = el.querySelector('thead');
          const part = () => { const t = el.cloneNode(false); if (head) t.append(head.cloneNode(true)); const tb = document.createElement('tbody'); t.append(tb); return [t, tb]; };
          let [t, tb] = part(); content.append(t); let added = 0;
          while (rows.length) {
            tb.append(rows[0]);
            if (fits(content)) { rows.shift(); added++; continue; }
            rows[0].remove();
            if (!added) { t.remove(); }
            content = carry(content, header); [t, tb] = part(); content.append(t); added = 0;
            tb.append(rows[0]); if (!fits(content)) { issues.push('Table row taller than a page: ' + title); } rows.shift(); added = 1;
          }
          continue;
        }
        if ((el.tagName === 'OL' || el.tagName === 'UL') && el.children.length > 1) {
          const items = [...el.children]; let start = Number(el.getAttribute('start') || 1);
          let list = el.cloneNode(false); content.append(list); let count = 0;
          while (items.length) {
            list.append(items[0]);
            if (fits(content)) { items.shift(); count++; continue; }
            items[0].remove(); if (!count) list.remove();
            content = carry(content, header); start += count; list = el.cloneNode(false); if (el.tagName === 'OL') list.setAttribute('start', start); content.append(list); count = 0;
            list.append(items[0]); items.shift(); count = 1; if (!fits(content)) issues.push('List item taller than a page: ' + title);
          }
          continue;
        }
        if (!content.children.length) { content.append(el); issues.push('Oversize block: ' + title + ' ' + el.tagName); continue; }
        content = carry(content, header); content.append(el);
        if (!fits(content)) {
          // A figure that is still too tall on an empty page is scaled down instead of overflowing.
          const img = el.querySelector?.('img, svg');
          if (img) { img.style.maxHeight = (content.clientHeight - 70) + 'px'; img.style.width = 'auto'; }
          if (!fits(content)) issues.push('Oversize block: ' + title + ' ' + el.tagName);
        }
      }
    }

    // 4. Index of UI labels (bold labels → pages).
    const pageOf = (el) => sheets.indexOf(el.closest('.sheet')) + 2; // +1 for the cover, +1 for 1-based
    for (const s of document.querySelectorAll('#pages strong[data-label]')) {
      const t = s.textContent.trim().replace(/[.:,;]$/, ''); if (verifiedLabels && !verifiedLabels.includes(t)) continue; if (t.length < 3 || t.length > 70 || /^(Tip|Note|Warning|Example|Admin only|Goal|Steps|Result|Before you start|If it went wrong|Diagram)$/i.test(t)) continue;
      if (!labels.has(t)) labels.set(t, new Set()); labels.get(t).add(pageOf(s));
    }
    let idx = newSheet(TITLE, 'index'); const ih = document.createElement('h1'); ih.id = 'label-index'; ih.textContent = 'Index of UI labels'; idx.append(ih);
    const intro = document.createElement('p'); intro.textContent = 'Every on-screen label printed in bold in this manual, with the pages where it is explained.'; idx.append(intro);
    let cols = document.createElement('div'); cols.className = 'index-cols'; idx.append(cols);
    for (const [t, ps] of [...labels].sort((x, y) => x[0].localeCompare(y[0], 'en', { sensitivity: 'base' }))) {
      const row = document.createElement('div'); row.className = 'index-row'; row.innerHTML = `<span></span> <em></em>`; row.firstChild.textContent = t; row.lastChild.textContent = [...ps].sort((a, b) => a - b).slice(0, 8).join(', ');
      cols.append(row); if (!fits(idx)) { row.remove(); idx = newSheet(TITLE, 'index'); cols = document.createElement('div'); cols.className = 'index-cols'; idx.append(cols); cols.append(row); }
    }

    // 5. Page numbers, folios and checks.
    const total = sheets.length + 1;
    const pageById = (id) => { const t = document.getElementById(id); return t ? pageOf(t) : null; };
    for (const l of [...tocLinks, ...lofLinks]) { const p = pageById(l.target); if (p === null) issues.push('Missing target ' + l.target); l.n.textContent = String(p ?? '?'); }
    sheets.forEach((s, i) => { if (s.classList.contains('part-sheet')) return; const f = document.createElement('div'); f.className = 'folio'; f.innerHTML = `<span>${TITLE}</span><span>${i + 2} / ${total}</span>`; s.append(f); });
    for (const [i, s] of sheets.entries()) {
      const c = s.querySelector('.content'); if (!c) continue;
      if (c.scrollHeight > c.clientHeight + 2) issues.push(`Page overflow ${i + 2}`);
      if (/^H[1-6]$/.test(c.lastElementChild?.tagName || '')) issues.push(`Orphan heading on page ${i + 2}`);
      const b = c.getBoundingClientRect();
      for (const el of c.querySelectorAll('img,pre,table,svg')) { const r = el.getBoundingClientRect(); if (r.right > b.right + 2) issues.push(`Horizontal overflow on page ${i + 2} (${el.tagName})`); }
    }
    for (const a of document.querySelectorAll('#pages a[href^="#"]')) if (!document.getElementById(a.getAttribute('href').slice(1))) issues.push('Broken internal link ' + a.getAttribute('href'));
    const placeholders = document.querySelectorAll('#pages .placeholder:not(.sample)').length;
    const imgs = [...document.querySelectorAll('#pages figure img')].map((i) => i.getAttribute('src'));
    return { pages: total, figures: figures.length, images: imgs.length, uniqueImages: new Set(imgs).size, placeholders, labels: labels.size, issues: [...new Set(issues)],
      chapters: articles.filter((a) => a.dataset.part !== '1').map((a) => ({ stem: a.dataset.stem, title: a.dataset.title, page: pageById(a.dataset.stem) })) };
  }, { TITLE, verifiedLabels });

  writeFileSync(join(buildDir, 'paginated.html'), await page.content());
  writeFileSync(join(root, 'manual/reports/build.json'), JSON.stringify({ ...result, pageErrors }, null, 2));
  if (result.issues.length) { console.error(result.issues.join('\n')); if (!process.argv.includes('--allow-issues')) throw new Error(`${result.issues.length} layout issue(s)`); }
  await page.pdf({ path: join(dist, 'git-sync-user-manual.pdf'), format: 'A4', preferCSSPageSize: true, printBackground: true, outline: true, tagged: true });

  // Cheat sheet alone, one page.
  const cheat = await page.evaluate(() => { const s = document.querySelector('.cheat-sheet'); return s ? s.outerHTML : null; });
  if (cheat) {
    const cp = await browser.newPage();
    await cp.setContent(`<!doctype html><html><head><meta charset="utf-8"><base href="${new URL('file://' + contentDir + '/').href}"><style>${css}</style></head><body>${cheat.replace(/<div class="folio">[\s\S]*?<\/div>\s*<\/section>$/, '</section>')}</body></html>`);
    await cp.pdf({ path: join(dist, 'cheat-sheet.pdf'), format: 'A4', preferCSSPageSize: true, printBackground: true });
  }

  // Continuous HTML version (one file, images referenced relative to manual/dist/).
  const htmlBody = await page.evaluate(() => {
    const src = document.querySelector('#pages').cloneNode(true);
    src.querySelectorAll('.running,.folio,.toc,.lof,.index').forEach((e) => e.remove());
    const main = document.createElement('main'); for (const c of src.querySelectorAll('.content')) main.append(...c.childNodes); return main.innerHTML;
  });
  const toc = result.chapters.map((c) => `<li><a href="#${c.stem}">${esc(c.title)}</a></li>`).join('');
  writeFileSync(join(dist, 'git-sync-user-manual.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(TITLE)}</title><style>${css}
body{background:#fff}main,header,nav{max-width:860px;margin:0 auto;padding:0 16px}.part{padding:24px 0;border-top:4px solid #e66a3c}figure img{max-height:none}</style></head><body><header><h1>${esc(TITLE)}</h1><p>git-sync ${esc(version)} · commit ${esc(commit)} · Plane CE v1.4.2 · ${today} · Bespo EMS PLC</p></header><nav><h2>Contents</h2><ol>${toc}</ol></nav>${htmlBody.replaceAll('src="../', 'src="../').replaceAll('file://' + contentDir + '/', '')}</body></html>`);
  console.log(`Built ${result.pages} A4 pages · ${result.figures} figures (${result.uniqueImages} distinct images) · ${result.placeholders} screenshot placeholders · ${result.labels} indexed labels.`);
} finally { await browser.close(); }
