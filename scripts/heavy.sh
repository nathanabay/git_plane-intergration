#!/bin/sh
# Runs a memory-heavy check (oracles that start Postgres/Valkey, whole-repo test runs) under a
# machine-wide lock, so parallel agents verify one at a time. Six concurrent full runs exhausted
# the host's memory and triggered the OOM killer on 2026-10-11.
# usage: sh scripts/heavy.sh <command> [args...]
mkdir -p "$HOME/.cache/gitsync"
exec flock "$HOME/.cache/gitsync/heavy.lock" "$@"
