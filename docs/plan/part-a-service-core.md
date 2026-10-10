# Part A: Sync Service Core Implementation Plan

### A1 Setup deployment and container
**Files:** docker-compose.override.yaml, deploy/caddy/Caddyfile, src/index.ts
**Depends:** none
**Acceptance:** The service container starts, listens on port 3100, and Caddy proxies traffic to it successfully.

Implement the core deployment structure as defined in the spec (§3). Configure a new `git-sync` container joining the `default` and `gateway` networks. Expose port 3100 and establish a single Caddy route for `/git-sync/*`. Define the incoming webhook URLs for Plane and GitHub.

