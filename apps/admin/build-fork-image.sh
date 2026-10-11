#!/bin/bash
set -euo pipefail

# Build the plane-admin-gitsync image
# Expected tag: plane-admin-gitsync:v1.4.2

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

git clone --depth 1 --branch v1.4.2 https://github.com/makeplane/plane.git "$WORKDIR/plane"
cd "$WORKDIR/plane"

# Apply the patch from our repository
# The script is expected to run from the root of our repo or apps/admin
PATCH_FILE="$(realpath "$(dirname "$0")/git-sync.patch")"
if [ ! -f "$PATCH_FILE" ]; then
    echo "Cannot find patch file at $PATCH_FILE"
    exit 1
fi

git apply "$PATCH_FILE"

docker build -t plane-admin-gitsync:v1.4.2 -f apps/admin/Dockerfile.admin .
