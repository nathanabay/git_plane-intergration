#!/bin/sh
# Restarts the demo server in the background; log in $LOG (default /tmp/claude-0/demo.log).
cd "$(dirname "$0")/../.."
LOG=${LOG:-/tmp/claude-0/demo.log}
OLD=$(ss -ltnpH "sport = :${PORT:-3199}" | grep -o "pid=[0-9]*" | head -1 | cut -d= -f2); [ -n "$OLD" ] && kill "$OLD" 2>/dev/null
sleep 1
nohup node manual/demo/server.ts --port "${PORT:-3199}" > "$LOG" 2>&1 &
echo $! > /tmp/claude-0/demo-${PORT:-3199}.pid
for i in $(seq 1 60); do grep -q "demo data seeded\|Error" "$LOG" && break; sleep 1; done
