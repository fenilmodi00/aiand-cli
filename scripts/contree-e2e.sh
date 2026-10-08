#!/usr/bin/env bash
# ConTree driver for the sandbox E2E: runs the full command + adapter matrix
# from scripts/sbx-test.mjs inside a disposable ConTree microVM, against the
# live gateway (api.aiand.com). One driver among several — any disposable
# box with Node 22 works; see CONTRIBUTING.md "Live gateway runs" for the contract
# and the Docker / Daytona / bare-metal options.
#
# Prerequisites:
#   - contree CLI, authenticated (`contree auth`)
#   - AIAND_API_KEY exported or present in .env (auto-loaded)
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
# Usage: scripts/contree-e2e.sh   (manual only; CI never runs it — it spends credit)
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
if [ -z "${AIAND_API_KEY:-}" ] && [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env"
  set +a
fi
if [ -z "${AIAND_API_KEY:-}" ]; then
  echo "error: AIAND_API_KEY is not set — export it or add it to $REPO_ROOT/.env" >&2
  exit 1
fi
if [ "${AIAND_API_KEY}" = "sk-your-key-here" ]; then
  echo "error: AIAND_API_KEY is still the .env.example placeholder — set a real key" >&2
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
keyfile=""
trap 'rm -rf "$tmp"; [ -n "$keyfile" ] && rm -f "$keyfile"' EXIT

tar -czf "$tmp/payload.tar.gz" -C "$REPO_ROOT" dist CHANGELOG.md package.json "$HARNESS"

# --- ConTree session dance -------------------------------------------------

if ! contree -S "$SESSION" use "tag:$IMAGE"; then
  echo "error: contree could not use image $IMAGE — check 'contree images'" >&2
  exit 1
fi
contree -S "$SESSION" cd /root
contree -S "$SESSION" run -s -- 'apt-get update -qq && apt-get install -y -qq procps >/dev/null && command -v pgrep'
contree -S "$SESSION" tag aiand-sbx:base
# A pinned real Hermes for launcher-hermes-live (the routed round-trip) —
# same commit as ci.yml and src/agents/hermes/adapter.ts. It lands in ~/.local/bin
# (the installer's own publication dir) and reaches the matrix through the
# run's -e PATH below: the harness's "nothing installed" scenario probes a
# bare /usr/local/bin:/usr/bin:/bin PATH, which must stay agent-free.
contree -S "$SESSION" run -s -- 'apt-get install -y -qq git curl ca-certificates libatomic1 >/dev/null && export HOME=/root && curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --commit 666f313d1d3abd8077291ba464cf0a10f1a6157f --non-interactive --skip-browser --skip-computer-use >/tmp/hermes-install.log 2>&1 && "$HOME/.local/bin/hermes" --version | head -1'
contree -S "$SESSION" file cp "$tmp/payload.tar.gz" /root/payload.tar.gz
contree -S "$SESSION" run -s -- 'mkdir -p /work && tar -xzf /root/payload.tar.gz -C /work && node /work/scripts/sbx-test.mjs /work/dist/index.js --plan | tail -1'
contree -S "$SESSION" tag aiand-sbx:e2e

# --- Full run (disposable; exit code captured without tripping set -e) ------

keyfile="$(mktemp)"
chmod 600 "$keyfile"
printf 'export AIAND_API_KEY=%q\n' "$AIAND_API_KEY" >"$keyfile"
rc=0
contree -S "$SESSION" -o plain run --disposable -t 1200 \
  --file "$keyfile:/root/.aiand-api-key-env:m0600" \
  -e HOME=/root -e NO_COLOR=1 -e CI=1 \
  -- bash -lc 'set -a; . /root/.aiand-api-key-env; set +a; node /work/scripts/sbx-test.mjs /work/dist/index.js' || rc=$?
rm -f "$keyfile"
keyfile=""

if [ "$rc" -eq 0 ]; then
  echo "sandbox e2e: PASS (0)"
else
  echo "sandbox e2e: FAIL ($rc)"
fi
exit "$rc"
