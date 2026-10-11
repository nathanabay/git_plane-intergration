import test from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import { createHmac } from "node:crypto";
import * as http from "node:http";
import { startServer, WEBHOOK_PATHS } from "../../src/index.ts";
import { createWebhookRoutes } from "../../src/api/handler.ts";
import type { InboundJob } from "../../src/queue/index.ts";

async function withServer(maxBodyBytes: number, fn: (port: number, jobs: InboundJob[]) => Promise<void>) {
  const jobs: InboundJob[] = [];
  const routes = createWebhookRoutes({ planeSecret: "ps", githubSecret: "gs", maxBodyBytes, enqueue: async (j) => { jobs.push(j); } });
  const srv = await startServer({ port: 0, host: "127.0.0.1", routes });
  try { await fn(srv.port, jobs); } finally { await srv.close(); }
}

test("handler: a signed plane event is queued", async () => {
  await withServer(1024, async (port, jobs) => {
    const body = JSON.stringify({ a: 1 });
    const sig = createHmac("sha256", "ps").update(body).digest("hex");
    const r = await fetch(`http://127.0.0.1:${port}${WEBHOOK_PATHS.plane}`, { method: "POST", body, headers: { "x-plane-signature": sig, "x-plane-delivery": "d1", "x-plane-event": "issue" } });
    strictEqual(r.status, 200);
    strictEqual(jobs.length, 1);
  });
});

test("handler: a bad signature is 401 and nothing is queued", async () => {
  await withServer(1024, async (port, jobs) => {
    const r = await fetch(`http://127.0.0.1:${port}${WEBHOOK_PATHS.plane}`, { method: "POST", body: "{}", headers: { "x-plane-signature": "00", "x-plane-delivery": "d1", "x-plane-event": "issue" } });
    strictEqual(r.status, 401);
    strictEqual(jobs.length, 0);
  });
});

test("handler: an oversized declared body is 413", async () => {
  await withServer(64, async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}${WEBHOOK_PATHS.plane}`, { method: "POST", body: "x".repeat(500), headers: { "x-plane-delivery": "d", "x-plane-event": "issue" } });
    strictEqual(r.status, 413);
  });
});

test("handler: an oversized streamed body gets 413 and the connection is dropped, not drained", async () => {
  await withServer(64, async (port) => {
    const result = await new Promise<{ status: number; closed: boolean; sent: number }>((resolve, reject) => {
      let sent = 0;
      let status = 0;
      const req = http.request({ host: "127.0.0.1", port, method: "POST", path: WEBHOOK_PATHS.github, headers: { "transfer-encoding": "chunked" } });
      req.on("response", (res) => { status = res.statusCode ?? 0; res.resume(); });
      req.on("error", () => { /* reset by the server is the expected outcome */ });
      req.on("close", () => resolve({ status, closed: true, sent }));
      const chunk = Buffer.alloc(16 * 1024, 1);
      const pump = () => {
        if (req.destroyed) return;
        if (sent > 256 * 1024 * 1024) { req.destroy(); reject(new Error("server kept consuming 256 MiB")); return; }
        sent += chunk.length;
        if (req.write(chunk)) setImmediate(pump); else req.once("drain", pump);
      };
      pump();
    });
    ok(result.closed);
    strictEqual(result.status, 413);
    ok(result.sent < 64 * 1024 * 1024, `client managed to send ${result.sent} bytes`);
  });
});
