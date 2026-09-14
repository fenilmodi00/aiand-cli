#!/usr/bin/env bash
# ConTree driver for the sandbox E2E: runs the full command + adapter matrix
# from scripts/sbx-test.mjs inside a disposable ConTree microVM, against the
# live gateway (api.aiand.com). One driver among several — any disposable
# Linux box with Node 22 works; see README "Sandbox E2E" for the contract
# and the Docker / Daytona / bare-metal options.
#
# Prerequisites:
#   - contree CLI, authenticated (`contree auth`)
#   - AIAND_API_KEY set (export it or source your .env)
#   - a Node 22 build: dist/index.js (run `npm run build` first)
#
# What it spends: a handful of tiny real inference calls against the gateway —
# production credit, a few cents at most.
#
# Rollback story: everything happens in the `aiand-sbx` session. The full
# matrix runs with `run --disposable`, so a failing run never advances the
# branch; `contree -S aiand-sbx session rollback` restores the session to its
# tagged image at any time.
#
# Usage: scripts/contree-e2e.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SESSION=aiand-sbx
IMAGE=node:22-slim
HARNESS=scripts/sbx-test.mjs

# --- Preflight -------------------------------------------------------------

if ! command -v contree >/dev/null 2>&1; then
  echo "error: the contree CLI is not on PATH — install it with: uv tool install contree-cli" >&2
  exit 1
fi
if [ -z "${AIAND_API_KEY:-}" ]; then
  echo "error: AIAND_API_KEY is not set — export it from your environment or .env" >&2
  exit 1
fi
if [ ! -f "$REPO_ROOT/dist/index.js" ]; then
  echo "error: dist/index.js not found — build the CLI first: npm run build" >&2
  exit 1
fi
if [ ! -f "$REPO_ROOT/$HARNESS" ]; then
  echo "error: $HARNESS not found — the sandbox E2E harness is missing" >&2
  exit 1
fi

echo "sandbox e2e: image $IMAGE, session $SESSION, harness $HARNESS"

# --- Payload ---------------------------------------------------------------

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

tar -czf "$tmp/payload.tar.gz" dist CHANGELOG.md package.json "$HARNESS"

# --- ConTree session dance -------------------------------------------------

if ! contree -S "$SESSION" use "tag:$IMAGE"; then
  echo "error: contree could not use image $IMAGE — check 'contree images'" >&2
  exit 1
fi
contree -S "$SESSION" cd /root
contree -S "$SESSION" run -- sh -c 'apt-get update -qq && apt-get install -y -qq procps >/dev/null && command -v pgrep'
contree -S "$SESSION" tag aiand-sbx:base
contree -S "$SESSION" file cp "$tmp/payload.tar.gz" /root/payload.tar.gz
contree -S "$SESSION" run -- sh -c 'mkdir -p /work && tar -xzf /root/payload.tar.gz -C /work && node /work/scripts/sbx-test.mjs --plan | tail -1'
contree -S "$SESSION" tag aiand-sbx:e2e

# --- Full run (disposable; exit code captured without tripping set -e) ------

rc=0
contree -S "$SESSION" -o plain run --disposable \
  -e AIAND_API_KEY="$AIAND_API_KEY" -e NO_COLOR=1 -e CI=1 \
  -- node /work/scripts/sbx-test.mjs /work/dist/index.js || rc=$?

if [ "$rc" -eq 0 ]; then
  echo "sandbox e2e: PASS (0)"
else
  echo "sandbox e2e: FAIL ($rc)"
fi
exit "$rc"
