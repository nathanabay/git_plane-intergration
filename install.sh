#!/usr/bin/env bash
# git-sync installer: adds the Plane <-> GitHub sync service to a running self-hosted Plane (Docker Compose).
#
#   ./install.sh                         install, or update an existing install (settings and secrets are kept)
#   ./install.sh --uninstall [--purge]   remove it again (--purge also deletes its database and settings)
#
# Needs only Docker with the Compose plugin (and git, to build the Plane UI images). See INSTALL.md.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORK_RELEASE="v1.4.2"
GITSYNC_IMAGE_TAG="git-sync:local"
ADMIN_IMAGE_TAG="plane-admin-gitsync:${FORK_RELEASE}"
WEB_IMAGE_TAG="plane-frontend-gitsync:${FORK_RELEASE}"

PLANE_DIR=""
PLANE_ENV_FILE=""
PROXY_MODE="plane"
GATEWAY_NETWORK=""
UI_MODE="auto"
ASSUME_YES=0
ACTION="install"
PURGE=0
PUBLIC_URL=""
GITHUB_APP_ID=""
GITHUB_KEY_FILE=""

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'; else B=""; G=""; Y=""; R=""; N=""; fi
step() { printf '\n%s==> %s%s\n' "$B" "$*" "$N"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '%s    ! %s%s\n' "$Y" "$*" "$N" >&2; }
die()  { printf '\n%sError: %s%s\n' "$R" "$*" "$N" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]

Installs git-sync next to a running self-hosted Plane, or updates an existing install.
It asks for two things (a Plane API key and a Plane webhook secret) and works out the rest.

