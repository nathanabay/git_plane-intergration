// Starts a throwaway Valkey for oracles and tests. Uses VALKEY_SERVER, else the locally built
// ~/.cache/gitsync/bin/valkey-server (7.2.11, matching the live host), else valkey-server/redis-server on PATH.
import { spawn, spawnSync } from "node:child_process";
import { createServer, connect } from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function findServer() {
  const candidates = [process.env.VALKEY_SERVER, join(homedir(), ".cache", "gitsync", "bin", "valkey-server")].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  for (const name of ["valkey-server", "redis-server"]) {
    const r = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

const freePort = () => new Promise((ok, no) => { const s = createServer(); s.once("error", no); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const canConnect = (port) => new Promise((ok) => { const c = connect(port, "127.0.0.1"); c.once("connect", () => { c.destroy(); ok(true); }); c.once("error", () => ok(false)); });

export async function startValkey() {
  const bin = findServer();
  if (!bin) throw new Error("no valkey-server found; set VALKEY_SERVER or build one into ~/.cache/gitsync/bin");
  const port = await freePort();
  const child = spawn(bin, ["--port", String(port), "--bind", "127.0.0.1", "--save", "", "--appendonly", "no"], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) { if (await canConnect(port)) break; await new Promise((r) => setTimeout(r, 50)); }
  if (!(await canConnect(port))) { child.kill("SIGKILL"); throw new Error("valkey did not start"); }
  return { url: `redis://127.0.0.1:${port}`, port, stop: () => new Promise((r) => { child.once("exit", r); child.kill("SIGTERM"); }) };
}
