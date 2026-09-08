# @aiand/cli

The ai& command line interface. Node 22, TypeScript, plain `tsc`, zero runtime
dependencies (enforced by `scripts/check-dist.mjs`).

## Verification

`npm run lint && npm test && npm run build && npm run check:dist && npm run check:public` before handing over any change. Agent-adapter changes also run `node scripts/e2e.mjs`.

## Conventions

Tests isolate with `AIAND_HOME`/`AIAND_CONFIG_DIR`, never the real home.
Issues live as GitHub issues on fenilmodi00/aiand-cli, managed via the `gh` CLI.
Domain vocabulary, agent-wiring rules, and ADR locations: `CONTEXT.md` at the repo root — use its words exactly.

