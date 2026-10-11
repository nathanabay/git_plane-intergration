# Git Sync Service Deployment Runbook

This runbook is intended to be executed on the live host `convpss` to deploy the git-sync service alongside Plane.

## 1. Backups

First, back up the existing configuration files:
```bash
cp /root/plane/docker-compose.override.yaml /root/plane/docker-compose.override.yaml.bak
cp /root/caddy/Caddyfile /root/caddy/Caddyfile.bak
```

## 2. Build Fork Images

The `git-sync` integration requires the Plane UI to be running from our customized fork images.
From a checkout of this repository on the host, build the fork images first:

```bash
./apps/admin/build-fork-image.sh
./apps/web/build-fork-image.sh
```

Verify that both images now exist locally:
```bash
docker image inspect plane-admin-gitsync:v1.4.2 > /dev/null && echo "Admin OK"
docker image inspect plane-frontend-gitsync:v1.4.2 > /dev/null && echo "Web OK"
```
**Do not proceed** unless both commands succeed, or the `admin` and `web` services will fail to start.

## 3. Build the Service Image

Build the `git-sync:local` backend image:
```bash
docker build -t git-sync:local .
```

## 4. Setup Secrets & Environment

Generate a URL-safe strong password for the git-sync database:
```bash
# We use hex (not base64) because base64 can contain '/' or '+' characters,
# which breaks the postgres connection URL parsing in DATABASE_URL.
export GITSYNC_DB_PASS=$(openssl rand -hex 32)
```

Create the environment file for the git-sync service:
```bash
cp deploy/git-sync.env.example /root/plane/git-sync.env
```
Write the generated database password directly into `git-sync.env` (never echoing it to the terminal):
```bash
sed -i "s/your_generated_db_password/$GITSYNC_DB_PASS/g" /root/plane/git-sync.env
```
Edit `/root/plane/git-sync.env` to fill in all other required secrets (tokens, app IDs, keys). Make sure you also generate a 32-byte base64 key for `GITSYNC_TOKEN_KEY`.

### Place GitHub App Private Key
Create a directory to store the private key, place the file, and restrict its permissions so that only the container's `node` user (uid 1000) can read it:

```bash
mkdir -p /root/plane/git-sync
# ... place your GitHub App private key in /root/plane/git-sync/github-app.pem ...
chown 1000:1000 /root/plane/git-sync/github-app.pem
chmod 400 /root/plane/git-sync/github-app.pem
```

## 5. Create the Database

Apply the initialization SQL to create the `gitsync` role and database. Plane's database superuser is configured via `POSTGRES_USER` in `plane.env`, defaulting to `plane`.

Load the superuser from your environment and run the init script:
```bash
source /root/plane/plane.env
export POSTGRES_USER=${POSTGRES_USER:-plane}

cat deploy/sql/000-create-database.sql | docker compose -f /root/plane/docker-compose.yaml -f /root/plane/docker-compose.override.yaml exec -T plane-db psql -U "$POSTGRES_USER" -v gitsync_password="$GITSYNC_DB_PASS"
```

## 6. Merge Docker Compose Override

Manually merge the provided `docker-compose.override.yaml` fragment into your existing `/root/plane/docker-compose.override.yaml`.

The final shape should include:
```yaml
services:
  # ... existing override services ...
  
  git-sync:
    image: ${GITSYNC_IMAGE:-git-sync:local}
    restart: unless-stopped
    depends_on:
      - plane-db
      - plane-redis
    networks:
      default: {}
      gateway:
        aliases:
          - git-sync
    env_file:
      - path: git-sync.env
        required: false
    volumes:
      - ./git-sync/github-app.pem:/run/secrets/github-app.pem:ro
    healthcheck:
      test: ["CMD", "node", "-e", "http.get('http://127.0.0.1:3100/git-sync/healthz', (res) => { if (res.statusCode === 200) process.exit(0); else process.exit(1); }).on('error', () => process.exit(1))"]
      interval: 30s
      timeout: 10s
      retries: 3

  admin:
    image: ${GITSYNC_ADMIN_IMAGE:-plane-admin-gitsync:v1.4.2}

  web:
    image: ${GITSYNC_WEB_IMAGE:-plane-frontend-gitsync:v1.4.2}

networks:
  gateway:
    external: true
```

