# @aiand/cli

The ai& command line interface. Node 22, TypeScript, plain `tsc`, zero runtime
dependencies (enforced by `scripts/check-dist.mjs`).

## Agent skills

### Issue tracker

Issues live as GitHub issues on fenilmodi00/aiand-cli, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at the repo root is the domain glossary; ADRs go in `docs/adr/` when a decision is load-bearing. See `docs/agents/domain.md`.
