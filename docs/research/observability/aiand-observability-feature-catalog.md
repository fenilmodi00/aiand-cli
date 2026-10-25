# aiand-cli Observability Feature Catalog

Companion to `aiand-harness-observability-plan.md` (strategy, phases, risks) and `harness-observability-research-2026-10-25.md` (demand evidence). This catalog lists **every candidate feature** collected from the researched repos (CacheLane, ccusage, CodeBurn, Claude-Code-Usage-Monitor, claumon, caut, summer, agentgraphed, spenda, tray apps, OTel), and for each: source, verdict, concrete implementation, target repo, and phase. External-repo feature extractions with sources are in the Appendix.

**Positioning (fixed):** aiand-cli is the ai&-provider-native observability CLI. Coding harnesses (Claude Code, Codex, OpenCode, Pi, OMP, Copilot, Hermes) are **adapters** in `src/agents/`. The product goal is **decision support**: with billing-grade gateway data + synthetic benchmarks, tell the user *which model × which harness* performs best **for their own workload**. aiand-cli will be open-sourced.

**Target repos:**
- **aiand-cli** (`fenilmodi00/aiand-cli`, Node ≥22/TS) — everything user-facing.
- **aiand gateway** (server) — only where a feature needs new server behavior; marked `NEEDS-GATEWAY`.
- **Harness-bench / CacheLane** (this repo) — reference implementation for patterns; the proxy itself is out of scope.

**Integration map (verified 2026-10-25):**
| Point | File | Role |
|---|---|---|
| Command registry | `src/commands/index.ts` (`COMMANDS[]`: name/summary/help/run/aliases) | add/extend commands; `usage` already aliases `analytics` |
| Adapter registry | `src/agents/registry.ts` + per-agent dirs + `types.ts` (`bakedKey()` hook) | harness adapters; attribution source; future: per-request envelope forwarding |
| Attribution map | `src/api/agent-keys.ts` (masked key + SHA-256 fingerprint → agent; `collectBakedKeys`, `agentForMaskedKey`, `--attribute`) | THE harness-attribution layer; extend, don't replace |
| Log source | `src/api/logs.ts` (`getLogsPaged`, cursor, ≤100/page, ranges 15m–30days) | per-request billing-grade rows |
| Org totals | `src/api/analytics.ts` (summary ≤3 months, metrics) | reconciliation + long-window aggregates |
| Cache report | `src/api/cache-report.ts` (per-agent/model/key groups, hitRatio, savedUsd, `cacheVerdict`) | P1 builds on this |
| Synthetic bench | `src/benchmark/harness-bench.ts`, `harness-layouts.ts`, `scenarios.ts` + `src/commands/harness.ts` | shape benchmark; scenario framework to extend |
| CacheLane reference | this repo: `src/cli/index.ts` (commands, lines 327–1002), `src/storage/` (SQLite, 12 migrations, `recovery.ts`), `src/reconciler/`, `src/report/` (render-html/charts/theme), `src/benchmark/` (recorded/duel/latency-ab/dashboard-TUI), `src/agent-traces/` (scenarios + dialect providers), `src/server/index.ts` (MCP tools), `src/cli/format.ts` (`harnessHealth`) | port patterns from here |

Phases: **P0** foundation → **P1** demanded surface → **P2** visibility/forecast/insight → **P3** programmatic/outcomes. Verdicts: ADOPT / ADAPT / SKIP(+why).

---

## A. Data foundation (repo = aiand-cli)