Start the new configuration:
```bash
cd /root/plane
docker compose up -d
```

## 7. Update Caddy and Reload

Edit `/root/caddy/Caddyfile` and insert the `handle /git-sync/*` block inside the `tasks.qelal.et` site block, *before* the `reverse_proxy plane-proxy:80` catch-all route.

Shape:
```caddyfile
tasks.qelal.et {
    handle /git-sync/* {
        reverse_proxy git-sync:3100
    }
    reverse_proxy plane-proxy:80
}
```

Validate the Caddyfile configuration before reloading:
```bash
# If running Caddy in docker:
docker compose -f /root/caddy/docker-compose.yml exec caddy caddy validate --config /etc/caddy/Caddyfile
# If running Caddy via systemd:
caddy validate --config /root/caddy/Caddyfile
```

If the configuration is valid, reload Caddy based on how it is deployed on the host:
```bash
# If running Caddy in docker:
docker compose -f /root/caddy/docker-compose.yml exec caddy caddy reload --config /etc/caddy/Caddyfile
# If running Caddy via systemd:
systemctl reload caddy
```

## 8. Register Webhooks & Rate Limiting

Configure the webhooks using the URLs that are now securely exposed:
- **Plane**: `https://tasks.qelal.et/git-sync/webhooks/plane`
- **GitHub**: `https://tasks.qelal.et/git-sync/webhooks/github`

### Rate Limiting Trade-off
Currently, Plane's `plane.env` has `API_KEY_RATE_LIMIT=60/minute`. 
You must decide whether to raise this:
- **Pros of keeping 60/minute**: Protects Plane from burst traffic from git-sync.
- **Cons**: High sync activity (e.g. many PRs merging at once) might hit limits and throttle updates.
- **Trade-off**: Raising the limit to e.g. `600/minute` allows smoother syncing at the cost of potential API load. You can adjust this in `/root/plane/plane.env` based on expected volume.
- **Keep git-sync in step:** git-sync throttles itself with a token bucket set by `PLANE_API_RATE_PER_MINUTE` in `git-sync.env` (default 60). It must equal the `API_KEY_RATE_LIMIT` you chose for Plane (e.g. `API_KEY_RATE_LIMIT=600/minute` goes with `PLANE_API_RATE_PER_MINUTE=600`); otherwise raising Plane's limit changes nothing, or git-sync sends more than Plane accepts.

## 9. Verification

Verify the git-sync service is healthy:
```bash
docker inspect --format='{{json .State.Health.Status}}' plane-git-sync-1
```
Verify the Caddy proxy routes correctly:
```bash
curl -i https://tasks.qelal.et/git-sync/healthz
```
It should return `200 OK` with `{"status":"ok"}`.

## 10. Rollback

If something goes wrong:
```bash
cp /root/plane/docker-compose.override.yaml.bak /root/plane/docker-compose.override.yaml
cp /root/caddy/Caddyfile.bak /root/caddy/Caddyfile
cd /root/plane && docker compose up -d
# Reload Caddy using the respective command (docker or systemctl)
```

## 11. Redelivering webhooks

GitHub does **not** redeliver a webhook that was answered with an error. The service answers `503` to GitHub deliveries
while it cannot read the stored webhook secret (for example the stored App credentials fail to decrypt after a
`GITSYNC_TOKEN_KEY` change), and `/git-sync/api/instance/health` reports `decryptOk: false` in that state. Events that
arrive meanwhile are lost unless redelivered. After fixing the credentials: GitHub → Settings → Developer settings →
GitHub Apps → your App → Advanced → Recent deliveries, and redeliver every delivery marked failed (red) since the problem began.
Redelivery is safe: deliveries are de-duplicated by id and writes are idempotent.
