#!/usr/bin/env node
// Verifies an implementation review is decidable and grounded, not an opinion.
// usage: node scripts/verify-impl-review.mjs <review.md> [<previous-review.md>] [--clean]
//   --clean additionally requires the review to have no open BLOCKING or MAJOR finding.
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const wantClean = args.includes("--clean");
const [file, prev] = args.filter((a) => a !== "--clean");
const fails = [];
const fail = (m) => fails.push(m);
if (!file || !existsSync(join(root, file))) { console.error(`FAIL: missing review ${file}`); process.exit(1); }
const t = readFileSync(join(root, file), "utf8");
const spec = readFileSync(join(root, "docs/superpowers/specs/2026-10-10-plane-github-sync-design.md"), "utf8");
const sections = new Set([...spec.matchAll(/^#{2,3}\s+(\d+(?:\.\d+)?)[.\s]/gm)].map((m) => m[1]));

if (t.trim().length < 1500) fail(`review too short to be substantive (${t.trim().length} bytes)`);
const ph = [...t.matchAll(/\b(TBD|TODO|FIXME|PLACEHOLDER)\b/g)].map((m) => m[0]);
if (ph.length) fail(`placeholder tokens: ${[...new Set(ph)].join(", ")}`);

const verdict = t.match(/^VERDICT:\s*(BLOCKING|NON-BLOCKING)\s*$/m)?.[1];
if (!verdict) fail("missing a line 'VERDICT: BLOCKING' or 'VERDICT: NON-BLOCKING'");

const TASKS = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9"];
for (const id of TASKS) if (!new RegExp(`^- ${id}: (PASS|FINDINGS)\\b`, "m").test(t)) fail(`no task verdict line '- ${id}: PASS|FINDINGS'`);

const blocks = t.split(/^### /m).slice(1).filter((b) => /^F\d+\s+\[/.test(b));
const open = { BLOCKING: 0, MAJOR: 0, MINOR: 0 };
for (const b of blocks) {
  const head = b.match(/^(F\d+)\s+\[(BLOCKING|MAJOR|MINOR)\]\s+\S/);
  if (!head) { fail(`malformed finding heading: ${b.split("\n")[0]}`); continue; }
  const [, id, sev] = head;
  open[sev]++;
  const loc = b.match(/^File:\s*(\S+?):(\d+)\s*$/m);
  if (!loc) fail(`${id}: no 'File: path:line'`);
  else {
    const p = join(root, loc[1]);
    if (!existsSync(p)) fail(`${id}: cited file ${loc[1]} does not exist`);
    else if (Number(loc[2]) < 1 || Number(loc[2]) > readFileSync(p, "utf8").split("\n").length) fail(`${id}: line ${loc[2]} is outside ${loc[1]}`);
  }
  const s = b.match(/^Spec:\s*(.+)$/m)?.[1] ?? "";
  const cites = [...s.matchAll(/§(\d+(?:\.\d+)?)/g)].map((m) => m[1]);
  if (!cites.length) fail(`${id}: no 'Spec: §N' line`);
  for (const c of cites) if (!sections.has(c)) fail(`${id}: cites §${c}, which is not a spec section`);
  if (!/^Fix:\s*\S/m.test(b)) fail(`${id}: no 'Fix:' line`);
  if (!/^Evidence:\s*\S/m.test(b)) fail(`${id}: no 'Evidence:' line`);
}
if (verdict === "BLOCKING" && open.BLOCKING + open.MAJOR === 0) fail("verdict BLOCKING but no BLOCKING or MAJOR finding");
if (verdict === "NON-BLOCKING" && open.BLOCKING + open.MAJOR > 0) fail(`verdict NON-BLOCKING with ${open.BLOCKING} BLOCKING and ${open.MAJOR} MAJOR findings open`);

if (prev) {
  if (!existsSync(join(root, prev))) fail(`previous review ${prev} missing`);
  else {
    const pt = readFileSync(join(root, prev), "utf8");
    const prevIds = [...pt.matchAll(/^### (F\d+)\s+\[(BLOCKING|MAJOR|MINOR)\]/gm)].map((m) => m[1]);
    for (const id of prevIds) {
      const line = t.match(new RegExp(`^- prev ${id}: (CLOSED|STILL OPEN) — "(.{8,})"`, "m"));
      if (!line) fail(`previous finding ${id} not adjudicated as '- prev ${id}: CLOSED|STILL OPEN — "<quoted code or text>"'`);
    }
  }
}
if (wantClean && open.BLOCKING + open.MAJOR > 0) fail(`not clean: ${open.BLOCKING} BLOCKING, ${open.MAJOR} MAJOR open`);

if (fails.length) { for (const f of fails) console.error("FAIL: " + f); process.exit(1); }
console.log(`implementation review verification passed (verdict=${verdict}, ${blocks.length} findings: ${open.BLOCKING} blocking, ${open.MAJOR} major, ${open.MINOR} minor)`);
