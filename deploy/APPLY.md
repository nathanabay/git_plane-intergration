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

### GitHub App registration

Register the App on the selected GitHub host and install it on the accounts/repositories that will be mapped. A GitHub Enterprise Server requires an App registered on that Server; an App registered on GitHub.com cannot be installed there. [GHES registration and URLs](https://docs.github.com/en/apps/creating-github-apps/setting-up-a-github-app/making-your-github-app-available-for-github-enterprise-server) (Context7 `/websites/github_en`). One App and one edition serve this Plane service instance.

Set these App permissions:

| Scope | Permission | Access | Purpose |
| --- | --- | --- | --- |
| Repository | Pull requests | Read & write | PR lifecycle, links and comments |
| Repository | Issues | Read & write | Issue mirrors, labels, assignees and comments |
| Repository | Contents | Read & write | Commits, branches and branch-reference writes |
| Repository | Checks | Read | Check runs and check suites |
| Repository | **Commit statuses** | **Read** | Combined status and the `status` webhook |
| Repository | Deployments | Read | Deployments, statuses and preview URLs |
| Repository | Metadata | Read | Repository metadata and installation access checks |
| Organization | Members | Read | Organization membership access |
| Repository, only with autolinks enabled | Administration | Read & write | Manage autolink references |

[GitHub App permission reference](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps) and [autolinks](https://docs.github.com/en/rest/repos/autolinks) (Context7 `/websites/github_en_rest`). Checks does not grant Commit statuses access. After adding permissions, verify acceptance on the installation as well as the App registration; pending approvals mean the old grant still applies. Enterprise-owned App changes have automatic-acceptance exceptions. [Permission updates](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration) (Context7 `/github/docs`).

Enable **Active** under Webhook, use `<PUBLIC_ORIGIN>/git-sync/webhooks/github`, and enter the same webhook secret as `GITHUB_WEBHOOK_SECRET`. Under **Subscribe to events**, select:

```text
pull_request
pull_request_review
push
issues
issue_comment
check_suite
check_run
status
deployment_status
```

`installation` and `installation_repositories` are delivered automatically and cannot be selected manually. With Checks: Read, consume suite completions; suite `requested` and `rerequested` require Checks: Write and are not prerequisites for this service. [Event subscriptions](https://docs.github.com/en/webhooks/webhook-events-and-payloads) (Context7 `/websites/github_en`). The list above follows `src/app/reducers.ts` and is also maintained in [apps/README.md](../apps/README.md#github-app-webhook-events).

### OAuth and installation return URLs (parity C0)

Copy the App's **Client ID**, generate a **Client secret**, and record the **App slug** from its public link. The Client ID is separate from the numeric App ID. Optional environment bootstrap names are `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `GITHUB_APP_SLUG`; the client ID and secret must be supplied together. Keep the secret in the server environment until wave 2 stores it encrypted with the App settings; it is never a browser configuration value. [GitHub App user authorization](https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/building-a-login-with-github-button-with-a-github-app) (Context7 `/websites/github_en`).

Configure these registration values when the wave 2 callback handlers are deployed:

| App setting | Value |
| --- | --- |
| Callback URL (`callback_urls[]`) | `<PUBLIC_ORIGIN>/git-sync/oauth/github/callback` |
| Setup URL (`setup_url`) | `<PUBLIC_ORIGIN>/git-sync/install/github/callback` |
| Redirect on update (`setup_on_update`) | Enabled |
| Request user authorization during installation (`request_oauth_on_install`) | Disabled |

For `PUBLIC_ORIGIN=https://tasks.qelal.et`, the URLs are `https://tasks.qelal.et/git-sync/oauth/github/callback` and `https://tasks.qelal.et/git-sync/install/github/callback`. They point to this service, including when GitHub is Enterprise Cloud or Server. OAuth-on-install must stay off: enabling it makes Setup URL unavailable and sends the user to the OAuth callback instead. [App registration parameters](https://docs.github.com/en/apps/creating-github-apps/setting-up-a-github-app/creating-a-github-app-using-url-parameters) (Context7 `/websites/github_en`). Wave 1 supplies the pure URL builders and bootstrap parser; installation state verification, OAuth exchange/refresh and the UI are wave 2 work.

### GitHub edition and environment bootstrap

| Edition | Environment input | Derived REST API base | Derived web origin |
| --- | --- | --- | --- |
| GitHub.com | `GITHUB_EDITION=github` or no host variables | `https://api.github.com` | `https://github.com` |
| Enterprise Cloud with data residency | `GITHUB_EDITION=ghe_cloud`, `GITHUB_GHE_SUBDOMAIN=octocorp` | `https://api.octocorp.ghe.com` | `https://octocorp.ghe.com` |
| Enterprise Server | `GITHUB_EDITION=ghes`, `GITHUB_GHES_BASE_URL=https://ghe.example.com` | `https://ghe.example.com/api/v3` | `https://ghe.example.com` |

Cloud takes a single subdomain label, not a full hostname. Server takes a plain HTTPS origin (a port is allowed); a legacy `/api/v3` suffix is normalized, not doubled. OAuth authorization, OAuth token exchange and App installation URLs use the **web** origin with paths `/login/oauth/authorize`, `/login/oauth/access_token` and `/apps/<app-slug>/installations/new`. Cloud's API has no `/api/v3` suffix. [ghe.com domains](https://docs.github.com/en/get-started/learning-about-github/about-versions-of-github-docs), [GHES API/OAuth URLs](https://docs.github.com/en/apps/creating-github-apps/setting-up-a-github-app/making-your-github-app-available-for-github-enterprise-server) (Context7 `/websites/github_en`).

`GITHUB_API_BASE_URL` remains supported for existing deployments: when `GITHUB_EDITION` is unset, an API URL such as `https://ghe.example.com/api/v3` or `https://api.octocorp.ghe.com` infers the edition and web host. If both old and new inputs are set, they must agree; startup rejects a mismatch. `GITHUB_WEB_ORIGIN` is derived output, not a configurable override. Stored App credentials continue to take precedence over environment bootstrap; the stored edition/host selector and use of these URL builders are wave 2 integration work. See [the example environment file](git-sync.env.example).

### Place GitHub App Private Key
Create a directory to store the private key, place the file, and restrict its permissions so that only the container's `node` user (uid 1000) can read it:

```bash
mkdir -p /root/plane/git-sync
# ... place your GitHub App private key in /root/plane/git-sync/github-app.pem ...
chown 1000:1000 /root/plane/git-sync/github-app.pem
chmod 400 /root/plane/git-sync/github-app.pem

# Persistent state is written by the non-root node user; preserve this directory on upgrades.
install -d -m 700 -o 1000 -g 1000 /root/plane/git-sync/credential-state
```

`GITHUB_CREDENTIAL_MARKER_PATH` points inside that writable bind mount, separately from the read-only
PEM secret. Keep the mount and marker across container recreation and include them in backups. A marker
write failure refuses credential verification instead of claiming durable retirement. On a cold database
outage the verifier answers 503 even when the marker is missing: absence cannot establish that bootstrap
credentials were never retired. Bootstrap credentials are available only after a successful database
check confirms both the config row and retirement state are absent. Migration 008 records retirement
atomically on every credential save, protecting a save followed by restart before the first source read.

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
    environment:
      GITHUB_CREDENTIAL_MARKER_PATH: /var/lib/gitsync/credentials/bootstrap-retired
    volumes:
      - ./git-sync/github-app.pem:/run/secrets/github-app.pem:ro
      - ./git-sync/credential-state:/var/lib/gitsync/credentials
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
- **Keep git-sync in step:** git-sync throttles itself, never sending more than `PLANE_API_RATE_PER_MINUTE` requests in any 60-second window (the same sliding window Plane enforces), with short bursts of at most 10. The limit is in `git-sync.env` (default 60). It must equal the `API_KEY_RATE_LIMIT` you chose for Plane (e.g. `API_KEY_RATE_LIMIT=600/minute` goes with `PLANE_API_RATE_PER_MINUTE=600`); otherwise raising Plane's limit changes nothing, or git-sync sends more than Plane accepts.

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

Also verify the App registration and installed grant against the permissions/events in [GitHub App registration](#github-app-registration). `GET /app` with an App JWT returns `permissions`, `events`, `slug` and `client_id`; installation permissions can be inspected with the App's installation endpoints. This verifies the App registration separately from installation-owner approval. [App API](https://docs.github.com/en/rest/apps/apps) (Context7 `/websites/github_en_rest`). Check Recent deliveries after a real issue/PR change to confirm the GitHub webhook URL and secret; check that Plane deliveries reach the corresponding endpoint as described in §12. The in-product live setup checklist is wave 2 work.

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

## 12. Plane webhook: delivery, a disabled webhook, and rotating its secret

Plane v1.4.2 retries a delivery only when it cannot connect (or times out); any HTTP answer, error or not, ends that
delivery and nothing resends it. The service therefore answers `2xx` once a Plane delivery is queued, or, when the queue
(Redis) is down, once it is kept in Postgres (`inbound_spool`). A maintenance job queues the kept deliveries again every
minute once the queue is back. A Plane delivery is lost only when Redis and Postgres are both unavailable (answer `503`)
or when its signature does not match (answer `401`).

### Re-enabling a webhook Plane disabled

If the service is unreachable for the whole retry window (5 attempts, about 30 to 50 minutes), Plane switches the
webhook off and emails its creator. From then on Plane sends nothing, and Plane→GitHub sync stops.

The reconcile sweep watches for this. When a mapped Plane project has changes older than 30 minutes that are newer
than the last Plane delivery (plus 30 minutes), the service logs
`Plane webhook looks disabled or failing: Plane changes are not arriving as deliveries` once and writes a
`plane_webhook_silent` row to the audit log (`detail` holds the newest change and the last delivery). A
`plane_webhook_recovered` row follows when deliveries arrive again. The check runs with the sweep, so it can take one
`reconciliation_interval_minutes` (default 60) to notice.

To recover:
1. Fix whatever made the service unreachable and check `curl -i https://tasks.qelal.et/git-sync/healthz`.
2. In Plane: Workspace settings → Webhooks → the git-sync webhook → switch it back on (it shows as disabled).
3. Changes made while it was off are not resent. Re-save the affected work items in Plane (or make the matching
   change on GitHub) for anything that must sync. The audit row's `latestChangeAt` and `lastDeliveryAt` bound the gap.

### Rotating the Plane webhook secret

Plane generates the secret; git-sync accepts both `PLANE_WEBHOOK_SECRET` and, during a rotation,
`PLANE_WEBHOOK_SECRET_PREVIOUS`. A Plane delivery with a signature that matches neither is refused with `401` and never
resent, so keep the gap between steps 2 and 3 short, at a quiet time:
1. Note the current secret (it is `PLANE_WEBHOOK_SECRET` in `git-sync.env`).
2. In Plane: Workspace settings → Webhooks → the git-sync webhook → regenerate the secret key, and copy it.
3. In `git-sync.env` set `PLANE_WEBHOOK_SECRET=<new secret>` and `PLANE_WEBHOOK_SECRET_PREVIOUS=<old secret>`, then
   restart git-sync (`cd /root/plane && docker compose up -d git-sync`). Deliveries Plane already signed with the old secret still verify.
4. After an hour, remove `PLANE_WEBHOOK_SECRET_PREVIOUS` and restart again.

Never set the new secret in git-sync before Plane has generated it, and never leave a stale previous secret configured.
