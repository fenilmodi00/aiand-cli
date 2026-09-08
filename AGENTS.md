# @aiand/cli

The ai& command line interface. Node 22, TypeScript, plain `tsc`, zero runtime
dependencies (enforced by `scripts/check-dist.mjs`).

## Verification

`npm run lint && npm test && npm run build && npm run check:dist && npm run check:public` before handing over any change. Agent-adapter changes also run `node scripts/e2e.mjs`.

## Conventions

Agent wiring: `status` probes real config files, never bookkeeping; `off`
restores the snapshot byte for byte; quit-guards refuse `on`/`off` unless
`--force`; every model id written resolves through the live catalog (Claude
1M ids carry the `[1m]` tag).
Hygiene: tests isolate with `AIAND_HOME` and `AIAND_CONFIG_DIR`, never the
real home.

## Issue tracker

Issues live as GitHub issues on fenilmodi00/aiand-cli, managed via the `gh`
CLI. Triage roles: `needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human`, `wontfix`.

## Domain docs

`CONTEXT.md` at the repo root is the domain glossary: use its words exactly,
never a synonym it avoids. ADRs go in `docs/adr/` when a decision is
load-bearing; flag output that contradicts one.
