import { createHmac, timingSafeEqual } from "node:crypto";
import { verify } from "@octokit/webhooks-methods";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Route } from "../index.ts";
import type { InboundJob } from "../queue/index.ts";

export interface WebhookDeps {
  planeSecret: string;
  /** A string, or a function read per delivery so a rotated secret applies without a restart (F6). */
  githubSecret: string | (() => Promise<string>);
  enqueue(job: InboundJob): Promise<void>;
  maxBodyBytes?: number;
}

const PLANE_CATALOG = ["project", "issue", "module", "module_issue", "cycle", "cycle_issue", "issue_comment"];

export function createWebhookRoutes(deps: WebhookDeps): Route[] {
  const maxBytes = deps.maxBodyBytes ?? 25 * 1024 * 1024;

  const readBody = (req: IncomingMessage): Promise<Buffer> => {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) {
        reject(new Error("PayloadTooLarge"));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      const onData = (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          // Stop consuming: nothing further is buffered or read from this client.
          req.off("data", onData);
          req.pause();
          chunks.length = 0;
          reject(new Error("PayloadTooLarge"));
          return;
        }
        chunks.push(chunk);
      };
      req.on("data", onData);
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  };

  // 413 then drop the connection once the response is flushed, so the client cannot keep streaming.
  const rejectTooLarge = (req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(413, { "Content-Type": "application/json", Connection: "close" });
    res.end(JSON.stringify({ error: "Payload Too Large" }), () => req.destroy());
  };

  const handlePlane = async (req: IncomingMessage, res: ServerResponse) => {
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (err: any) {
      if (err.message === "PayloadTooLarge") {
        rejectTooLarge(req, res);
        return;
      }
      throw err;
    }

    const deliveryId = req.headers["x-plane-delivery"];
    const event = req.headers["x-plane-event"];
    const signature = req.headers["x-plane-signature"];

    if (!deliveryId || !event || typeof deliveryId !== "string" || typeof event !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing delivery or event headers" }));
      return;
    }

    if (!signature || typeof signature !== "string") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing signature" }));
      return;
    }

    const expectedSig = createHmac("sha256", deps.planeSecret).update(body).digest("hex");
    if (signature.length !== expectedSig.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid signature" }));
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf-8"));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    if (!PLANE_CATALOG.includes(event)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ignored: true }));
      return;
    }

    try {
      await deps.enqueue({
        source: "plane",
        deliveryId,
        event,
        receivedAt: new Date().toISOString(),
        payload
      });
    } catch (err) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Service Unavailable" }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ queued: true }));
  };

  const handleGithub = async (req: IncomingMessage, res: ServerResponse) => {
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (err: any) {
      if (err.message === "PayloadTooLarge") {
        rejectTooLarge(req, res);
        return;
      }
      throw err;
    }

    const deliveryId = req.headers["x-github-delivery"];
    const event = req.headers["x-github-event"];
    const signature = req.headers["x-hub-signature-256"];

    if (!deliveryId || !event || typeof deliveryId !== "string" || typeof event !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing delivery or event headers" }));
      return;
    }

    if (!signature || typeof signature !== "string") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing signature" }));
      return;
    }

    // F15: when the stored secret cannot be read or decrypted there is nothing safe to verify against, so answer 503.
    // GitHub does NOT redeliver failed webhooks by itself: events arriving meanwhile are lost until an operator redelivers
    // them from the App's "Recent deliveries" page (deploy/APPLY.md, "Redelivering webhooks").
    let secret: string;
    try {
      secret = typeof deps.githubSecret === "function" ? await deps.githubSecret() : deps.githubSecret;
    } catch {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Webhook credentials unavailable" }));
      return;
    }
    const isValid = await verify(secret, body.toString("utf-8"), signature);
    if (!isValid) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid signature" }));
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf-8"));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    if (event === "ping") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ignored: true }));
      return;
    }

    try {
      await deps.enqueue({
        source: "github",
        deliveryId,
        event,
        receivedAt: new Date().toISOString(),
        payload
      });
    } catch (err) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Service Unavailable" }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ queued: true }));
  };

  return [
    { method: "POST", path: "/git-sync/webhooks/plane", handler: handlePlane },
    { method: "POST", path: "/git-sync/webhooks/github", handler: handleGithub }
  ];
}
