#!/usr/bin/env node
// Verifies the reviewer produced a real, decidable review rather than praise.
import { readFileSync, existsSync } from "node:fs";

const F = "docs/plan/review-notes.md";
const fail = (m) => { console.error("FAIL: " + m); process.exit(1); };
if (!existsSync(F)) fail(`missing review: ${F}`);
const t = readFileSync(F, "utf8");
if (t.trim().length < 600) fail(`review too short to be substantive (${t.trim().length} bytes)`);

const ph = [...t.matchAll(/\b(TBD|TODO|FIXME|PLACEHOLDER)\b/gi)].map((m) => m[0]);
if (ph.length) fail(`placeholder tokens in review: ${[...new Set(ph)].join(", ")}`);

// An explicit verdict for each authored part
for (const part of ["A", "B"]) {
  if (!new RegExp(`Part\\s+${part}\\b`, "i").test(t)) fail(`review does not address Part ${part}`);
}
// A machine-readable overall verdict
const verdict = t.match(/^VERDICT:\s*(BLOCKING|NON-BLOCKING)\b/m);
if (!verdict) fail("review must contain a line 'VERDICT: BLOCKING' or 'VERDICT: NON-BLOCKING'");

// Findings must cite concrete task ids, and a BLOCKING verdict must list blockers
const cited = [...new Set([...t.matchAll(/\b([AB]\d+)\b/g)].map((m) => m[1]))];
if (cited.length < 3) fail(`review cites only ${cited.length} task ids; it must engage specific tasks`);
if (verdict[1] === "BLOCKING" && !/^\s*-\s+BLOCKER:/m.test(t)) {
  fail("verdict is BLOCKING but no '- BLOCKER:' lines were recorded");
}
console.log(`review verification passed (verdict=${verdict[1]}, ${cited.length} tasks cited)`);