Options:
  --plane-dir DIR          Plane's install directory (found automatically when Plane is running)
  --env-file FILE          Plane's env file, if it cannot be detected (e.g. plane.env)
  --public-url URL         Public URL of the Plane site (default: Plane's WEB_URL)
  --keep-plane-ui          Keep Plane's stock web/admin images (git-sync pages stay reachable
                           at <url>/git-sync/ui/admin); skips the slow Plane UI image build
  --with-plane-ui          Always use the git-sync Plane UI images (adds Git Sync to Plane's menus)
  --proxy plane|external   plane (default): route /git-sync/* through Plane's own proxy.
                           external: you add the route to your own reverse proxy.
  --gateway-network NAME   With --proxy external: a Docker network your reverse proxy is on
  --github-app-id ID       Optional: configure the GitHub App now (otherwise do it later in the UI)
  --github-private-key F   ...its private key file (.pem); the webhook secret is asked for
  -y, --yes                Never prompt; take secrets from the environment (see INSTALL.md)
  --uninstall              Remove git-sync from Plane (keeps its database and settings)
  --purge                  With --uninstall: also delete git-sync's database and settings
  -h, --help               Show this help

Non-interactive secrets: GITSYNC_PLANE_PAT, GITSYNC_PLANE_WEBHOOK_SECRET, GITSYNC_GITHUB_WEBHOOK_SECRET.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --plane-dir) PLANE_DIR="${2:?--plane-dir needs a directory}"; shift 2 ;;
    --env-file) PLANE_ENV_FILE="${2:?--env-file needs a file}"; shift 2 ;;
    --public-url) PUBLIC_URL="${2:?--public-url needs a URL}"; shift 2 ;;
    --keep-plane-ui) UI_MODE="stock"; shift ;;
    --with-plane-ui) UI_MODE="fork"; shift ;;
    --proxy) PROXY_MODE="${2:?--proxy needs plane or external}"; shift 2 ;;
    --gateway-network) GATEWAY_NETWORK="${2:?--gateway-network needs a network name}"; shift 2 ;;
    --github-app-id) GITHUB_APP_ID="${2:?--github-app-id needs an id}"; shift 2 ;;
    --github-private-key) GITHUB_KEY_FILE="${2:?--github-private-key needs a file}"; shift 2 ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    --uninstall) ACTION="uninstall"; shift ;;
    --purge) PURGE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done
case "$PROXY_MODE" in plane|external) ;; *) die "--proxy must be plane or external" ;; esac
[ -z "$GATEWAY_NETWORK" ] || [ "$PROXY_MODE" = external ] || die "--gateway-network goes with --proxy external"
[ "$PURGE" = 0 ] || [ "$ACTION" = uninstall ] || die "--purge goes with --uninstall"
if [ -n "$GITHUB_APP_ID" ] || [ -n "$GITHUB_KEY_FILE" ]; then
  if [ -z "$GITHUB_APP_ID" ] || [ -z "$GITHUB_KEY_FILE" ]; then die "--github-app-id and --github-private-key go together"; fi
  [ -r "$GITHUB_KEY_FILE" ] || die "cannot read $GITHUB_KEY_FILE"
  grep -q "PRIVATE KEY" "$GITHUB_KEY_FILE" || die "$GITHUB_KEY_FILE does not look like a PEM private key"
fi

# ---- 1. Docker and the running Plane ---------------------------------------------------------------------

step "Checking Docker and Plane"
command -v docker >/dev/null || die "Docker is not installed. Install Docker Engine first: https://docs.docker.com/engine/install/"
docker info >/dev/null 2>&1 || die "Cannot talk to the Docker daemon. Is it running, and may this user use it (try sudo)?"
docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin is missing: https://docs.docker.com/compose/install/"

label() { docker inspect --format "{{index .Config.Labels \"$2\"}}" "$1"; }

same_dir() { [ "$(cd "$1" 2>/dev/null && pwd -P)" = "$(cd "$2" 2>/dev/null && pwd -P)" ]; }

# Finds Plane's api container: a Compose service "api" whose project also has a "plane-db" service. It identifies
# the project: its directory, name and compose files. $1 = "running" (running containers only) or "all".
find_plane() {
  local cid wd proj found=""
  local -a ps=(docker ps -q); [ "$1" = running ] || ps+=(-a)
  local -a cids; mapfile -t cids < <("${ps[@]}" --filter label=com.docker.compose.service=api)
  for cid in "${cids[@]}"; do
    wd="$(label "$cid" com.docker.compose.project.working_dir)"
    proj="$(label "$cid" com.docker.compose.project)"
    if [ -n "$PLANE_DIR" ]; then same_dir "$PLANE_DIR" "$wd" || continue; fi
    [ -n "$("${ps[@]}" --filter "label=com.docker.compose.project=$proj" --filter label=com.docker.compose.service=plane-db)" ] || continue
    [ -z "$found" ] || [ "$(label "$found" com.docker.compose.project)" = "$proj" ] \
      || die "Found more than one Plane. Choose one with --plane-dir DIR"
    found="$cid"
  done
  API_CID="$found"
}

# A directory holding a Plane Compose install (the official setup.sh puts it in plane-selfhost/plane-app).
plane_compose_file() {
  local f; for f in docker-compose.yaml docker-compose.yml compose.yaml compose.yml; do
    if [ -f "$1/$f" ] && grep -qE '^  plane-db:' "$1/$f" && grep -qE '^  api:' "$1/$f"; then echo "$1/$f"; return 0; fi
  done
  return 1
}

confirm_start() {
  info "$1"
  if [ "$ASSUME_YES" = 0 ] && [ -t 0 ]; then
    read -r -p "    Start Plane now and install git-sync on it? [Y/n] " answer
    [[ -z "$answer" || "$answer" =~ ^[Yy] ]] || die "cancelled. Start Plane yourself, then run this again."
  fi
}

wait_for_plane() {
  for _ in $(seq 1 90); do
    find_plane running
    if [ -n "$API_CID" ]; then
      local db; db="$(docker ps -q --filter "label=com.docker.compose.project=$(label "$API_CID" com.docker.compose.project)" --filter label=com.docker.compose.service=plane-db | head -n1)"
      if [ -n "$db" ] && docker exec "$db" pg_isready -q >/dev/null 2>&1; then return 0; fi
    fi
    sleep 2
  done
  die "Plane did not come up within 3 minutes. Check it with 'docker compose ps' in its directory."
}

API_CID=""
find_plane running
if [ -z "$API_CID" ]; then
  # Installed but stopped: its containers still exist. Starting them as they are keeps Plane's exact configuration.
  find_plane all
  if [ -n "$API_CID" ]; then
    proj="$(label "$API_CID" com.docker.compose.project)"
    confirm_start "Plane is installed in $(label "$API_CID" com.docker.compose.project.working_dir) but not running."
    mapfile -t stopped < <(docker ps -aq --filter "label=com.docker.compose.project=$proj")
    docker start "${stopped[@]}" >/dev/null || die "could not start Plane's containers"
    wait_for_plane
    info "Plane started"
  fi
fi
if [ -z "$API_CID" ]; then
  # Installed but its containers are gone (e.g. after 'docker compose down'): start it from its directory the way
  # Plane's setup.sh does, with plane.env when there is one.
  dirs=()
  if [ -n "$PLANE_DIR" ]; then dirs=("$PLANE_DIR")
  else
    for home in "$HOME" ${SUDO_USER:+"$(getent passwd "$SUDO_USER" | cut -d: -f6)"} /root; do
      dirs+=("$home/plane-selfhost/plane-app" "$home/plane")
    done
    dirs+=(/opt/plane-selfhost/plane-app /opt/plane /srv/plane)
  fi
  found_dir=""
  for d in "${dirs[@]}"; do
    if [ -z "$d" ] || ! plane_compose_file "$d" >/dev/null; then continue; fi
    [ -z "$found_dir" ] || same_dir "$found_dir" "$d" || die "Found Plane installed in $found_dir and $d. Choose one with --plane-dir DIR"
    found_dir="$d"
  done
  if [ -z "$found_dir" ]; then
    [ -z "$PLANE_DIR" ] || die "$PLANE_DIR does not hold a Plane install (no compose file with plane-db and api services)."
    die "Plane is not installed here (no Plane found in Docker or in the usual folders).
       Install Plane first: https://developers.plane.so/self-hosting/methods/docker-compose
       If it is installed somewhere else, pass --plane-dir DIR."
  fi
  start_cmd=(docker compose)
  if [ -n "$PLANE_ENV_FILE" ]; then start_cmd+=(--env-file "$PLANE_ENV_FILE")
  elif [ -f "$found_dir/plane.env" ]; then start_cmd+=(--env-file plane.env); fi
  confirm_start "Plane is installed in $found_dir but not running."
  (cd "$found_dir" && "${start_cmd[@]}" up -d) >/dev/null 2>&1 || die "could not start Plane: run '${start_cmd[*]} up -d' in $found_dir to see why"
  PLANE_DIR="$found_dir"
  wait_for_plane
  info "Plane started"
fi
PROJECT="$(label "$API_CID" com.docker.compose.project)"
PLANE_DIR="$(label "$API_CID" com.docker.compose.project.working_dir)"
IFS=',' read -r -a CONFIG_FILES <<< "$(label "$API_CID" com.docker.compose.project.config_files)"
if [ ! -d "$PLANE_DIR" ] || [ ! -w "$PLANE_DIR" ]; then die "Plane's directory $PLANE_DIR is not writable by this user (try sudo)"; fi
DB_CID="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=plane-db | head -n1)"
[ -n "$DB_CID" ] || die "Plane's plane-db container is not running"
info "Plane: $PLANE_DIR (project $PROJECT)"

# The compose command must reproduce exactly how Plane was started, or `up` would recreate Plane with other
# settings. Proof: the config hash Compose computes for api and plane-db equals the one on the running containers.
base_compose_args() {
  local args=(-p "$PROJECT" --project-directory "$PLANE_DIR")
  local f; for f in "${CONFIG_FILES[@]}"; do args+=(-f "$f"); done
  [ -z "$1" ] || args+=(--env-file "$1")
  printf '%s\0' "${args[@]}"
}
reproduces_plane() {
  local -a args; mapfile -d '' -t args < <(base_compose_args "$1")
  local svc want got
  for svc in api plane-db; do
    want="$(label "$( [ "$svc" = api ] && echo "$API_CID" || echo "$DB_CID")" com.docker.compose.config-hash)"
    got="$(docker compose "${args[@]}" config --hash "$svc" 2>/dev/null | awk '{print $2}')" || return 1
    [ -n "$got" ] && [ "$got" = "$want" ] || return 1
  done
}
ENV_CHOICE="__none__"
if [ -n "$PLANE_ENV_FILE" ]; then
  PLANE_ENV_FILE="$(cd "$(dirname "$PLANE_ENV_FILE")" && pwd)/$(basename "$PLANE_ENV_FILE")"
  reproduces_plane "$PLANE_ENV_FILE" || die "Running Plane with --env-file $PLANE_ENV_FILE does not reproduce the running Plane; check the file"
  ENV_CHOICE="$PLANE_ENV_FILE"
else
  for candidate in "" "$PLANE_DIR/plane.env" "$PLANE_DIR"/*.env; do
    [ -z "$candidate" ] || { [ -f "$candidate" ] && [ "$(basename "$candidate")" != git-sync.env ]; } || continue
    if reproduces_plane "$candidate"; then ENV_CHOICE="$candidate"; break; fi
  done
fi
[ "$ENV_CHOICE" != "__none__" ] || die "Could not work out how this Plane was started (which env file it uses).
       Pass it with --env-file, e.g. --env-file $PLANE_DIR/plane.env"
[ -z "$ENV_CHOICE" ] || info "Plane env file: $ENV_CHOICE"

# Compose files from now on: Plane's own, plus the override that holds git-sync.
OVERRIDE=""
for name in docker-compose.override.yaml docker-compose.override.yml compose.override.yaml compose.override.yml; do
  [ -f "$PLANE_DIR/$name" ] && { OVERRIDE="$PLANE_DIR/$name"; break; }
done
if [ -z "$OVERRIDE" ]; then
  base="$(basename "${CONFIG_FILES[0]}")"; OVERRIDE="$PLANE_DIR/${base%.*}.override.${base##*.}"
fi
OVERRIDE_LOADED=0
for f in "${CONFIG_FILES[@]}"; do [ "$f" = "$OVERRIDE" ] && OVERRIDE_LOADED=1; done
compose() {
  local -a args; mapfile -d '' -t args < <(base_compose_args "$ENV_CHOICE")
  [ "$OVERRIDE_LOADED" = 1 ] || [ ! -f "$OVERRIDE" ] || args+=(-f "$OVERRIDE")
  docker compose "${args[@]}" "$@"
}
if [ "$OVERRIDE_LOADED" = 0 ] && [ -f "$OVERRIDE" ] && [ "$ACTION" = install ]; then
  warn "$OVERRIDE exists but the running Plane was started without it; its other entries will now apply too"
fi

NETWORK="${PROJECT}_default"
docker network inspect "$NETWORK" >/dev/null 2>&1 \
  || NETWORK="$(docker inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' "$API_CID" | head -n1)"

SCRATCH="$(mktemp -d)"
chmod 700 "$SCRATCH"
cleanup() { docker run --rm -v "$SCRATCH:/install" --entrypoint sh "$GITSYNC_IMAGE_TAG" -c 'rm -rf /install/* /install/.[!.]*' >/dev/null 2>&1 || true; rm -rf "$SCRATCH" 2>/dev/null || true; }
trap cleanup EXIT
# Plane's own settings, straight from its running containers (whatever its env file is called).
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$API_CID" > "$SCRATCH/api.env"
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$DB_CID" > "$SCRATCH/db.env"

run_installer() {
  local tty=(); if [ "$ASSUME_YES" = 0 ] && [ -t 0 ] && [ -t 1 ]; then tty=(-it); fi
  docker run --rm "${tty[@]}" --user 0:0 --network "$NETWORK" \
    -v "$PLANE_DIR:/plane" -v "$SCRATCH:/install" \
    -e GITSYNC_PLANE_PAT -e GITSYNC_PLANE_WEBHOOK_SECRET -e GITSYNC_GITHUB_WEBHOOK_SECRET \
    -e GITSYNC_PUBLIC_ORIGIN="$PUBLIC_URL" -e GITSYNC_GITHUB_APP_ID="$GITHUB_APP_ID" \
    "$GITSYNC_IMAGE_TAG" node src/install/main.ts "$@"
}

# Plane's proxy restarts when git-sync is added or removed. Wait until it answers again, so the site is back when
# this script says it is done. $1 = "git-sync" to also require the /git-sync/* route.
wait_for_proxy() {
  [ "$PROXY_MODE" = plane ] || return 0
  local want="${1:-}" probe
  # A domain site answers plain HTTP with a redirect to HTTPS; that still proves Caddy is up with its config.
  probe="fetch('http://proxy:80/git-sync/healthz',{redirect:'manual'}).then(async r=>{const b=await r.text();"
  probe+="process.exit(r.status>=300&&r.status<400?0:'$want'!=='git-sync'?(r.status>0?0:1):(r.status===200&&b.includes('\"ok\"')?0:1))},()=>process.exit(1))"
  local ready=0
  for _ in $(seq 1 45); do
    if docker run --rm --network "$NETWORK" "$GITSYNC_IMAGE_TAG" node -e "$probe" >/dev/null 2>&1; then ready=1; break; fi
    sleep 2
  done
  [ "$ready" = 1 ] || { warn "Plane's proxy is not answering yet. Check it with: docker compose logs proxy (in $PLANE_DIR)"; return 0; }
  # Docker re-attaches the published port a moment after the container restarts (measured: about a second).
  # Wait for it too, so the site answers from this machine before we say we are done.
  local proxy_cid addr host port
  # No published port is normal (e.g. a host reverse proxy reaches Plane over a Docker network); `|| true` keeps
  # `docker port`'s error from ending the script under `set -e -o pipefail`.
  proxy_cid="$(compose ps -q proxy 2>/dev/null | head -n1 || true)"
  addr="$( { [ -z "$proxy_cid" ] || docker port "$proxy_cid" 80/tcp 2>/dev/null; } | head -n1 || true)"
  [ -n "$addr" ] || return 0
  host="${addr%:*}"; port="${addr##*:}"
  case "$host" in 0.0.0.0|"[::]"|"::"|"") host=127.0.0.1 ;; esac
  # An HTTP answer, not just a TCP connect: rootless Docker's port forwarder accepts connections early.
  for _ in $(seq 1 30); do
    if (exec 3<>"/dev/tcp/$host/$port" && printf 'GET / HTTP/1.0\r\nHost: localhost\r\n\r\n' >&3 \
        && IFS= read -r -t 5 line <&3 && [[ "$line" == HTTP/* ]]) 2>/dev/null; then return 0; fi
    sleep 1
  done
  warn "Plane's proxy runs, but port $port on this machine is not answering yet"
}

# ---- uninstall -------------------------------------------------------------------------------------------

if [ "$ACTION" = uninstall ]; then
  # Always rebuild (cached, quick): the removal logic runs from this image and must match this checkout.
  docker build -q -t "$GITSYNC_IMAGE_TAG" "$REPO_DIR" >/dev/null || die "docker build failed; run: docker build -t $GITSYNC_IMAGE_TAG $REPO_DIR"
  if [ "$PURGE" = 1 ] && [ "$ASSUME_YES" = 0 ]; then
    read -r -p "    Delete git-sync's database, settings and stored GitHub credentials for good? [y/N] " answer
    [[ "$answer" =~ ^[Yy] ]] || die "cancelled"
  fi
  step "Removing git-sync"
  compose rm -sf git-sync >/dev/null 2>&1 || true
  uninstall_args=(uninstall); [ "$PURGE" = 0 ] || uninstall_args+=(--purge)
  run_installer "${uninstall_args[@]}"
  step "Restarting Plane's proxy and apps without git-sync"
  compose up -d >/dev/null 2>"$SCRATCH/up.log" || { cat "$SCRATCH/up.log" >&2; die "docker compose up failed"; }
  wait_for_proxy
  printf '\n%sgit-sync has been removed.%s\n' "$G" "$N"
  exit 0
fi

# ---- 2. Images -------------------------------------------------------------------------------------------

step "Building the git-sync image"
docker build -q -t "$GITSYNC_IMAGE_TAG" "$REPO_DIR" >/dev/null || die "docker build failed; run: docker build -t $GITSYNC_IMAGE_TAG $REPO_DIR"
info "$GITSYNC_IMAGE_TAG ready"

# The UI images add Git Sync to Plane's menus. They are built from Plane $FORK_RELEASE, so they are only used
# on that release; elsewhere Plane keeps its own UI and git-sync's pages are opened directly.
WEB_IMAGE="$(docker inspect --format '{{.Config.Image}}' "$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=web | head -n1)" 2>/dev/null || true)"
USE_FORKS=0
case "$UI_MODE" in
  fork) USE_FORKS=1 ;;
  stock) USE_FORKS=0 ;;
  auto) case "$WEB_IMAGE" in *":$FORK_RELEASE"|*gitsync*) USE_FORKS=1 ;; *) USE_FORKS=0 ;; esac ;;
esac
if [ "$USE_FORKS" = 1 ]; then
  step "Preparing the Plane UI images (adds Git Sync to Plane's menus)"
  for pair in "admin:$ADMIN_IMAGE_TAG" "web:$WEB_IMAGE_TAG"; do
    app="${pair%%:*}"; tag="${pair#*:}"
    if docker image inspect "$tag" >/dev/null 2>&1; then info "$tag ready"; continue; fi
    command -v git >/dev/null || die "git is needed to build $tag (or use --keep-plane-ui)"
    info "Building $tag from Plane $FORK_RELEASE. This takes a while (often 10-20 minutes)..."
    "$REPO_DIR/apps/$app/build-fork-image.sh" > "$SCRATCH/build-$app.log" 2>&1 \
      || { tail -n 30 "$SCRATCH/build-$app.log" >&2; die "building $tag failed (re-run, or use --keep-plane-ui)"; }
    info "$tag ready"
  done
else
  info "Keeping Plane's own UI${WEB_IMAGE:+ ($WEB_IMAGE)}; git-sync's settings open at <your Plane URL>/git-sync/ui/admin"
fi

# ---- 3. Configuration ------------------------------------------------------------------------------------

if [ "$PROXY_MODE" = plane ]; then
  PROXY_CID="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=proxy | head -n1)"
  [ -n "$PROXY_CID" ] || die "Plane's proxy service is not running. If you use your own reverse proxy, pass --proxy external"
  # From the image, not the container: a re-run after a Plane upgrade must patch the new release's file.
  docker run --rm --entrypoint cat "$(docker inspect --format '{{.Config.Image}}' "$PROXY_CID")" /etc/caddy/Caddyfile > "$SCRATCH/Caddyfile.plane" \
    || die "could not read the Caddyfile from Plane's proxy image; use --proxy external"
fi
[ -z "$GITHUB_KEY_FILE" ] || cp "$GITHUB_KEY_FILE" "$SCRATCH/github-app.pem"

step "Configuring git-sync"
args=(configure --proxy "$PROXY_MODE")
[ -z "$GATEWAY_NETWORK" ] || args+=(--gateway-network "$GATEWAY_NETWORK")
[ "$USE_FORKS" = 0 ] || args+=(--ui-forks)
run_installer "${args[@]}" || exit 1
[ -f "$OVERRIDE" ] || die "the compose override was not written"
[ -r "$SCRATCH/result.env" ] || die "the configuration step did not finish"
result() { sed -n "s/^$1=//p" "$SCRATCH/result.env"; }

# ---- 4. Start --------------------------------------------------------------------------------------------

step "Starting git-sync"
compose config --quiet 2>"$SCRATCH/config.log" || { cat "$SCRATCH/config.log" >&2; die "the merged compose configuration is invalid (a backup of the override was kept next to it)"; }
compose up -d >/dev/null 2>"$SCRATCH/up.log" || { cat "$SCRATCH/up.log" >&2; die "docker compose up failed"; }
probe="http.get('http://127.0.0.1:3100/git-sync/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
healthy=0
for _ in $(seq 1 60); do
  if compose exec -T git-sync node -e "$probe" >/dev/null 2>&1; then healthy=1; break; fi
  sleep 2
done
if [ "$healthy" = 0 ]; then
  compose logs --tail 40 git-sync >&2 || true
  die "git-sync did not become healthy within 2 minutes (logs above)"
fi
wait_for_proxy git-sync
info "git-sync is running and healthy"

ORIGIN="$(result PUBLIC_ORIGIN)"
printf '\n%s%sgit-sync is installed.%s\n\n' "$B" "$G" "$N"
cat <<EOF
Next steps:
  1. Plane webhook: make sure your workspace has a webhook to
       $(result PLANE_WEBHOOK_URL)
     (Workspace settings > Webhooks; the installer already has its secret).
EOF
if [ "$(result GITHUB_CONFIGURED)" = yes ]; then
  echo "  2. GitHub App: configured. Point its webhook at $ORIGIN/git-sync/webhooks/github"
else
  cat <<EOF
  2. GitHub App: open $ORIGIN/$([ "$USE_FORKS" = 1 ] && echo "god-mode/git-sync" || echo "git-sync/ui/admin")
     and add your GitHub App (INSTALL.md, "Create the GitHub App", lists the exact settings).
EOF
fi
if [ "$USE_FORKS" = 1 ]; then
  echo "  3. Connect a repository: in Plane, Workspace settings > Git Sync."
else
  echo "  3. Connect a repository: open $ORIGIN/git-sync/ui/workspaces/<your-workspace-slug>"
fi
if [ "$PROXY_MODE" = external ]; then
  cat <<EOF

Your reverse proxy must send /git-sync/* to git-sync:3100, before the Plane route. For Caddy:
    handle /git-sync/* {
        reverse_proxy git-sync:3100
    }
EOF
fi
restart_cmd="cd $PLANE_DIR && docker compose"
for f in "${CONFIG_FILES[@]}"; do restart_cmd+=" -f ${f#"$PLANE_DIR"/}"; done
[ "$OVERRIDE_LOADED" = 1 ] || restart_cmd+=" -f ${OVERRIDE#"$PLANE_DIR"/}"
[ -z "$ENV_CHOICE" ] || restart_cmd+=" --env-file ${ENV_CHOICE#"$PLANE_DIR"/}"
cat <<EOF

To change settings later run ./install.sh again; ./install.sh --uninstall removes git-sync.
Start Plane with this command from now on, so git-sync is included (Plane's setup.sh leaves it out):
    $restart_cmd up -d
EOF
