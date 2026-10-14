# Installing git-sync

git-sync adds two-way GitHub sync to a self-hosted Plane (Community Edition). It runs as one extra container
next to Plane and uses Plane's own Postgres, Valkey and proxy. You add nothing else.

## What you need

- A self-hosted Plane that is **running** with Docker Compose. The official `setup.sh` install works.
- Docker with the Compose plugin, run by a user who may use Docker and write Plane's directory (usually `sudo`).
- `git`, to build the Plane UI images that add Git Sync to Plane's menus.

## 1. Before you start (2 minutes)

git-sync acts in Plane as a service account:

1. In Plane, create a user for it (for example "GitHub Bot") and add it to the workspaces you will sync.
2. Signed in as that user, go to **Profile settings → Personal access tokens → Add** and copy the key.

## 2. Install

```bash
git clone <this repository> git-sync
cd git-sync
sudo ./install.sh
```

The installer finds your Plane, works out its settings and asks for two things:

| It asks for | Where it comes from |
| --- | --- |
| Plane API key | Step 1 above |
| Plane webhook secret | The installer prints a URL. In Plane go to **Workspace settings → Webhooks → Add webhook**, paste the URL, choose **Send me everything**, save, and copy the secret key. |

Everything else is generated or read from Plane: database and password, encryption key, Plane's public URL and
its API rate limit. It then routes `/git-sync/*` through Plane's proxy, starts git-sync and waits until it is healthy.

> **Plane v1.4.2:** the installer also builds Plane UI images that add **Git Sync** to Plane's menus. The first
> build takes 10–20 minutes. To skip it, pass `--keep-plane-ui`. The git-sync pages then open at
> `<your Plane URL>/git-sync/ui/admin` instead. Other Plane versions keep Plane's own UI automatically.

## 3. Create the GitHub App

On GitHub go to **Settings → Developer settings → GitHub Apps → New GitHub App**. For an organization, use the
organization's settings. Replace `https://plane.example.com` with your Plane URL:

| Setting | Value |
| --- | --- |
| Homepage URL | `https://plane.example.com` |
| Callback URL | `https://plane.example.com/git-sync/oauth/github/callback` |
| Request user authorization (OAuth) during installation | Off |
| Setup URL | `https://plane.example.com/git-sync/install/github/callback`, with **Redirect on update** on |
| Webhook | Active. URL `https://plane.example.com/git-sync/webhooks/github`. Secret: make one with `openssl rand -hex 32` and keep it for the next step |
| Repository permissions | Pull requests, Issues, Contents: **Read and write**. Checks, Commit statuses, Deployments, Metadata: **Read** |
| Organization permissions | Members: **Read** |
| Subscribe to events | Pull request, Pull request review, Push, Issues, Issue comment, Check suite, Check run, Status, Deployment status |

Create the App. Then **generate a private key** (a `.pem` file downloads) and **generate a client secret**.

Open **God mode → Git Sync** in Plane, or `<your Plane URL>/git-sync/ui/admin`. Under **GitHub App**, fill in
the App ID, private key, webhook secret, App slug (the last part of the App's public link), client ID and client
secret, then save. They are stored encrypted.

The setup checklist on the same page shows what still needs attention. [deploy/APPLY.md](deploy/APPLY.md#github-app-registration)
explains each permission and covers GitHub Enterprise.

## 4. Connect a repository

In Plane, open **Workspace settings → Git Sync**, or `<your Plane URL>/git-sync/ui/workspaces/<workspace-slug>`.
Choose **Connect GitHub**, install the App on your repositories, and map a repository to a project.

## Everyday use

| To | Run |
| --- | --- |
| Update git-sync, or change a setting | `git pull && sudo ./install.sh`. Existing settings and secrets are kept. |
| Remove git-sync, keeping its data | `sudo ./install.sh --uninstall` |
| Remove git-sync and delete its data | `sudo ./install.sh --uninstall --purge` |

At the end the installer prints the command that starts Plane **with** git-sync included. Use that command from
then on. Plane's `setup.sh` start/restart leaves git-sync out, because it ignores the override file.

## Options

| Option | Use it when |
| --- | --- |
| `--plane-dir DIR` | More than one Plane runs on the machine |
| `--env-file FILE` | The installer cannot tell which env file Plane was started with |
| `--public-url URL` | Plane's `WEB_URL` is not the address people use |
| `--keep-plane-ui` / `--with-plane-ui` | You want Plane's stock UI, or the Git Sync menu entries on purpose |
| `--proxy external --gateway-network NAME` | Your own reverse proxy (not Plane's) serves Plane. git-sync joins that Docker network as `git-sync`. Send `/git-sync/*` to `git-sync:3100`, before the Plane route. |
| `--github-app-id ID --github-private-key FILE` | You want to enter the GitHub App at install time instead of in the UI |
| `-y` | Scripted installs: no prompts. Secrets come from `GITSYNC_PLANE_PAT`, `GITSYNC_PLANE_WEBHOOK_SECRET` and `GITSYNC_GITHUB_WEBHOOK_SECRET`. |

For example, a host whose own Caddy serves Plane over a Docker network called `gateway`:

```bash
sudo ./install.sh --plane-dir /root/plane --proxy external --gateway-network gateway
```

## Is it safe to run on a live Plane?

- The installer only changes Plane's containers if it can reproduce exactly how Plane was started. It compares
  Docker Compose's configuration hash for Plane's `api` and `plane-db` with the running containers. If they differ,
  it stops before changing anything.
- Plane's own services are not recreated. Only the proxy and, with the UI images, the web and admin apps restart.
- It backs up `docker-compose.override.yaml` and `git-sync.env` next to themselves (`.bak-<time>`) before each change.
  Your own override entries, comments and `!override`/`!reset` tags are kept.
- git-sync uses its own database and role on Plane's Postgres. Plane's data is never touched, and `--purge` drops
  only git-sync's database.
- Secrets are never printed. `git-sync.env` is readable by its owner only.

## Troubleshooting

| Message | What to do |
| --- | --- |
| `No running Plane found` | Start Plane first, or point at it with `--plane-dir`. |
| `Could not work out how this Plane was started` | Pass Plane's env file, e.g. `--env-file /root/plane/plane.env`. |
| `Plane rejected the API key` | Create a new key for the service account and run the installer again with it: `GITSYNC_PLANE_PAT=<key> sudo -E ./install.sh`. |
| `git-sync did not become healthy` | The last log lines are printed. More: `docker compose logs git-sync` in Plane's directory. |
| Plane will not save the webhook URL, or never delivers | Plane only sends webhooks to public addresses by default. For a Plane on a private network, add its host name to `WEBHOOK_ALLOWED_HOSTS` in Plane's env file and restart Plane. |
| Plane's proxy already mounts its own Caddyfile | Use `--proxy external` and add the `/git-sync/*` route to that Caddyfile yourself. |

Webhook redelivery, secret rotation and other operations are covered in [deploy/APPLY.md](deploy/APPLY.md).
