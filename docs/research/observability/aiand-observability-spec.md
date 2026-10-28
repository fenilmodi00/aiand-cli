# aiand-cli Observability — Implementation Spec

Date: 2026-10-25 · Status: approved for ticketing · Companion docs (same folder): `harness-observability-research-2026-10-25.md` (demand evidence), `aiand-harness-observability-plan.md` (strategy + API audit), `aiand-observability-feature-catalog.md` (per-feature implementation details + source references).

## Problem Statement

Developers route multiple coding harnesses (Claude Code, Codex, OpenCode, Pi, Oh My Pi, Copilot, Hermes) through the ai& gateway, but they cannot answer the questions that decide their setup: *which harness with which model is cheapest, fastest, and most reliable for the work I actually do?* Today they either trust vendor dashboards they consider opaque, or run local-file usage scrapers whose numbers disagree with what they were billed. Usage reporting per tool exists at scale in the community (ccusage, CodeBurn), but cross-harness comparison, outcome metrics, forecasting, and programmatic access are unmet — and no local scraper can ever be billing-grade, because it reconstructs costs from price tables.

## Solution

Make aiand-cli the observability layer for everything that runs on ai&: sync the gateway's billing-grade per-request logs into a local store, attribute every request to the harness adapter that sent it, sessionize, and expose reporting, cross-harness comparison, benchmarks, forecasting, and exports — all local-first, all reconciling exactly to the gateway's own numbers. The north star is a recommendation: for your workload, this model × this harness performs best. Harnesses are adapters; aiand is the provider; observability is the product surface.

## User Stories

1. As an aiand user, I want every request my harnesses make to be recorded locally with its true billed cost, so that I never have to estimate spend from price tables.
2. As an aiand user, I want my history retained beyond the gateway's 30-day log window, so that I can analyze months of usage.
3. As an aiand user, I want a verification command that proves my local numbers match the gateway's totals, so that I can trust every other number the CLI shows me.
4. As an aiand user, I want requests grouped into sessions per harness, so that I can see what a working session actually cost.
5. As an aiand user, I want usage broken down by day, week, month, session, model, and harness, so that I can find where my money goes.
6. As an aiand user, I want to drill from a summary into a single session and its individual requests, so that I can investigate anomalies.
7. As an aiand user, I want a side-by-side comparison of harnesses on my real workload (cost, tokens, turns, TTFT, cache hit rate, errors, health verdicts), so that I can pick the right harness.
8. As an aiand user, I want the same comparison across models, so that I can pick the right model × harness pair for my kind of work.
9. As an aiand user, I want a recommendation with a suggested wiring change, so that switching to a better pair is one command.
10. As an aiand user, I want cohort-honest comparisons (same-kind-of-work, median and P90, mixed-turn exclusions counted), so that the comparison isn't lying to me.
11. As an aiand user, I want synthetic request-shape benchmarks across harness layouts and models, so that I can measure cache behavior without waiting for real usage.
12. As an aiand user, I want to replay my own recorded session shapes across different (harness, model) pairs, so that "which would have been cheaper?" is answered on my workload, not a benchmark's.
13. As an aiand user, I want latency and time-to-first-token percentiles per harness and model, so that responsiveness is part of the choice.
14. As an aiand user, I want a budget with burn-rate projection and a pacing verdict, so that I'm never surprised by spend.
15. As an aiand user, I want a statusline and a watch mode, so that spend and burn are glanceable while I work.
16. As an aiand user, I want a machine-readable state file and exit codes, so that scripts, CI, and tray apps can gate on my usage.
17. As an aiand user, I want an offline HTML report and a copy-pasteable text overview, so that I can share results without a server.
18. As an aiand user, I want peak/off-peak token splits where models price that way, so that shifting work hours becomes a measurable saving.
19. As an aiand user, I want to see what my usage would have cost at vendor list prices, so that the ai& saving is quantified honestly.
20. As an aiand user, I want OTel-compatible export of my usage, so that my existing Grafana/dashboards work unmodified.
21. As an aiand user, I want an MCP server exposing my usage to my coding agents, so that an agent can budget itself mid-task.
22. As an aiand user, I want to import usage that never touched aiand (via ccusage output), so that comparisons can include my other subscriptions — kept separate from gateway totals so nothing double-counts.
23. As an aiand user, I want every derived number labeled with its provenance (gateway-billed vs estimated vs heuristic), so that I know what to trust.
24. As an aiand user, I want coverage gaps surfaced (sync lag, missing days), so that summaries never silently fold incomplete data.
25. As an aiand user, I want a doctor command that checks gateway reachability, auth, adapter wiring, and store health, so that "why are my numbers empty?" is answerable in one command.
26. As an aiand user, I want task-type and one-shot/retry ("did the model fix it right away?") metrics per model × harness, so that quality — not just cost — drives my choice.
27. As an open-source contributor, I want the observability docs to state the privacy posture (metadata-only, local-first) and the accuracy rules, so that I can contribute without breaking trust.
28. As a team admin, I want org-wide views filtered by user and billing mode, so that I can govern team spend on ai&.