| ID | Feature | Source | Verdict | Implementation | Phase |
|---|---|---|---|---|---|
| A1 | **Incremental `/logs` sync + local SQLite store** | CacheLane `src/storage/` pattern (better-sqlite3, numbered migrations, corrupt-DB `recovery.ts`) | ADOPT | New `src/store/`: `requests` table keyed by log `id`; watermark = max synced `id`/`created_at`; sync before stats commands (`--no-sync` opt-out). Metadata only | P0 |
| A2 | **Long-term retention beyond the 30-day `/logs` window** | gateway constraint (§plan 2) | ADOPT | Local store *is* the archive; `--range 90days` reads local rows >30d; surface coverage gaps explicitly (CodeBurn honesty pattern) | P0 |
| A3 | **Harness attribution** (exists) | `agent-keys.ts` | EXTEND | Surface `unattributed` count + hint; machine vs org views | P0 |
| A4 | **Sessionization (heuristic)** | CacheLane sessions; no server session id | ADOPT | Group by (`api_key`, gap ≤ 10 min, configurable); sessions table (started/ended, turns, totals); `--session` override; confidence note in `--json` | P0 |
| A5 | **Reconciliation gate** | ccusage accuracy failures (research §4) | ADOPT | Test + `aiand usage --verify`: local sums vs `/logs` (≤30d) and `/analytics/summary` (≤3mo); mismatches reported, never hidden | P0 |

## B. Usage & cost reporting (repo = aiand-cli)

| ID | Feature | Source | Verdict | Implementation | Phase |
|---|---|---|---|---|---|
| B1 | Daily/weekly/monthly **usage blocks** | ccusage `run_daily`/`run_bucket` | ADAPT | `aiand usage --by day\|week\|month\|session` from local store; sessions keyed by our sessionization (gateway has no project_path/session_id) | P1 |
| B2 | **Per-session usage** | CacheLane `stats --scope session`; ccusage `session <id>` drill-down | ADOPT | `aiand usage --by session` + `aiand sessions <id>` request-level drill-down (maps 1:1 to log entries) | P1 |
| B3 | **Sessions table** | CacheLane `sessions` (:411); CodeBurn top-5-expensive | ADOPT | `aiand sessions` — id, harness, model mix, turns, tokens, cost, TTFT p50/p95, error count; `--top-cost` | P1 |
| B4 | **Per-project breakdown** | ccusage `--project/--instances`; CodeBurn by-project | ADAPT | NEEDS-GATEWAY (client/project field) or adapter-side key-alias per project; v1: `aiand cache --attribute project=x` labeling | P2 |
| B5 | **Turns per session** (+ outcome later) | research gap #2 | ADOPT | Turns = session request count (have today); outcomes in P3 | P1 |
| B6 | **Cost in billing currency** (+ FX display) | aiand `models --currency`; CodeBurn Frankfurter FX cache | ADOPT | `cost`/`currency` per request already; add display-currency conversion with cached FX rates | P1–P2 |
| B7 | **Report UX conventions** | ccusage parser/CLI | ADOPT | `--since/--until/--last N/--timezone/--order/--sort`, `--breakdown/-b` per-model rows, `--sections a,b,c` (multi-section from ONE data load), `--compact` + auto-compact <100 cols, `--no-cost` (shareable), color auto-drop when piped, `--jq <filter>` on `--json`, negatable flags, config file sections | P1 |
| B8 | **Equivalent vendor-price value** ("what this would cost elsewhere") | spenda real-vs-equivalent; research metric #2 (API-equivalent value) | ADAPT | `aiand usage --vs-list`: recompute tokens at vendor list prices (LiteLLM/models.dev snapshot, CodeBurn alias/override handling, never-guess policy) vs gateway `cost`; shows ai& savings honestly | P2 |
| B9 | **Peak/off-peak split** | CodeBurn `peak-hours.ts` (GLM/Z.ai 14:00–18:00 SGT windows; DeepSeek UTC windows) | ADOPT | Pure GROUP BY on stored timestamps + per-model window table from catalog; aiand serves GLM where this pricing is real | P2 |

## C. Cross-harness comparison — the differentiator (repo = aiand-cli)

