# Part A: Sync Service Core Implementation Plan

### A1 Setup deployment and container
**Files:** docker-compose.override.yaml, deploy/caddy/Caddyfile, src/index.ts
**Depends:** none
**Acceptance:** The service container starts, listens on port 3100, and Caddy proxies traffic to it successfully.

Implement the core deployment structure as defined in the spec (§3). Configure a new `git-sync` container joining the `default` and `gateway` networks. Expose port 3100 and establish a single Caddy route for `/git-sync/*`. Define the incoming webhook URLs for Plane and GitHub.

### A2 Build service internals and queues
**Files:** src/queue/index.ts, src/api/handler.ts, package.json
**Depends:** A1
**Acceptance:** Incoming requests are signature-verified and placed onto BullMQ queues without synchronous processing.

Construct the TypeScript service foundation (§4). Integrate `@octokit/webhooks` for GitHub signature validation and explicitly implement HMAC-SHA256 verification of `X-Plane-Signature` for Plane webhooks. Implement `@octokit/app` for installation-token minting and refresh. Establish four separate BullMQ queues on the existing Valkey instance: `inbound:github`, `inbound:plane`, `outbound:plane`, and `outbound:github`. Ensure the HTTP request handler strictly validates signatures, enqueues the payload, and immediately responds with a 200 OK.