## Implementation Decisions

- **Data source of truth is the gateway**: `/logs` per-request rows (model, masked api_key, status, ttft_ms, latency_ms, input/output/cached tokens, cost+currency, timestamp) via the existing paged client; `/analytics` summary (up to 3 months) for reconciliation and long windows. `input_tokens` includes `cached_tokens`; cache-write split is not available server-side.
- **Local store**: SQLite via better-sqlite3 under the aiand config dir; one row per gateway request keyed by the gateway log id; numbered migrations; corrupt-store recovery; metadata only (no prompts, no completions, ever).
- **Sync**: incremental with a watermark (max synced id/timestamp), run before observability commands, `--no-sync` opt-out; a follow/watch mode protects history against the 30-day server window. The local store is the only long-term archive.
- **Attribution**: the existing masked-key→agent map (fingerprinted, written at wiring time) is the harness attribution layer; unknown keys are reported as unknown and labelable, never guessed.
- **Sessionization**: heuristic grouping per key on request-time gaps (default ≤10 min, configurable), with manual override flags and a confidence annotation; server session ids do not exist today.
- **Reporting**: local store powers day/week/month/session blocks with filters (`--since/--until/--last/--timezone/--agent/--model/--harness`), per-model breakdowns, `--json` + `--jq` + CSV, compact/no-cost table modes, multi-section single-load reports.
- **Comparison**: extend the existing cache-report aggregation to per-harness and per-(harness, model) views with cost, tokens, turns, TTFT p50/p95, cache hit ratio, error rate, and verdict thresholds (warn under 5 samples; bad under 0.2 hit ratio; warn under 0.5 — matching the existing verdict function). Cohort discipline: medians + P90, mixed-model sessions excluded and counted for `compare`; per-(harness, model) views attribute mixed-model sessions per model — each model-slice is a session sample for its pair; inspectable samples.
- **Benchmarks**: keep the existing synthetic shape benchmark and scenario framework; add scenarios; add a deterministic offline replay with golden fixtures as a CI gate; add a personal A/B replay that replays recorded session *shapes* (turn counts and prompt growth curves — never prompt text) across (layout, model) pairs.
- **Forecasting**: v1 is burn-rate extrapolation against a configurable budget (current + rate × remaining; P90 of history to suggest budgets); v2 is a calibrated Gamma-process Monte-Carlo with credible intervals and a self-scoring bench (model spec exists publicly in claumon's MODEL.tex).
- **Exports**: OTel both families — Claude Code-compatible counters and vendor-neutral GenAI semconv names — emitted from the local store so counters don't collide across processes; MCP server exposing usage/session/comparison tools; ccusage JSON import kept outside gateway totals by default.
- **Machine contract**: versioned, atomically-written state snapshot + automation exit codes (ok / near-limit / limit-hit / indeterminate / no-data).
- **Trust rules**: derived numbers carry provenance labels; reconciliation is a first-class command and CI test; gateway cost is used as-is (price tables only for explicitly-labeled estimates like vendor-list-price comparison, with alias/override handling and a never-guess policy).
- **Adapter envelope (gateway-dependent)**: a compact per-request metadata header (tool names, edit targets, project/branch) forwarded by adapters unlocks task classification, one-shot/retry metrics, and project/branch attribution; CLI ships the schema, adapter capture, and offline fallbacks; server field is a tracked gateway ask.

## Testing Decisions

- Good tests assert external behavior: command output shapes (`--json`), reconciliation against canned gateway fixtures, and store round-trips — never internal module details.
- The accuracy gate is a first-class test: local sums must equal `/logs` fixture totals per window and `/analytics` fixtures for long windows.
- The deterministic benchmark replay compares cost-unit computation against golden files, so pricing/reconciler changes that drift fail CI.
- Sessionization and attribution get fixture-driven tests including gap boundaries, unknown keys, and corrupt-map degradation.
- Prior art: existing aiand-cli command tests and the CacheLane storage/benchmark test suites (referenced in the feature catalog).

## Out of Scope

- The CacheLane proxy itself (request rewriting, cache-control breakpoints, pruning, compression, keepalive) — cost optimization, not observability.
- Vendor quota scraping (Anthropic/OpenAI rate-limit endpoints) — aiand is prepaid; forecast budget, not foreign quotas.
- Hosted/team backend services — the gateway is the shared backend.
- Local-file harness transcript parsers as a primary data source — only the explicit ccusage JSON import adapter.
- Budget enforcement server-side (per-key caps) — tracked as a gateway ask, not built here.

## Further Notes

- Phase ordering and per-feature details live in the feature catalog (A1–H5 IDs referenced by every ticket). Tickets are vertical slices with explicit blockers; anything not blocked by the local-store ticket can start immediately.
- NEEDS-GATEWAY items are consolidated in one tracking ticket so server-side asks stay visible without blocking CLI work.
