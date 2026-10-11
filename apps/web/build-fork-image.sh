#!/bin/bash
set -euo pipefail

# Build the plane-frontend-gitsync image
# Expected tag: plane-frontend-gitsync:v1.4.2

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

git clone --depth 1 --branch v1.4.2 https://github.com/makeplane/plane.git "$WORKDIR/plane"
cd "$WORKDIR/plane"

# Apply the patch from our repository
PATCH_FILE="$(realpath "$(dirname "$0")/git-sync.patch")"
if [ ! -f "$PATCH_FILE" ]; then
    echo "Cannot find patch file at $PATCH_FILE"
    exit 1
fi

git apply "$PATCH_FILE"

docker build -t plane-frontend-gitsync:v1.4.2 -f apps/web/Dockerfile.web .
