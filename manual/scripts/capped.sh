#!/bin/sh
# Runs a manual step with a hard memory cap (cgroup via systemd-run; default 3G, no swap) and a capped Node heap.
#   MANUAL_MEM_MAX=2G sh manual/scripts/capped.sh node manual/scripts/capture.mjs
# Everything the step starts (demo server, Chromium) is inside the same cap; past it the kernel stops the step, not the host.
MAX=${MANUAL_MEM_MAX:-3G}
export NODE_OPTIONS="${NODE_OPTIONS:-} --max-old-space-size=${MANUAL_NODE_HEAP_MB:-1024}"
if command -v systemd-run >/dev/null 2>&1; then
  exec systemd-run --quiet --scope --same-dir -p MemoryMax="$MAX" -p MemorySwapMax=0 -E NODE_OPTIONS="$NODE_OPTIONS" -- "$@"
fi
echo "capped.sh: systemd-run not found; running with the Node heap cap only" >&2
exec "$@"
