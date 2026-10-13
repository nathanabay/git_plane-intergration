#!/usr/bin/env node
// Runs the end-to-end scenarios against the test Plane and the test repository.
//   node scripts/e2e/run.mjs [--only S01,S14] [--keep] [--list] [--timeout <seconds>]
// Writes docs/impl/e2e-runs/<runId>.md and .json; exits non-zero when any scenario FAILs.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cfg, registry } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const value = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

const only = value("--only")?.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
const keep = flag("--keep");
const defaultTimeout = Number(value("--timeout") ?? 300) * 1000;

const scenarioDir = join(here, "scenarios");
for (const file of readdirSync(scenarioDir).filter((f) => f.endsWith(".mjs")).sort()) {
  await import(pathToFileURL(join(scenarioDir, file)).href);
}
const byId = (a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1));
const all = [...registry].sort(byId);

if (flag("--list")) {
  for (const s of all) console.log(`${s.id}  ${s.title}${s.defect ? `  (known defect ${s.defect})` : ""}`);
  process.exit(0);
}
if (only) {
  const unknown = only.filter((id) => !all.some((s) => s.id === id));
  if (unknown.length) { console.error(`unknown scenario(s): ${unknown.join(", ")}`); process.exit(2); }
}
const selected = only ? all.filter((s) => only.includes(s.id)) : all;

const redact = (text) => String(text)
  .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted]")
  .replace(/plane_api_[A-Za-z0-9]+/g, "[redacted]")
  .replace(/(session-id|admin-session-id|csrftoken)=[^;\s"]+/g, "$1=[redacted]");

const results = [];
const startedAt = new Date();
console.log(`e2e run ${cfg.runId} — ${selected.length} scenario(s) against ${cfg.planeUrl} and ${cfg.repo}${keep ? " (--keep)" : ""}`);

for (const s of selected) {
  const t0 = Date.now();
  const logs = [];
  const evidence = [];
  const cleanups = [];
  let defect = s.defect;
  const ctx = {
    id: s.id,
    log: (...m) => { const line = redact(m.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); logs.push(line); console.log(`  ${s.id} │ ${line}`); },
    evidence: (label, val) => { evidence.push({ label: redact(label), value: val === undefined ? undefined : redact(typeof val === "string" ? val : JSON.stringify(val)) }); },
    cleanup: (fn) => { cleanups.push(fn); },
    skip: (reason) => { throw Object.assign(new Error(reason), { skip: true }); },
    defect: (id) => { defect = id; },
  };
  let status = "PASS", error;
  let timer;
  try {
    await Promise.race([
      s.fn(ctx),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`scenario timeout after ${(s.timeout ?? defaultTimeout) / 1000}s`)), s.timeout ?? defaultTimeout); }),
    ]);
  } catch (e) {
    if (e?.skip) { status = "SKIP"; error = e.message; }
    else { status = "FAIL"; error = e?.stack?.split("\n").slice(0, 3).join(" | ") ?? String(e); }
  } finally { clearTimeout(timer); }
  const cleanupErrors = [];
  if (!keep) {
    for (const fn of cleanups.reverse()) {
      try { await fn(); } catch (e) { cleanupErrors.push(e?.message ?? String(e)); }
    }
  }
  const r = { id: s.id, title: s.title, status, ...(status === "FAIL" && defect ? { knownDefect: defect } : {}),
    ...(error ? { error: redact(error) } : {}), seconds: Math.round((Date.now() - t0) / 100) / 10,
    evidence, log: logs, ...(cleanupErrors.length ? { cleanupErrors: cleanupErrors.map(redact) } : {}), cleaned: !keep };
  results.push(r);
  console.log(`${status === "PASS" ? "✓" : status === "SKIP" ? "-" : "✗"} ${s.id} ${status}${r.knownDefect ? ` (known ${r.knownDefect})` : ""} ${s.title} [${r.seconds}s]${error ? `\n    ${r.error}` : ""}${cleanupErrors.length ? `\n    cleanup errors: ${r.cleanupErrors.join(" | ")}` : ""}`);
}

const counts = { PASS: 0, FAIL: 0, SKIP: 0 };
for (const r of results) counts[r.status]++;
const knownFails = results.filter((r) => r.status === "FAIL" && r.knownDefect).length;

mkdirSync(cfg.outDir, { recursive: true });
const report = { runId: cfg.runId, startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), planeUrl: cfg.planeUrl,
  repo: cfg.repo, only: only ?? null, keep, counts, knownFails, results };
writeFileSync(join(cfg.outDir, `${cfg.runId}.json`), JSON.stringify(report, null, 2) + "\n");

const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const md = [
  `# E2E run ${cfg.runId}`, "",
  `Started ${report.startedAt}, finished ${report.finishedAt}. Plane ${cfg.planeUrl}, repository \`${cfg.repo}\`.` +
    `${only ? ` Selected: ${only.join(", ")}.` : ""}${keep ? " Objects kept (--keep)." : " Created objects cleaned up."}`, "",
  `**${counts.PASS} PASS, ${counts.FAIL} FAIL${knownFails ? ` (${knownFails} known defect)` : ""}, ${counts.SKIP} SKIP**`, "",
  "| Id | Scenario | Result | Evidence |", "|---|---|---|---|",
  ...results.map((r) => `| ${r.id} | ${cell(r.title)} | ${r.status === "FAIL" ? `**FAIL**${r.knownDefect ? ` (${r.knownDefect})` : ""}` : r.status} | ${cell(
    r.status === "PASS" ? r.evidence.map((e) => (e.value === undefined ? e.label : `${e.label}: ${e.value}`)).join("; ").slice(0, 600) : r.error)} |`),
  "", "## Evidence", "",
  ...results.flatMap((r) => [`### ${r.id} — ${r.title} (${r.status})`, "",
    ...(r.error ? [`- error: ${r.error}`] : []),
    ...r.evidence.map((e) => `- ${e.label}${e.value === undefined ? "" : `: \`${String(e.value).replace(/`/g, "'").slice(0, 2000)}\``}`),
    ...(r.cleanupErrors ? r.cleanupErrors.map((e) => `- cleanup error: ${e}`) : []),
    ...(r.log.length ? ["", "<details><summary>log</summary>", "", "```", ...r.log, "```", "", "</details>"] : []), ""]),
];
writeFileSync(join(cfg.outDir, `${cfg.runId}.md`), md.join("\n") + "\n");
console.log(`\n${counts.PASS} PASS, ${counts.FAIL} FAIL${knownFails ? ` (${knownFails} known)` : ""}, ${counts.SKIP} SKIP → docs/impl/e2e-runs/${cfg.runId}.md`);
process.exit(counts.FAIL ? 1 : 0);
