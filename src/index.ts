import * as http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

export const DEFAULT_PORT = 3100;
export const BASE_PATH = "/git-sync";
export const WEBHOOK_PATHS = {
  plane: "/git-sync/webhooks/plane",
  github: "/git-sync/webhooks/github"
} as const;

export type RouteHandler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>) => void | Promise<void>;

export interface Route {
  method: string;
  path: string;
  handler: RouteHandler;
}

export interface StartOptions {
  port?: number;
  host?: string;
  routes?: Route[];
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

function parseRoute(path: string) {
  const segments = path.split('/').filter(Boolean);
  let isPrefix = false;
  if (segments.length > 0 && segments[segments.length - 1] === '*') {
    isPrefix = true;
    segments.pop();
  }
  let literalCount = 0;
  let isExact = !isPrefix;
  for (const s of segments) {
    if (s.startsWith(':')) isExact = false;
    else literalCount++;
  }
  return { path, segments, isPrefix, literalCount, isExact };
}

export function startServer(opts?: StartOptions): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    const port = opts?.port ?? DEFAULT_PORT;
    const host = opts?.host ?? "0.0.0.0";
    const userRoutes = opts?.routes ?? [];

    const routeMap = new Map<string, Map<string, RouteHandler>>();
    const parsedRoutesMap = new Map<string, ReturnType<typeof parseRoute>>();

    const healthMap = new Map<string, RouteHandler>();
    healthMap.set("GET", (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });
    routeMap.set(BASE_PATH + "/healthz", healthMap);
    parsedRoutesMap.set(BASE_PATH + "/healthz", parseRoute(BASE_PATH + "/healthz"));

    for (const route of userRoutes) {
      if (!routeMap.has(route.path)) {
        routeMap.set(route.path, new Map());
        parsedRoutesMap.set(route.path, parseRoute(route.path));
      }
      routeMap.get(route.path)!.set(route.method, route.handler);
    }

    const server = http.createServer(async (req, res) => {
      try {
        const url = req.url?.split("?")[0] || "/";
        const method = req.method || "GET";

        const rawSegments = url.split('/').filter(Boolean);
        let hasDotDot = false;
        const reqSegments = rawSegments.map(s => {
          const dec = decodeURIComponent(s);
          if (dec === '..') hasDotDot = true;
          return dec;
        });

        if (hasDotDot) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Bad Request" }));
          return;
        }

        const matches: { routePath: string; parsed: ReturnType<typeof parseRoute>; params: Record<string, string> }[] = [];

        for (const [routePath, parsed] of parsedRoutesMap) {
          let matched = true;
          const params: Record<string, string> = {};

          if (parsed.isPrefix) {
            if (reqSegments.length < parsed.segments.length) matched = false;
            else {
              for (let i = 0; i < parsed.segments.length; i++) {
                const seg = parsed.segments[i]!;
                const reqSeg = reqSegments[i]!;
                if (seg.startsWith(':')) {
                  params[seg.slice(1)] = reqSeg;
                } else if (seg !== reqSeg) {
                  matched = false;
                  break;
                }
              }
              if (matched) {
                params['*'] = reqSegments.slice(parsed.segments.length).join('/');
              }
            }
          } else {
            if (reqSegments.length !== parsed.segments.length) matched = false;
            else {
              for (let i = 0; i < parsed.segments.length; i++) {
                const seg = parsed.segments[i]!;
                const reqSeg = reqSegments[i]!;
                if (seg.startsWith(':')) {
                  params[seg.slice(1)] = reqSeg;
                } else if (seg !== reqSeg) {
                  matched = false;
                  break;
                }
              }
            }
          }

          if (matched) {
            matches.push({ routePath, parsed, params });
          }
        }

        if (matches.length === 0) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not Found" }));
          return;
        }

        matches.sort((a, b) => {
          if (a.parsed.isExact !== b.parsed.isExact) return a.parsed.isExact ? -1 : 1;
          return b.parsed.literalCount - a.parsed.literalCount;
        });

        const bestMatch = matches[0]!;
        const pathMethods = routeMap.get(bestMatch.routePath)!;
        const handler = pathMethods.get(method);

        if (!handler) {
          const allowed = Array.from(pathMethods.keys()).join(", ");
          res.writeHead(405, { "Allow": allowed, "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Method Not Allowed" }));
          return;
        }

        await handler(req, res, bestMatch.params);
      } catch (err) {
        console.error("Internal Server Error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal Server Error" }));
        }
      }
    });

    server.on("error", reject);

    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = address && typeof address === "object" ? address.port : port;
      resolve({
        port: actualPort,
        close: () => new Promise<void>((resClose, rejClose) => {
          server.close((err) => {
            if (err) rejClose(err);
            else resClose();
          });
        })
      });
    });
  });
}

// @ts-ignore - import.meta.main is available in node 24 ts type stripping
if (import.meta.main) {
  // Composition lives in src/app so it can be tested; importing this module has no side effects.
  const { runService } = await import("./app/main.ts");
  runService(process.env, { startServer: (opts) => startServer(opts) }).then((service) => {
    const shutdown = async () => {
      await service.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }).catch((err) => {
    console.error("Failed to start server", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
