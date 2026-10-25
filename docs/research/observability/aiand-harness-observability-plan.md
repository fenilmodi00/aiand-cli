# Plan: Port Harness Observability into aiand-cli

Companion to `docs/research/harness-observability-research-2026-10-25.md` (demand evidence, citations) and `docs/research/aiand-observability-feature-catalog.md` (**the full feature-by-feature catalog** — every feature from every researched repo, with verdicts, implementation sketches, target repo, and phase; this plan's phases reference it). This plan maps the observability stack of this repo (CacheLane / Harness-bench) onto aiand-cli, ordered by researched demand, and states what deliberately does **not** port.

Date: 2026-10-25 · Status: proposal, not yet approved for implementation.

---

## 0. Positioning (why aiand can win this)

Research conclusion: per-harness *reporting* is already commoditized at scale — [ccusage](https://github.com/ccusage/ccusage) 19.2k★ (Rust rewrite, multi-tool) and [CodeBurn](https://github.com/getagentseal/codeburn) 11.6k★ (37 tools, per-model/project/task breakdowns) both parse local files per tool, and both fight recurring accuracy complaints (ccusage #288/#483/#705: "live usage is wrong"). Every local-file scraper shares that weakness: it re-derives cost from price tables and reconstructed logs. The unmet needs are (1) **normalized cross-harness comparison**, (2) **outcome metrics** (turns, success), (3) **trustworthy, billing-grade accounting**, (4) **forecasting**, (5) **programmatic/export access**.

aiand-cli's structural advantage: every wired agent already routes through the ai& gateway, whose `/logs` normalizes both wire dialects (Anthropic vs OpenAI) to one convention. Everyone else scrapes heterogeneous local files; aiand reads one normalized, org-wide source of truth and can attribute each request to a harness via the per-agent API key. The port is therefore **gateway-first with a local cache**, not a port of the CacheLane proxy.

**Out of scope (explicitly):** the proxy itself — request rewriting, cache_control breakpoints, K-pruning, compression, keepalive. Those are cost-*optimization* features of CacheLane, not observability, and they assume a local Anthropic-terminating proxy that contradicts aiand's gateway architecture.

---

## 1. Source→target feature map

| CacheLane/Harness-bench (source) | aiand-cli (target) | Demand evidence (research §4) |
|---|---|---|
| Per-turn SQLite records (workspace/session/turn, model, provider, harness, tokens, tiers) | Local store of gateway `/logs` rows, sessionized; harness = attributed agent key | #1, #3 |
| `harness/stats --by-harness` + `harnessHealth` verdicts | `aiand harness stats` — real-workload per-harness stats + health verdicts (cache_hit_ratio < 0.2 → bad, etc.) | #1, #3, #9 |
| `benchmark harness-compare` | `aiand harness compare` — side-by-side table across harnesses on **your own workload** (the gap no product fills) | #6, research §6.1 |
| `stats --scope session/workspace/all`, `sessions` | `aiand usage --by session \| harness \| project` + `aiand sessions` | #1, #4 |
| `report` (self-contained HTML) | `aiand report` — same pattern: one offline HTML file, no server, no upload | #4, local-first signal |
| `explain --top-blocks` (per-block attribution) | Tier-level attribution now (cache read/write/input per turn); block-level only if gateway exposes block/tier detail — degrade gracefully | #4, #11 |
| `benchmark latency` (TTFT A/B) | Fold TTFT/latency into per-harness stats from logs (gateway already times requests) | metric #6 |
| Recorded replay benchmark (`BENCHMARK.md`) | Keep in aiand as the synthetic `aiand harness` scenarios (already exists); add regression gate comparing claimed vs logged numbers | accuracy is table stakes |
| MCP `cachelane_stats`/`cachelane_harness_stats` | Phase 3: `aiand mcp` exposing usage/stats to agents themselves (claude-code#11008 wants exactly this) | research §6.3 |
| — (not in source) | `aiand export --format csv\|json\|otel` — clean per-session series, no cross-process counter collisions | #7 |
| — (not in source) | `aiand forecast` — 5h/weekly burn-rate projection | #5 |
| — (not in source) | Turns-to-completion & session outcome tracking | research §6.2 |

Not ported / deprioritized: budgets & alerts (org-tier concern, weak local-CLI demand — research §4 contrarian signals); anything requiring prompt bodies (privacy posture: metadata only, matching CacheLane's default and the community's local-first expectation).

---

## 2. Gateway API audit — verified 2026-10-25 (from aiand-cli `src/api/`)

Read-only audit of the target repo resolved the plan's biggest unknowns:

**`/logs` (src/api/logs.ts) — per-request rows, exactly what P0 needs:**
`id, model, api_key (masked), status_code, ttft_ms, latency_ms, input_tokens, output_tokens, cached_tokens, cost (string, gateway-computed), currency, created_at`. Constraints: page size ≤ 100 with cursor pagination (`next_after`/`next_after_id`); ranges only `15m…30days` — **no history beyond 30 days is fetchable**. Convention (verified in cache-report.ts against the gateway's own arithmetic): `input_tokens` **includes** `cached_tokens`; cache-write tokens are not split out (folded into `cost`).

**`/analytics` (src/api/analytics.ts):** summary (requests/tokens, current vs previous period, timeseries) up to **3 months** — the reconciliation reference beyond /logs' 30-day window.

**Already ported (more than the plan assumed):** `src/api/cache-report.ts` builds per-agent/per-model/per-key cache reports over /logs rows with hit ratio, `costIfUncached`, `savedUsd`, misses, per-model **live-catalog pricing** (no local price tables), and `cacheVerdict` (requests<5→warn, hit<0.2→bad, <0.5→warn — explicitly "in the same spirit as CacheLane's harness health check"). `src/commands/harness.ts` + `src/benchmark/` provide the synthetic shape benchmark with scenario/layout framework. So P1 is an *extension* of existing modules (sessions, turns, time-series, comparison framing), not a green-field build.

**Consequences for the data model:**
- Local store is not just a cache — **it becomes the only long-term history** (gateway serves ≥30 days only). Sync must run incrementally with a watermark (last synced `id`/`created_at`) before each stats command, and a `--follow`/watch mode matters sooner (P2, not P3).
- `requests` row = LogEntry + derived: `session_id (derived), harness (agent-key map), ttft_ms, latency_ms` — no `cache_write` split, no server session id, no reasoning level.
- Sessionization is genuinely heuristic (gap-based on `api_key` + `created_at`); v1 heuristic + `--session` overrides, documented.
- Attribution = existing masked-key→agent map (`agent-keys.ts`, `aiand cache --attribute`); unknown stays `unknown`, never guessed.

**Accuracy gate (non-negotiable, per research):** reconciliation asserting local sums == `/logs` totals (≤30d windows) and == `/analytics/summary` (≤3 months). ccusage's biggest complaint cluster is wrong numbers; aiand's differentiator must be "reconciles exactly to what you were billed."

## 3. Phases

**P0 — Foundation (accuracy + sessionization).**
Sync/normalize/persist gateway logs locally (`aiand usage --sync` or auto on first stats command); attribution + sessionization; reconciliation tests. No new user-facing commands beyond what exists.

**P1 — The demanded surface.**
`aiand usage --by session|harness|project` · `aiand sessions` · `aiand harness stats [--harness x]` (real-workload: cost, tokens, turns, cache hit, TTFT + health verdicts) · `aiand harness compare` (side-by-side, wins/losses per metric, on your data) · `--json` everywhere, CSV export.
Exit criterion: "same repo, last 30 days, claude vs codex vs opencode — one table" works.

**P2 — Visibility & forecasting.**
`aiand report` (offline HTML dashboard: per-harness cost/time series, cache savings, top sessions); `aiand forecast` (burn-rate projection for configurable 5h/weekly windows); statusline-friendly `aiand usage --watch --format line`.

**P3 — Programmatic & outcomes.**
`aiand export --format otel` (clean counters/series); `aiand mcp` exposing usage/stats tools to agents; turns-to-completion + session-outcome tracking (labeled as derived, honest about heuristics); optional "wrapped" summary (low priority, novelty demand).

Each phase ships behind the existing command family (`aiand usage/cache/harness`) rather than new top-level verbs, keeping README's command table coherent.

## 4. Alternatives considered

**Fork ccusage (19.2k★, MIT) and make it aiand-specific — rejected.** Its architecture is local-file scraping + vendor price tables, which is exactly the accuracy weakness aiand's gateway-side data eliminates (and it would price aiand-routed traffic with Anthropic's table, disagreeing with the user's actual bill). The demanded differentiators (cross-harness compare, outcomes, forecasting, MCP/OTel, billing reconciliation) aren't in ccusage, so the valuable work remains ours; and its TS→Rust rewrite doesn't fit aiand-cli's Node/TS stack. **Adopted instead:** stay gateway-first, and optionally (P3) consume `ccusage --json` as an import adapter for non-aiand traffic, plus consider contributing an aiand provider upstream (marketing reach into its user base).

## 5. Risks

1. **Gateway log fidelity — resolved by audit (§2):** no session ids and no cache-write split server-side, so sessionization is heuristic and tier attribution is cache-read-only; acceptable for P1 with documented limits. New constraint: `/logs` serves only the last 30 days — users who adopt late lose older history unless a background/watch sync ships early (promote to P2, alongside existing `aiand logs --follow`).
2. **Sessionization correctness** — mis-grouping breaks trust; ship overrides and show confidence.
3. **Cost model drift** — model prices change; reuse the gateway's own cost numbers rather than local price tables (ccusage's pricing-schema pain, models.dev#290).
4. **Scope creep toward the proxy** — resist; optimization is a different product.

## 6. Immediate next steps (once approved)

1. ~~Audit aiand gateway `/logs` + `/usage` API fields~~ **Done 2026-10-25 — findings in §2.**
2. Spike P0 sync + one reconciliation test in aiand-cli (branch off main; note this repo's `aiand-cli` branch is the Harness-bench working branch, not the target repo).
3. Draft `aiand harness stats/compare` CLI spec against the existing `src/commands` + `src/benchmark` structure.
