#!/usr/bin/env node
// Oracle for docs/handbook: the PDF developer handbook (Plane for tasks + GitHub through git-sync).
// Needs poppler (pdfinfo, pdftotext, pdfimages). Prints "HANDBOOK VERIFIED" only when every check passes.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DIR = join(ROOT, "docs", "handbook");
const PDF = join(DIR, "Plane-GitHub-Developer-Handbook.pdf");
const fail = [];
const need = (cond, msg) => { if (!cond) fail.push(msg); };
const read = (f) => (existsSync(f) ? readFileSync(f, "utf8") : "");
const rel = (f) => f.replace(ROOT + "/", "");
const tool = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 256 << 20 }); } catch (e) { fail.push(`${cmd} failed: ${e.message.split("\n")[0]}`); return ""; } };

const files = [];
const walk = (d) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
if (existsSync(DIR)) walk(DIR);
const md = files.filter((f) => f.endsWith(".md") && !f.endsWith("HANDBOOK_NOTES.md"));
need(md.length >= 1, "no Markdown sources in docs/handbook");
need(existsSync(join(ROOT, "scripts", "build-handbook.mjs")), "scripts/build-handbook.mjs (the PDF build) is missing");
need(existsSync(join(DIR, "HANDBOOK_NOTES.md")), "docs/handbook/HANDBOOK_NOTES.md is missing");

// The PDF exists, is current, long, illustrated.
let pages = 0, words = 0, raster = 0, text = "";
if (!existsSync(PDF)) fail.push(`${rel(PDF)} is missing`);
else {
  const pdfTime = statSync(PDF).mtimeMs;
  for (const f of files) if (/\.(md|png|svg|css)$/.test(f) && statSync(f).mtimeMs > pdfTime + 1000) fail.push(`${rel(f)} is newer than the PDF; rebuild it`);
  pages = Number(/Pages:\s+(\d+)/.exec(tool("pdfinfo", [PDF]))?.[1] ?? 0);
  text = tool("pdftotext", ["-layout", PDF, "-"]);
  words = text.split(/\s+/).filter((w) => /[A-Za-z]{2,}/.test(w)).length;
  raster = tool("pdfimages", ["-list", PDF]).split("\n").filter((l) => /^\s*\d+\s+\d+\s+image\b/.test(l)).length;
  need(pages >= 60, `PDF has ${pages} pages, needs at least 60`);
  need(words >= 15000, `PDF has ${words} words, needs at least 15000`);
  need(raster >= 35, `PDF embeds ${raster} raster images, needs at least 35`);
  need(/contents/i.test(text.slice(0, 20000)), "PDF has no table of contents near the start");
}

// Images in the sources resolve; enough real screenshots and diagrams.
for (const file of md) {
  for (const m of read(file).matchAll(/(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const [, bang, target] = m;
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    need(existsSync(resolve(dirname(file), decodeURIComponent(target.split("#")[0]))), `${rel(file)}: broken ${bang ? "image" : "link"} ${target}`);
  }
}
const png = files.filter((f) => f.endsWith(".png")), svg = files.filter((f) => f.endsWith(".svg"));
need(png.length >= 35, `${png.length} PNG screenshots under docs/handbook, needs at least 35`);
need(svg.length >= 6, `${svg.length} SVG diagrams under docs/handbook, needs at least 6`);
for (const f of png) { const b = readFileSync(f); need(b.length > 2000 && b.subarray(1, 4).toString() === "PNG", `${rel(f)} is not a real PNG`); }

// Coverage of the PDF text: what a new developer on the team needs.
const topics = [
  /sign in|log in/i, /invit/i, /profile/i, /notification/i, /workspace/i, /project/i, /work item/i, /state/i, /priority/i,
  /assignee/i, /label/i, /due date|target date/i, /estimate/i, /sub-?work item|sub-?issue/i, /relation|blocked by|blocking/i,
  /comment/i, /attachment/i, /mention/i, /layout/i, /kanban|board/i, /spreadsheet/i, /calendar/i, /gantt|timeline/i, /filter/i,
  /cycle/i, /module/i, /\bpages?\b/i, /intake/i, /archiv/i, /keyboard shortcut|command palette|ctrl\s*\+\s*k|cmd\s*\+\s*k/i,
  /git-sync/i, /connect (your )?GitHub|GitHub account/i, /branch/i, /commit/i, /pull request/i, /magic word|closes|fixes/i,
  /smart commit/i, /development panel|development/i, /identifier|[A-Z]{2,}-\d+/, /review/i, /merge/i,
  /troubleshoot/i, /FAQ|frequently asked/i, /glossary/i, /cheat ?sheet|quick reference/i,
];
if (text) for (const re of topics) need(re.test(text), `PDF does not cover ${re}`);

// No secrets or personal data in the PDF text or any text source.
const bad = [/plane_api_[0-9a-f]{8,}/, /plane_wh_[0-9a-f]{8,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bgh[opsu]_[A-Za-z0-9]{20,}/, /github_pat_/,
  /58b72701/, /\b[0-9a-f]{64}\b/, /Iv23li[A-Za-z0-9]+/, /100\.85\.50\.109/, /tasks\.qelal\.et/, /bespo\.et/i, /nathan[a-z.0-9]*@/i,
  /[A-Za-z0-9._%+-]+@(?!example\.(com|org|net)\b)(?!users\.noreply\.github\.com\b)[A-Za-z0-9.-]+\.[a-z]{2,}/];
const sources = [...files.filter((f) => /\.(md|svg|html|css|txt|json)$/.test(f)).map((f) => [rel(f), read(f)]), ["PDF text", text]];
for (const [name, t] of sources) for (const re of bad) need(!re.test(t), `${name} contains something secret or personal (${re})`);

if (fail.length) { console.log(`HANDBOOK CHECK FAILED (${fail.length}):\n - ${fail.join("\n - ")}`); process.exit(1); }
console.log(`HANDBOOK VERIFIED: ${pages} pages, ${words} words, ${raster} embedded images (${png.length} PNG, ${svg.length} SVG sources), ${topics.length} topics covered`);