| ID | Feature | Source | Verdict | Implementation | Phase |
|---|---|---|---|---|---|
| C1 | **`aiand harness compare`** (real workload) | CacheLane `harness-compare` (:842), `harness/stats --by-harness` (:427) | ADOPT | Extend `cache-report.ts` grouping: per-agent rows — cost, tokens, turns, TTFT p50/p95, hit-ratio, error rate + verdict column; winner highlighting per metric | P1 |
| C2 | **Model × harness matrix** | existing `harness --sweep-models` (synthetic); summer's group-by harness×model×user×billing-mode | ADAPT | Join synthetic sweep with real-workload stats per (agent, model): "cheapest pair *for you*" | P1–P2 |
| C3 | **Task-type classification (13 categories)** | CodeBurn `classifier.ts` (deterministic, zero LLM) | ADAPT | Gateway sees no tool calls → adapters forward a compact per-request envelope (tool names, edit targets) in a header/metadata (NEEDS-GATEWAY field); keep CodeBurn taxonomy + deterministic citeable rules; until then: SKIP client-side guessing | P3 |
| C4 | **Recommendation engine** | user goal; research §1 | ADOPT | Presentation layer over C1/C2/D: rank (harness, model) pairs by $/session, TTFT, hit-ratio, error rate, min-sample guard (<5 → "insufficient data"); suggest `aiand <agent> on --model X` | P2 |
| C5 | **One-shot rate / retry detection** ⭐ | CodeBurn `model-efficiency.ts` (retry = same file re-edited after a shell command in between) | ADAPT | **Flagship metric** for model×harness choice; needs the adapter envelope (C3); gateway-side approximation possible via repeated-shape patterns but must be labeled heuristic | P2–P3 |
| C6 | **Compare cohorts discipline** | CodeBurn `compare-cohorts.ts` | ADOPT | Same-kind-of-work cohorts, median + P90 with inspectable sample list, mixed-model turns excluded-and-counted, never assigned; add TTFT/latency (CodeBurn can't see them) | P2 |
| C7 | **Yield analysis** (did the spend ship?) | CodeBurn `yield.ts` (git correlation: productive/reverted/abandoned) | ADAPT | Client-side git correlation over sessions from our store; cost per commit, per productive session | P3 |

## D. Benchmarks — synthetic + personal (repo = aiand-cli)

| ID | Feature | Source | Verdict | Implementation | Phase |
|---|---|---|---|---|---|
| D1 | Synthetic shape benchmark | **exists** (`harness-bench.ts`, 6 layouts) | EXTEND | Add scenarios from CacheLane `src/agent-traces/scenarios.ts`; keep dialect provider pattern (`providers/anthropic-messages.ts`, `openai-chat.ts`) | P1 |
| D2 | **Personal A/B replay (`aiand harness duel`)** | CacheLane `benchmark duel` + recorded replay | ADAPT | Replay a recorded session's request *shapes* (turn count, prompt growth curve from local store — no prompt text leaves the machine) across (layout, model) pairs; report cost/TTFT/hit side by side | P2 |
| D3 | Latency/TTFT A/B | CacheLane `latency-ab`; `/logs` ttft_ms | ADAPT | Benchmark loop per (layout, model) vs historical `/logs` TTFT percentiles — no proxy needed | P2 |
| D4 | Deterministic offline regression | CacheLane recorded benchmark (BENCHMARK.md) | ADOPT | CI gate: replay fixtures → assert cost units match golden files | P1 |

## E. Budget, burn & forecasting (repo = aiand-cli)

| ID | Feature | Source | Verdict | Implementation | Phase |
|---|---|---|---|---|---|
| E1 | **Burn-rate projection v1** | CC-Usage-Monitor `core/calculations.py` (`projected = current + rate·remaining`; P90 auto-limit from history `p90_calculator.py`) | ADOPT | Project budget-window spend from local time-series; P90 of past windows auto-suggests monthly budget | P2 |
| E2 | **Calibrated forecast v2** | claumon `internal/forecast/MODEL.tex` v2.2 — OLS slope (last 30 min) + normal-normal conjugate prior from past windows; Gamma-process path; rectified-Gaussian rate; K=500 seeded MC → 80% CI; calibration via weighted error regression; `bench` scores CRPS/pinball/coverage | ADAPT | Same math on our budget-utilization series; ETA-to-threshold with CI; `aiand forecast bench` self-scoring harness | P3 |
| E3 | **Statusline / watch** | ccusage statusline (format + stale-while-refresh mtime cache); claumon "45%→72% session" | ADOPT | `aiand status`: `💰 $2.10 session / $8.40 today / $1.30 hour (42m) | 🔥 $1.85/hr | ttft p50 320ms`; `--watch`; state-file for Claude Code statusLine hooks | P2 |
| E4 | **Budget caps + pacing verdicts** | CodeBurn `guard` (warn $5/stop $15, `guard allow` escape hatch); Usage4Claude pace colors | ADAPT | `aiand config set budget.*`; warn at 80%; pacing verdict (on-pace/exceeding); live enforcement = NEEDS-GATEWAY (per-key caps server-side) | P2 |

## F. Dashboards & surfaces (repo = aiand-cli)

| ID | Feature | Source | Verdict | Implementation | Phase |
|---|---|---|---|---|---|
| F1 | **Offline HTML report** | CacheLane `src/report/` (self-contained, no CDN) | ADOPT | `aiand report [--range] [--open]`: per-harness cost/savings time-series, comparison matrix, sessions table | P2 |
| F2 | **Interactive TUI dashboard** | CodeBurn `dashboard.tsx` (period keys 1–6, `p` tool-switch, `c` compare, in-place refresh ≥60s preserving scroll, top-5 expensive sessions always visible) | ADAPT | `aiand dashboard` after F1; steal the keyboard model wholesale | P3 |
| F3 | **Plain-text `overview`** | CodeBurn `overview` (copy-pasteable month summary; color-drop when piped) | ADOPT | `aiand overview` — shareable in PRs/Slack | P2 |
| F4 | **Activity heatmap** | agentgraphed 24h heatmap | ADAPT | Terminal heatmap of spend by hour/day from local store | P3 |
| F5 | **"Wrapped" period summary** | Claude Wrapped / yearincode (novelty demand) | ADAPT | `aiand wrapped` — fun aggregate; share-friendly for open-source marketing | P3 |

## G. Exports & integrations

| ID | Feature | Source | Verdict | Implementation | Phase |
|---|---|---|---|---|---|
| G1 | `--json` everywhere + `--jq` + CSV | ccusage; claude-code#1549 | ADOPT | Convention exists; add `--jq`, `--format csv` on usage/sessions/compare | P1 |
| G2 | **OTel-compatible export** | Claude Code OTel metrics; GenAI semconv (exact names: Appendix §3) | ADAPT | `aiand export --format otel` from local store: both families — `claude_code.*` (drop-in dash compat) + `gen_ai.*` (vendor-neutral); per-agent cost counters that don't collide across processes (fixes claude-code#56317 class); temporality delta default, cumulative option | P3 |
| G3 | **MCP server** (`aiand mcp`) | CodeBurn `mcp/` (`get_usage`, `get_savings`); claude-code#11008 (👍34); CacheLane `server/index.ts` | ADOPT | stdio tools: `usage_stats`, `session_stats`, `harness_compare`, `spend_check`; lets agents budget themselves; pseudonymize project names unless asked (CodeBurn pattern) | P3 |
| G4 | **ccusage import adapter** | plan §4 (fork rejected); CodeBurn gateway-totals include/exclude pattern | ADOPT | `aiand usage --import-ccusage <(ccusage --json …)`; imported rows shown separately, excluded from gateway totals by default (anti-double-count) | P3 |
| G5 | **Machine snapshot contract** | CC-Usage-Monitor `--once --output json --write-state` (versioned, atomic) + automation exit codes (0 ok / 10 near-limit / 11 limit-hit / 20 indeterminate / 30 no-data) | ADOPT | `aiand status --write-state`: versioned JSON state file for tray apps/companion UIs/CI; adopt the exit-code contract so scripts and agents can gate on it | P2 |
| G6 | Team/org views | summer group-by (harness×model×user×billing-mode) | ADAPT | Gateway is org-wide already — `--user`, `--billing-mode` filters once gateway exposes them; no local daemon needed | P3 |

## H. Trust, accuracy, privacy (repo = aiand-cli)

| ID | Feature | Source | Verdict | Implementation | Phase |
|---|---|---|---|---|---|
| H1 | Accuracy-first posture | ccusage accuracy complaints; research §4 | ADOPT | A5 reconciliation + D4 golden fixtures + "gateway numbers, never price tables" rule in CONTRIBUTING | P0–P1 |
| H2 | Local-first, metadata-only | CacheLane privacy posture; CodeBurn telemetry discipline (CLI sends nothing; opt-in bucketed magnitudes) | ADOPT | No prompts/completions persisted; document in SECURITY.md | P0 |
| H3 | **Provenance labels** | CC-Monitor confidence labels (official/local_estimate/experimental); CodeBurn `audit` (source of every number); spenda `est.` marks | ADOPT | Every derived number labeled `gateway-billed` / `estimated(<source>)` / `heuristic`; `aiand usage --audit` prints provenance table | P1 |
| H4 | **Coverage-gap honesty** | CodeBurn compare-periods lists unexplained days; Maciek stale-capture flag | ADOPT | Show ingestion lag + days with missing data instead of folding them silently | P1 |
| H5 | **`aiand doctor`** | CacheLane `doctor`; CodeBurn/`spenda doctor` verdicts (`OK (n) / NOTHING FOUND / ERRORS`) | ADAPT | Check gateway reachability, auth, adapter wiring, log-ingestion lag, store health; one-line verdicts | P1 |

---

## Consolidated view (what lands where)

- **aiand-cli P0:** A1–A5, H1–H2
- **aiand-cli P1:** B1–B3, B5–B7, C1, C6(discipline), D1, D4, G1, H3–H5
- **aiand-cli P2:** B4, B8, B9, C2, C4, C5, D2, D3, E1, E3, E4, F1, F3, G5
- **aiand-cli P3:** B5(outcomes), C3, C7, E2, F2, F4, F5, G2–G4, G6
- **NEEDS-GATEWAY (gateway repo roadmap):** per-request client/project metadata field; adapter-envelope header (tool/edit metadata for C3/C5); cache-write token split; server session ids; per-key budget caps; user/billing-mode filters.
- **Deliberately SKIP:** local-file parsers (gateway sees everything), price-table-first costing (gateway cost is billing-grade), dedup machinery (no double-count server-side), hosted team backend (gateway is the backend), vendor-quota scraping (aiand is prepaid; forecast budget, not Anthropic quota).

---

## Appendix: external-repo feature extraction

### 1. ccusage (19.2k★, Rust monorepo) — report/UX surface is the standard; scraping machinery irrelevant

**ADOPT:** daily/weekly/monthly/session reports · `--breakdown` per-model rows · `--sections` multi-report from one load · filters (`--since/--until/--last/--timezone/--order/--sort`) · `--compact`/auto-compact <100 cols · `--no-cost` · `--jq` · statusline (format + stale-while-refresh mtime cache) · config file with per-command sections · bare invocation = unified report · `session <id>` drill-down.
**ADAPT:** per-harness subcommands → `--harness` filter; blocks (5h windows) → generalized rolling-window + burn UX; `--project` → adapter/key-based project identity; display-vs-calculate cost modes → gateway-cost vs recompute-from-table.
**SKIP:** dual pricing snapshots + per-event timestamp pricing + long-context/fast/flex tiers (gateway returns billed cost), offline mode, 18-source local parsers, JSONL dedup.
Sources: `rust/crates/ccusage/src/commands/mod.rs`, `rust/crates/ccusage/src/cli.rs`, `rust/crates/ccusage-cli-parser/` (cli-commands.json, root_help.snap), `rust/crates/ccusage-core/src/pricing.rs`, `rust/adapters/*`.

### 2. CodeBurn (11.6k★, TypeScript) — the insight layer to match and beat

**ADOPT:** TUI dashboard spec (period keys 1–6, in-place refresh, top-5 sessions) · plain-text `overview` · one-shot/retry metric (flagship, via envelope) · `compare` + cohorts discipline (median/P90, mixed-turn exclusion, sample lists) · models matrix (`--by-task/--by-agent/--top/--unpriced/--format markdown`) · peak/off-peak split · guard (warn/stop + `allow` escape hatch) · plan/pacing ("on pace to exceed", projected figure/date) · `audit` provenance · `doctor` verdicts · currency FX cache · MCP server (get_usage/get_savings, pseudonymized) · status/streak · telemetry discipline.
**ADAPT:** task classification (13 categories, deterministic — needs adapter envelope) · branch spend (turn-by-turn attribution + coverage notes — needs git metadata) · yield (git correlation, productive/reverted/abandoned) · `context <id>` (context-window composition — needs content; offer token-composition proxy) · optimize findings→action→verify loop (re-target at gateway waste: cache-miss-heavy harnesses, wrong model for task) · subagent fan-out (`--by-work-unit`, needs parent/child linkage) · 10-year daily cache (gateway retains; keep honesty pattern) · gateway-source include/exclude default (for G4).
**SKIP:** menubar/VS Code surfaces (later, not core), multi-device PIN pairing (gateway is shared).
Sources: `src/classifier.ts`, `model-efficiency.ts`, `compare*.ts*`, `optimize.ts`, `yield.ts`, `branch-spend.ts`, `work-units.ts`, `guard/`, `mcp/`, `peak-hours.ts`, `doctor.ts`, `audit-report.ts`, `daily-cache.ts`, docs/{how-it-works,cli,optimize,guard,plans-and-quota,yield,by-branch,mcp}.md.

### 3. OTel metric names to emit (G2)

**`claude_code.*` (drop-in dash compat; source: code.claude.com/docs/en/monitoring-usage):** counters `claude_code.session.count` (start_type), `claude_code.cost.usage` (USD; attrs model, query_source, speed, effort, agent.name, skill.name, plugin.name, mcp_server.name, mcp_tool.name), `claude_code.token.usage` (type: input/output/cacheRead/cacheCreation — input EXCLUDES cache, unlike our /logs convention: convert), `claude_code.lines_of_code.count`, `claude_code.commit.count`, `claude_code.pull_request.count`, `claude_code.active_time.total`. Standard attrs: session.id, app.version, user/account ids, terminal.type; temporality delta default (offer cumulative); Prometheus :9464.
**`gen_ai.*` (vendor-neutral; semconv-genai, Development status):** counters `gen_ai.client.inference.usage.{input,output,cache_read,cache_write,reasoning}_tokens` (required attrs gen_ai.operation.name, gen_ai.provider.name, gen_ai.token.modality; gen_ai.request/response.model); histograms `gen_ai.client.inference.operation.{input,output}_tokens` (explicit buckets); latency `gen_ai.client.inference.duration`, `gen_ai.server.time_to_first_token` (= our ttft_ms), `gen_ai.server.request.duration`; `error.type` on failures; report billable tokens; usage on failed ops too. Map gateway upstreams to well-known `gen_ai.provider.name` values (anthropic, openai, deepseek, moonshot_ai, x_ai, …).
Sources: https://code.claude.com/docs/en/monitoring-usage · open-telemetry/semantic-conventions-genai `docs/gen-ai/{gen-ai-metrics,gen-ai-token-metrics,client-inference}.md`.

### 4. Forecasting algorithm specs (E1/E2)

- **claumon v2.2 (the rigorous one):** inputs = utilization snapshots u(t) + past completed windows (u*, D). Rate: OLS slope over last 30 min, conjugated with prior from past windows (ρ_s = u*/D_s, variance corrected for path noise); refit daily. Path: Gamma process increments (monotone, bounded by u_now); rate ~ rectified Gaussian (plateau fix; 80% coverage 55%→89% on LOSO). Output: point + 80% CI via K=500 seeded MC (5-min steps), uncapped above 1 (overshoot = demand); ETA-to-threshold median+CI or nil if p_∞≥0.5. Calibration: weighted LS of e² on [δ, δ²]. Bench: CRPS/pinball/coverage/bias. Source: `internal/forecast/MODEL.tex`.
- **CC-Usage-Monitor (the simple one):** tokens/min = totals/block_duration; projected = current + rate·remaining; hourly burn via proportional overlap attribution; P90-of-history auto-limit; reset-aware pace + limit-hit freeze. Sources: `core/calculations.py`, `core/p90_calculator.py`, `src/claude_monitor/data/analysis.py`.

### 5. Monitoring cluster — remaining patterns

- **caut (`caut.v1` schema):** normalized windows primary/secondary/tertiary with windowMinutes/resetsAt/usedPercent + credits + provider outage status; dual human/robot output; multi-account token store. → ADAPT schema for any future quota surfaces; SKIP fetch strategies.
- **summer:** group-by harness × model × user × billing-mode (→ C2/G6); SKIP hosted backend.
- **agentgraphed:** local SQLite outliving log rotation (= A1/A2 rationale), LLM work-type classification, 24h heatmap (F4), live quota probes (~$0.00006/token — cute, unnecessary for us).
- **spenda:** billing-backend disambiguation; subscription = $0 real + equivalent API value toggle (→ B8); `est.` labels (→ H3); documented accounting formulas (→ do the same in docs).
- **Tray apps (ClaudeBar/Usage4Claude/CodeZeno):** pace-aware color thresholds (healthy/warning/critical/depleted), per-limit icons, adaptive polling (1 min active → 10 min idle), webhooks, extension manifests. SKIP apps; our `--write-state` (G5) + `aiand status --format line` (E3) feed them.
- **Vendor quota window taxonomy** (for docs/NEEDS-GATEWAY later): Anthropic 5h + 7d + per-model weekly + extra credits; Codex 5h/weekly(180/10080 min) + credits; GLM 5h/weekly/monthly/MCP; Gemini per-model; Cursor monthly + credits; Copilot credits; read channels = statusline rate_limits JSON (official), OAuth /api/oauth/usage, limit-message parsing, P90 estimation.

### 6. Cross-cutting UX patterns to standardize

1. One data load → many report sections (`--sections`). 2. Block/burn line format (💰/🔥/🟢). 3. Negatable flags, auto-compact tables, `--compact`, color-drop when piped. 4. `--jq` on JSON. 5. TUI keyboard model (1–6 periods, p/c/o keys, in-place refresh). 6. Provenance honesty everywhere. 7. Doctor one-line verdicts. 8. Cohorts discipline (median/P90, exclusions counted). 9. Findings → action → verify loop with realized-savings report. 10. Budget guard with escape hatch. 11. Exit-code contract for automation (G5).

### 7. Source index (appendix)

- ccusage: [README](https://github.com/ccusage/ccusage) · [commands/mod.rs](https://github.com/ccusage/ccusage/blob/main/rust/crates/ccusage/src/commands/mod.rs) · [cli.rs](https://github.com/ccusage/ccusage/blob/main/rust/crates/ccusage/src/cli.rs) · [cli-commands.json](https://github.com/ccusage/ccusage/blob/main/rust/crates/ccusage-cli-parser/src/cli-commands.json) · [pricing.rs](https://github.com/ccusage/ccusage/blob/main/rust/crates/ccusage-core/src/pricing.rs)
- CodeBurn: [README](https://github.com/getagentseal/codeburn) · [how-it-works](https://github.com/getagentseal/codeburn/blob/main/docs/how-it-works.md) · [cli.md](https://github.com/getagentseal/codeburn/blob/main/docs/cli.md)
- CC-Usage-Monitor: [repo](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor) (analysis.py, calculations.py, p90_calculator.py, official.py, snapshots.py)
- claumon: [repo](https://github.com/fabioconcina/claumon) · [internal/forecast/MODEL.tex](https://github.com/fabioconcina/claumon/blob/main/internal/forecast/MODEL.tex)
- caut: [repo](https://github.com/Dicklesworthstone/coding_agent_usage_tracker) · summer: [repo](https://github.com/useautumn/summer) · agentgraphed: [repo](https://github.com/sudomichael/agentgraphed) · spenda: [repo](https://github.com/sshnaidm/spenda) · ClaudeBar: [repo](https://github.com/tddworks/ClaudeBar) · Usage4Claude: [repo](https://github.com/f-is-h/Usage4Claude) · CodeZeno monitor: [repo](https://github.com/CodeZeno/Claude-Code-Usage-Monitor)
- OTel: [Claude Code monitoring-usage](https://code.claude.com/docs/en/monitoring-usage) · [semantic-conventions-genai](https://github.com/open-telemetry/semantic-conventions-genai)
