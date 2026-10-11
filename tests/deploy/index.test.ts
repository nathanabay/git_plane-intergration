import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { startServer, BASE_PATH } from "../../src/index.ts";

function fetchUrl(url: string, method = "GET"): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let body = "";
      res.on("data", (chunk) => body += chunk);
      res.on("end", () => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

test("server starts and healthz returns 200", async () => {
  const server = await startServer({ port: 0 });
  
  const res = await fetchUrl(`http://127.0.0.1:${server.port}${BASE_PATH}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { status: "ok" });
  
  await server.close();
});

test("server returns 404 for unknown routes", async () => {
  const server = await startServer({ port: 0 });
  
  const res = await fetchUrl(`http://127.0.0.1:${server.port}/unknown-route`);
  assert.equal(res.status, 404);
  assert.deepEqual(JSON.parse(res.body), { error: "Not Found" });
  
  await server.close();
});

test("server returns 405 for known route with wrong method", async () => {
  const server = await startServer({ port: 0 });
  
  const res = await fetchUrl(`http://127.0.0.1:${server.port}${BASE_PATH}/healthz`, "POST");
  assert.equal(res.status, 405);
  assert.equal(res.headers.allow, "GET");
  assert.deepEqual(JSON.parse(res.body), { error: "Method Not Allowed" });
  
  await server.close();
});

test("server returns 500 when handler throws", async () => {
  const server = await startServer({
    port: 0,
    routes: [
      {
        method: "GET",
        path: "/crash",
        handler: () => {
          throw new Error("test crash");
        }
      }
    ]
  });
  
  const res = await fetchUrl(`http://127.0.0.1:${server.port}/crash`);
  assert.equal(res.status, 500);
  assert.deepEqual(JSON.parse(res.body), { error: "Internal Server Error" });
  
  await server.close();
});

test("server close releases port", async () => {
  const server = await startServer({ port: 0 });
  const port = server.port;
  await server.close();

  // Try to start on the same port, should succeed if released
  const server2 = await startServer({ port });
  assert.equal(server2.port, port);
  await server2.close();
});

test("server routes custom handlers correctly", async () => {
  const server = await startServer({
    port: 0,
    routes: [
      {
        method: "POST",
        path: "/custom-post",
        handler: (req, res) => {
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ created: true }));
        }
      }
    ]
  });
  
  const res = await fetchUrl(`http://127.0.0.1:${server.port}/custom-post`, "POST");
  assert.equal(res.status, 201);
  assert.deepEqual(JSON.parse(res.body), { created: true });
  
  await server.close();
});
