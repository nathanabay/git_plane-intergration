// Starts a throwaway Postgres 15.7 (the live host's version) in the rootless Docker daemon for
// oracles that boot the real service. Falls back to the default Docker context if no rootless
// socket exists.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const uid = process.getuid?.();
const rootless = uid !== undefined ? `/run/user/${uid}/docker.sock` : null;
const dockerEnv = { ...process.env, ...(rootless && existsSync(rootless) ? { DOCKER_HOST: `unix://${rootless}` } : {}) };
const docker = (args) => spawnSync("docker", args, { encoding: "utf8", env: dockerEnv });

export async function startPostgres() {
  const name = `gitsync-oracle-pg-${process.pid}-${Date.now()}`;
  const run = docker(["run", "-d", "--rm", "--name", name, "-e", "POSTGRES_USER=gitsync", "-e", "POSTGRES_PASSWORD=gitsync-oracle", "-e", "POSTGRES_DB=gitsync",
    "-p", "127.0.0.1::5432", "postgres:15.7-alpine"]);
  if (run.status !== 0) throw new Error(`docker run postgres failed: ${run.stderr.trim()}`);
  const stop = async () => { docker(["rm", "-f", name]); };
  try {
    const port = Number(docker(["port", name, "5432/tcp"]).stdout.trim().split(":").pop());
    // The image's entrypoint runs a temporary init server first, and the rootless port forwarder
    // accepts TCP before anything listens, so only a real login + query proves readiness.
    const pg = (await import("pg")).default;
    const url = `postgres://gitsync:gitsync-oracle@127.0.0.1:${port}/gitsync`;
    for (let i = 0; i < 160; i++) {
      const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
      c.on("error", () => {});
      try { await c.connect(); await c.query("SELECT 1"); await c.end(); await new Promise((r) => setTimeout(r, 300));
        const c2 = new pg.Client({ connectionString: url }); c2.on("error", () => {}); await c2.connect(); await c2.query("SELECT 1"); await c2.end();
        return { url, port, stop };
      } catch { try { await c.end(); } catch {} }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("postgres did not become ready");
  } catch (e) { await stop(); throw e; }
}
