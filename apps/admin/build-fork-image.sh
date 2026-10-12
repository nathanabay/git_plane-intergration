#!/bin/bash
set -euo pipefail

# Build the plane-admin-gitsync image
# Expected tag: plane-admin-gitsync:v1.4.2

# Resolve the patch beside this script BEFORE changing directory: $0 may be a relative path.
PATCH_FILE="$(realpath "$(dirname "$0")/git-sync.patch")"
if [ ! -f "$PATCH_FILE" ]; then
    echo "Cannot find patch file at $PATCH_FILE"
    exit 1
fi

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

git clone --depth 1 --branch v1.4.2 https://github.com/makeplane/plane.git "$WORKDIR/plane"
cd "$WORKDIR/plane"

git apply "$PATCH_FILE"

docker build -t plane-admin-gitsync:v1.4.2 -f apps/admin/Dockerfile.admin .
