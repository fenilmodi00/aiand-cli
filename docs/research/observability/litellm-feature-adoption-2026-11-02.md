# LiteLLM feature adoption review — what aiand-cli should take

Status: research proposal, 2026-11-02. Companion to
`aiand-observability-feature-catalog.md` (feature-by-feature catalog from other
repos) and `aiand-harness-observability-plan.md` (positioning, gateway audit).

Snapshot: [BerriAI/litellm](https://github.com/BerriAI/litellm) at
`ff3983c1f627ad09a5e36e45cc92a0cec91afb72` (2026-11-02), 3,020 Python files.
All paths below are relative to that commit.

**Decision (2026-11-02): local-only.** No gateway/API change, no inference
provider change, no agent-config or agent-behavior change. §7's gateway asks are
out of scope. The chosen behavioral source is the harnesses' own session files
through `aiand harness import`; live adapter capture is not used. Task-cohort
cost profiles and cost-per-clean-session are deferred because no request-linked
local source exists. Published tickets:
[#145 epic](https://github.com/fenilmodi00/aiand-cli/issues/145) and children
[#146](https://github.com/fenilmodi00/aiand-cli/issues/146),
[#147](https://github.com/fenilmodi00/aiand-cli/issues/147),
[#148](https://github.com/fenilmodi00/aiand-cli/issues/148),
[#149](https://github.com/fenilmodi00/aiand-cli/issues/149),
[#150](https://github.com/fenilmodi00/aiand-cli/issues/150),
[#151](https://github.com/fenilmodi00/aiand-cli/issues/151),
[#152](https://github.com/fenilmodi00/aiand-cli/issues/152).

## TL;DR

1. **LiteLLM is a gateway; aiand is a client.** Its proxy runtime (routing
   enforcement, virtual keys, budgets, guardrails, semantic cache, spend
   database) does not transfer. 76 distinct product capabilities were reviewed:
   6 adopt (4 as-is, 2 as a concept), 18 adapt, 6 defer, and 46 reject as
   server-side or contrary to aiand's no-proxy, metadata-only, zero-dependency
   design.
2. **The transferable core is decision quality, not more reports.** LiteLLM's
   routing strategies are rankers over latency, cost, quality, complexity, and
   success. aiand already has the rankers (`harness stats/compare/matrix`,
   `recommend`); it lacks the statistical evidence layer that makes a ranking
   trustworthy.
3. **Ship next: confidence-aware harness comparison and recommendation.**
   Today `harness compare` crowns a winner from raw p50 values and `recommend`
   ranks point estimates after a 5-session floor. With 5–20 sessions, noise wins.
   Add seeded bootstrap/Wilson intervals, `tied — not distinguishable yet`
   verdicts, and outcome-aware columns (clean rate, cost per clean session).
4. **Uncomfortable finding: the behavioral columns currently have no production
   data writer.** Adapter envelope capture was deleted as dead code in
   `ce3bb7d`; `harness import` writes `imported_artifacts`, and no reader
   consumes it. `harness stats` reads only `envelopes`. Until this loop is
   closed, one-shot/tool-error/clean-rate columns and task cohorts render `—`
   for real users. Fix this before building cohort features.
5. **Export the decision layer, don't just export tokens.** Add per-harness
   scorecard gauges (`aiand.harness.*`) and sync-reliability metrics to
   `aiand export`, plus the known Prometheus `# HELP` gap. That makes aiand a
   real observability source instead of a token counter.

## 1. Method and scope

Seven parallel research lanes:

| Lane | Surface reviewed | Result |
| --- | --- | --- |
| LiteLLM harness/agent | `litellm/harness/` (18 files), `proxy/agent_endpoints/` (17), `evals/`, `skills/`, `proxy/roi_calculator/`, `proxy/lens/`, `proxy/decisions/`, `proxy/memory/` | Runtime for agent CLIs, not a harness benchmark. Most is out of aim. |
| LiteLLM routing | `router_strategy/` (45 files), `router_utils/`, `router_config.py`, `scheduler.py`, budget limiter | Nine rankers; only latency/cost/complexity/quality ideas transfer. |
| LiteLLM spend | `proxy/spend_tracking/` (24), `management_endpoints/` (66), `schema.prisma`, auth spend scope | Server spend/keys/teams/budgets/audit. Confirms #80 gaps. |
| LiteLLM observability | `integrations/` (247), `tracing/` (16), Prometheus server, logging endpoints, guardrails (253), policy engine | Rich labels/semconv; most emission requires proxy state. |
| aiand current state | Commands, `src/obs/`, `src/store/`, `src/compare/`, `src/benchmark/`, `src/api/` | Capability matrix + duplicate surfaces + gaps. |
| External landscape | Terminal-Bench 2.0, SWE-bench Verified audit, Artificial Analysis Coding Agent Index v2.0, Vals, METR, LMArena, pass@k/pass^k | Cost-to-solve, task cohorts, confidence, pass^k are the credible signals. |
| aiand constraints | `src/api/*`, gateway OpenAPI (HTTP 200), docs, open issues | Endpoint/field matrix; `session_id` / harness echo remains the top ask. |

Evidence rules: every LiteLLM claim below names the file that contains it;
external claims cite a URL and access date. `[INFERENCE]` marks reasoning beyond
the code. Provider parity (100+ LLM integrations, wire-format adapters) was
deliberately not inventoried — it is not a product surface aiand can use.

**Not a benchmark.** LiteLLM's `Harness` enum
(`litellm/harness/types.py`) is a runtime for Claude Code, Codex, OpenCode, Pi,
DeepAgents, and ToolLoop. It does not compare coding harnesses. This review does
not copy it; it borrows its signal shapes (state, stop reasons, compaction,
prompt-cache accounting) only where they improve aiand metrics.

## 2. What aiand already has (do not re-propose)

| Surface | State |
| --- | --- |
| Gateway `/logs` sync + local SQLite archive | Billing-grade per-request cost/tokens/TTFT/status; 30-day gateway window, local history after. |
| Attribution | Masked key + wire dialect, refined by local usage match; unknown stays unknown. |
| Sessions | Time-gap heuristic (10 min), drill-down, mixed-model exclusion discipline. |
| Usage/cost reports | `usage`, `overview`, `report`, `dashboard`, `heatmap`, `wrapped`; provenance labels everywhere. |
| Harness reporting | `harness stats`, `harness compare`, `harness matrix`, `harness import`; cache/error/TTFT/behavioral columns. |
| Recommendation | `recommend` ranks observed (harness, model) pairs, min 5 sessions, prints wiring line. |
| Controlled evaluation | `compare add/validate/run/table/cohorts/audit`; task packs, Wilson solve CI, cost/solve, failure taxonomy. |
| Forecasting/budgets | Monthly + per-harness budget config, burn-rate v1, pacing verdicts, exit codes 0/10/11/20/30. |
| Exports | `gen_ai.*` OTel metrics + Prometheus text; delta/cumulative; no SDK dependency. |
| Behavioral capture | Envelope schema + store + one-shot/retry/classifier + `harness import` backfill. **Data path is broken; see §3.** |

The gap is not another report. It is (a) real behavioral data, (b) uncertainty
on rankings, (c) outcome-aware cost, (d) task-cohort fitness, (e) machine export
of the decision layer, (f) regression detection.

## 3. Finding: the behavioral loop is unwired

This is the highest-priority correctness gap found in the review. It gates the
features that make aiand's recommendation different from a cost table.

Evidence:

| Claim | Evidence |
| --- | --- |
| Adapter-side envelope capture was deleted as dead code | `git show --stat ce3bb7d` deletes `src/agents/envelope-capture.ts` (151 lines: `createEnvelopeRecorder`, `envelopeCapture` config, `AIAND_ENVELOPE_CAPTURE`). |
| No production code writes envelopes | `rg insertEnvelope src` returns only `src/store/envelopes.ts` (definition) and tests; no command/adapter calls it. |
| `harness stats` reads envelopes only | `src/commands/harness-stats.ts:70` (`listEnvelopesFromDb`); behavioral walk at `src/obs/harness-stats.ts:284-310`. |
| `harness import` writes a different table | `src/store/artifact-import.ts:480` inserts `imported_artifacts`; migration `0008-imported-artifacts.ts`. |
| Nothing reads imported artifacts | No `SELECT` from `imported_artifacts` outside the migration/insert path. |
| Docs still claim local capture | `docs/observability/adapter-envelope.md:7-8` says "the CLI captures them locally"; that API no longer exists. |

Consequence: on a real install, `harness compare`'s tool-error/one-shot/
missed-catch columns, `efficiency`'s envelope-derived rates, `--cohort`
filtering, and `recommend --sort tool-err|one-shot` are uncovered. Tests seed
envelopes directly, so the suite passes while users see `—`. Imported markers can
fix only the **tool-error rate** and **terminal outcome split/clean rate** at
harness level; they carry no edit targets, so one-shot/retry, missed-catch, and
task classification stay envelope-only.

**Fix (P0).** Prefer the smaller consumer first:

1. Read `imported_artifacts` in `harness stats`/`efficiency`, converting markers
   per harness/session into the existing `EfficiencyTurn` shape in `seq`/`at`
   order. Markers carry harness, session, tool name/outcome, terminal state, and
   compaction kind — enough for harness-level tool-error and clean rate, not for
   cost/model joins or edit-based walks. Label coverage explicitly:
   "imported markers, N sessions, opt-in local files".
2. Only if live capture is required, restore `envelope-capture` and wire it to
   adapters/launchers as an opt-in (`envelopeCapture: true`). That is a larger
   change; do not ship it as part of a reporting feature.

Acceptance: after `aiand harness import`, `harness stats` shows behavioral
coverage and non-null rates for the imported harnesses; without import, columns
stay `—` with a one-line instruction. No prompts, arguments, or file contents
are read.

## 4. LiteLLM product inventory and verdicts

Legend: **ADOPT** = build in aiand in this shape; **ADAPT** = take the idea,
different shape; **DEFER** = valuable but wrong time/dependency; **REJECT** =
proxy/server-only, privacy-conflicting, or out of aim.

### 4.1 Harness, agents, evals, ROI

| Capability | Evidence | Verdict | Why / aiand mapping |
| --- | --- | --- | --- |
| Six agent runtimes (`Harness` enum) | `litellm/harness/types.py` (`Harness`) | ADAPT | Confirms aiand's adapter list; no benchmark to copy. |
| Session lifecycle (`aagent_session`, `arun_agent`, `astream_agent`) | `litellm/harness/runtime.py` | REJECT | `run-agent` already owns launcher lifecycle. |
| State resume (`State`, `STATE_VERSION`) | `litellm/harness/types.py` | DEFER | Useful run-agent feature, not harness choice/observability. |
| Permission modes (`read-only/ask/edit/full`) | `litellm/harness/types.py` | DEFER | Agent control, not metrics. |
| Capability query (`agent_capabilities`) | `litellm/harness/runtime.py:979` | DEFER | Small `doctor` line; no decision value yet. |
| Prompt-cache accounting (`read/creation/outside_input`) | `litellm/harness/endpoint.py:177` | ADAPT | Gateway lacks cache-write split; keep the semantics documented, don't invent. |
| Local model endpoint + SSE usage parser | `litellm/harness/endpoint.py` | REJECT | Violates no-proxy/no-daemon. |
| Sandboxes (`DockerSandbox`, `LocalSandbox`) | `litellm/harness/sandbox/` | REJECT | Out of scope. |
| File-change summary (`FileChange`, snapshots) | `litellm/harness/sandbox/snapshot.py` | DEFER | Nice compare outcome, needs adapter capture; P3. |
| Compaction `tokens_before/after` | `litellm/harness/types.py:94` | ADAPT | Context-pressure metric; only after behavioral loop is real. P3. |
| Stop reasons (`done/max_turns/timeout/cancelled/runtime_error`) | `litellm/harness/types.py:16` | ADAPT | Richer than aiand's `clean/aborted/errored`; map only where session files expose it. |
| CLI option passthrough (reasoning, web search, thinking) | `litellm/harness/options.py` | DEFER | Run control; not aim. |
| A2A agent registry/identity/kill switch | `litellm/proxy/agent_endpoints/a2a_endpoints.py` | REJECT | Server-only. |
| Lens forwarder / decisions / memory | `litellm/proxy/lens/`, `proxy/decisions/`, `proxy/memory/` | REJECT | Server-side telemetry/state. |
| ROI calculator (spend per PR/merge hours) | `litellm/proxy/roi_calculator/README.md` | REJECT | **Retired** in LiteLLM; standalone project only. Concept deferred (P3) because it needs GitHub data. |
| OpenAI-style evals (`create_eval`, graders) | `litellm/evals/main.py` | ADAPT | aiand `compare` task packs already cover the local case. |
| Skills (`SKILL.md` packs) | `litellm/skills/main.py` | REJECT | Not observability. |

### 4.2 Routing, fallbacks, rate limits

| Capability | Evidence | Verdict | Why / aiand mapping |
| --- | --- | --- | --- |
| Lowest latency (p95 TTFT/latency, usable-sample filter) | `litellm/router_strategy/lowest_latency.py:65` | ADOPT | Ranker over `ttft_ms`/`latency_ms`; aiand has both. Add p95 evidence to recommendation. |
| Lowest cost (windowed cost map) | `litellm/router_strategy/lowest_cost.py:40` | ADOPT | Cost/session ranking; gateway cost is authoritative. Add CI. |
| Least busy (in-flight counters) | `litellm/router_strategy/least_busy.py:114` | REJECT | Needs shared proxy state. |
| Lowest TPM/RPM (v1/v2) | `litellm/router_strategy/lowest_tpm_rpm*.py` | REJECT | Live counters unavailable to a client. |
| Weighted shuffle | `litellm/router_strategy/simple_shuffle.py` | REJECT | Proxy load balancing. |
| LAR1 confidence thresholds | `litellm/router_strategy/lar1_routing.py:83` | ADAPT | Confidence gating concept; use CIs, not a runtime bandit. |
| Adaptive router / Thompson sampling | `litellm/router_strategy/adaptive_router/adaptive_router.py:86`; `bandit.py` (`BanditCell`, `thompson_sample`, `pick_best`) | ADAPT | Useful only with a success signal; aiand's clean-terminal rate can supply one. Do not build a bandit before the data is trustworthy. |
| Semantic auto-router | `litellm/router_strategy/auto_router/auto_router.py:57` | REJECT | Needs embeddings/daemon; task classification is cheaper. |
| Complexity router | `litellm/router_strategy/complexity_router/complexity_router.py:1405` | ADAPT | aiand's deterministic 13-category classifier is the client-side equivalent. |
| Quality router (quality tiers, cost tiebreak) | `litellm/router_strategy/quality_router/quality_router.py:40` | ADAPT | Multi-objective profile idea; aiand has no trusted model-quality metadata, so rank observed outcomes instead. |
| Tag-based routing (`&`, `!`, subset) | `litellm/router_strategy/tag_based_routing.py:263` | ADAPT | Cohorts/task tags; gateway tags missing. |
| Router budget limiter | `litellm/router_strategy/budget_limiter.py:117` | REJECT | Enforcement is server-side; CLI is advisory. |
| Fallbacks, retries, cooldowns | `litellm/router_python_core.py`; `litellm/router_utils/cooldown_cache.py` | REJECT (enforcement) / ADAPT (observe) | aiand can report error/retry rates from rows; it cannot fail over. |
| Deployment health cache | `litellm/router_utils/health_state_cache.py` | REJECT | Gateway health checks. |
| Pre-call rate limits (model/io-token) | `litellm/router_utils/pre_call_checks/` | REJECT | Gateway enforcement. |
| Route priority | `litellm/proxy/route_priority.py` | REJECT | Proxy scheduling. |

### 4.3 Caching

| Capability | Evidence | Verdict | Why / aiand mapping |
| --- | --- | --- | --- |
| Cache backends (local/Redis/S3/GCS/Azure/Qdrant) | `litellm/types/caching.py` (`LiteLLMCacheType`) | REJECT | No local completion cache (privacy, architecture). |
| Semantic cache / scopes (`KEY`, `END_USER`) | `litellm/types/caching.py` | REJECT | Stores prompt-derived keys; violates metadata-only. |
| Cache mode on/off | `litellm/caching/caching.py` (`CacheMode`) | REJECT | Proxy setting. |
| Prompt-cache control hook | `litellm/integrations/anthropic_cache_control_hook.py` | REJECT | Request rewriting belongs to the harness/gateway. |
| Cache activity analytics | `litellm/proxy/analytics_endpoints/cache_activity.py` | ADAPT | Hit ratio idea; keep aiand's `cached_tokens / input_tokens` and gateway cost. |
| Prompt cache prediction | `litellm/proxy/management_endpoints/prompt_cache_prediction.py` | REJECT | Requires proxy request inspection. |
| Cache settings endpoints | `litellm/proxy/management_endpoints/cache_settings_endpoints.py` | REJECT | Server config. |

### 4.4 Spend, budgets, keys, teams, audit

| Capability | Evidence | Verdict | Why / aiand mapping |
| --- | --- | --- | --- |
| Per-request spend log (tokens, cost, tags, session, status) | `litellm/proxy/schema.prisma` (`LiteLLM_SpendLogs`) | ADOPT (concept) | `/logs` + local store already do the client-side subset. |
| Daily user/tag aggregates (cache savings, latency) | `schema.prisma` (`LiteLLM_DailyUserSpend`, `LiteLLM_DailyTagSpend`) | REJECT | Gateway aggregate endpoints + users/teams absent; local store covers 30d+ history. |
| Budget table (scopes, windows, temp increase, model caps) | `schema.prisma` (`LiteLLM_BudgetTable`, `BudgetWindowSpend`) | REJECT | Server enforcement; ai& is prepaid monthly, advisory CLI. |
| Soft vs hard budget + alerts | `schema.prisma` (`soft_budget`, `soft_budget_cooldown`); key management endpoints | REJECT | No server cap/alert API; existing `warn-pct` is the client-side surface. |
| Key/team/user/org hierarchy + membership spend | `schema.prisma` (`LiteLLM_VerificationToken`, `TeamTable`, `OrganizationTable`) | REJECT | No user/team dimensions in `/logs`; #80 ask 6. |
| Virtual keys / SSO / SCIM | `management_endpoints/sso/`, `scim/` | REJECT | Gateway/console concern. |
| Audit log (before/after values) | `schema.prisma` (`LiteLLM_AuditLog`), `management_helpers/audit_logs.py` | REJECT | Server mutation audit; CLI has no admin mutations. |
| Spend report endpoints by scope | `spend_management_endpoints.py` (`/global/spend/report`, per-scope key/team/user/organization reports) | REJECT | Gateway data model; local reports already exist. |
| Tag management/spend | `management_endpoints/tag_management_endpoints.py` | ADAPT | Task tags/cohorts; no server tag store. |
| Spend capture rate vs provider bill | `spend_tracking/spend_capture_rate.py` | REJECT | Requires provider billing credentials; aiand already reconciles to gateway. |
| Savings fields (cache/compression/autorouter) | `DailyUserSpend` fields | ADAPT | Cache savings exist; compression/autorouter are proxy features. |
| CloudZero/Vantage exports | `spend_tracking/cloudzero_endpoints.py`, `vantage_endpoints.py` | REJECT | Vendor-specific server exports; OTel/Prometheus is enough. |
| Key budget change / temp budget increase | `management_endpoints/key_budget_change.py` | REJECT | Server mutation. |

### 4.5 Observability, tracing, metrics, logging

| Capability | Evidence | Verdict | Why / aiand mapping |
| --- | --- | --- | --- |
| ~50 Prometheus families (requests, spend, tokens, cache, budgets, deployments, guardrails) | `litellm/integrations/prometheus.py` | ADAPT | Label catalog is useful; aiand emits fewer, honest series. |
| Rich label set (model, provider, team, user, key alias, org, tag, status, stream, service tier) | `litellm/types/integrations/prometheus.py` | ADAPT | aiand keeps `agent.name` + masked key; no PII dimensions. |
| GenAI semconv spellings (`gen_ai.client.token.usage`, `gen_ai.server.time_to_first_token`, `gen_ai.usage.cost`) | `litellm/integrations/otel/model/semconv.py` | ADAPT | aiand uses `gen_ai.client.inference.*`; keep semconv, document mapping. |
| OTel span attributes + content capture modes | `litellm/integrations/opentelemetry.py` | REJECT (content) / ADAPT (attrs) | Metadata-only: no prompt/completion events. |
| Metric attribute include/exclude filter | `litellm/integrations/opentelemetry.py` (`resolve_metric_attribute_filter`) | DEFER | Cardinality control; not needed yet. |
| Lens exporter reliability counters (written/dropped) | `litellm/tracing/exporter.py` (`LensExporter`) | ADOPT | Add local sync/export reliability metrics (§5.5). |
| Spend-log payload fields (session_id, tags, cache_write, completion start) | `litellm/tracing/types.py` (`SpendLogRecord`) | ADAPT | Confirms #80 asks; don't fabricate client-side. |
| OTLP trace/log ingestion + query | `litellm/proxy/tracing_endpoints.py` | REJECT | Gateway owns traces; aiand is short-lived. |
| Large integration tree (247 files: Langfuse, Datadog, Braintrust, S3, …) | `litellm/integrations/` | REJECT | Zero-dep rule; users can point OTLP at a collector. |
| Prometheus metric server / cleanup | `litellm/proxy/prometheus_metrics_server.py` | REJECT | No daemon; push/file export. |
| Guardrail latency/error/request metrics | `litellm/proxy/guardrails/` | REJECT | No guardrail data in `/logs`; server concern. |
| Content capture (NO_CONTENT/SPAN_ONLY/EVENT_ONLY) | `litellm/integrations/opentelemetry.py` | REJECT | Privacy law: metadata only. |
| Prometheus `# HELP` lines | aiand gap (PRD §9.5) | ADOPT | Small export correctness fix (§5.5). |

### 4.6 Governance, security, protocol edges

| Capability | Evidence | Verdict | Why |
| --- | --- | --- | --- |
| Guardrail hooks/pipeline (pre/during/post) | `litellm/proxy/guardrails/`, `hooks/` | REJECT | Server enforcement. |
| Policy engine (inheritance, attachments, allow/block/modify) | `litellm/proxy/policy_engine/` | REJECT | Server config/DB. |
| Compliance checks | `litellm/proxy/compliance_checks.py` | REJECT | Server. |
| Secret managers (AWS/GCP/Azure/Vault/CyberArk) | `litellm/secret_managers/` | REJECT | Server/secret store. |
| MCP gateway/admin tools | `litellm/proxy/admin_mcp.py`, `mcp_server/`, `mcp_tools.py` | REJECT | Different product surface. |

### 4.7 Analytics and insight surfaces

| Capability | Evidence | Verdict | Why |
| --- | --- | --- | --- |
| `/model-insights` daily/top models by metric | `model_insights_endpoints.py` | ADAPT | Per-model rollups exist; task dimension is the value. |
| `/model-insights/tasks` shares + leader | `model_insights_endpoints.py`; `model_insights_tasks.json` | ADOPT (concept) | Harness × task-cohort profile (§5.3). |
| DAU/WAU/MAU by tags | `management_endpoints/user_agent_analytics_endpoints.py` | REJECT | No user dimension in ai& `/logs`. |
| Daily activity routes (global/activity, model, exceptions) | `management_endpoints/daily_activity_routes.py` | REJECT | Local reports already cover; dimensions differ. |
| UI session revocation | `management_endpoints/session_endpoints.py` | REJECT | LiteLLM UI auth. |

**Inventory count:** 76 distinct rows: 6 ADOPT, 18 ADAPT, 6 DEFER, 46 REJECT.
The ratio is the headline: LiteLLM's surface is mostly gateway operations.

## 5. What aiand should build

The shortlist is ordered by "does it change a decision the user makes about
which harness to use?" Features that only add another view are excluded. The
sections are grouped by question, not by phase; each heading carries its phase,
and §9 gives the actual sequence.

### 5.1 P1 — Evidence on the harness scorecard

**Problem.** `aiand harness compare` marks a winner per metric from raw p50/p95
values (`src/obs/harness-stats.ts:397-460`). `recommend` ranks point estimates
after a 5-session floor (`src/obs/pair-stats.ts:79`). Five to twenty sessions
produce wide sampling error; a 10% cost difference is indistinguishable from
noise. The user cannot tell "claude is cheaper for me" from "claude had two
cheap sessions."

**What to build.**

- New shared module `src/obs/evidence.ts` (zero deps):
  - `percentileBootstrap(values, stat, { B: 2000, seed })` — seeded mulberry32
    PRNG, deterministic; returns `{ lo, hi }` at 95%.
  - `wilson95(successes, trials)` — move the existing implementation from
    `src/compare/table.ts:14` into the shared module; keep the exact formula.
  - `bootstrapRatio(numeratorValues, successFlags)` — resample units, recompute
    `sum(cost) / count(success)`, return CI; skip all-zero-success resamples and
    report `null` if fewer than 95% of resamples are defined.
- `src/obs/harness-stats.ts`: add per-harness fields:
  - `costPerSession.ci95` (bootstrap over session costs).
  - `cleanRate` + `ci95` (Wilson over sessions with terminal info; null when no
    terminal info, never 0).
  - `costPerCleanSession` + `ci95` (bootstrap ratio; null when zero clean).
  - `errorRate.ci95` (Wilson), `cacheHitRatio.ci95` (bootstrap).
  - Behavioral rates (`oneShotRate`, `toolErrorRate`, `missedCatchRate`) get
    bootstrap CIs over envelope turns; null when uncovered.

- `compareWinners` becomes `compareVerdicts`: for each metric, the leader is
  marked only when its 95% CI and every rival's 95% CI are disjoint. Otherwise
  emit `tied — not distinguishable yet` and list the overlapping harnesses.
  Use the same `▸` marker only on a decisive winner (color-independent).
- Human output: `$1.20 [0.90–1.55]`, `clean 62% [41–79]`, `n=12`.
- JSON: `{ value, ci95: {lo,hi}, n, coverage }` per metric. Preserve existing
  fields for compatibility; add, don't rename.
- Minimum sample: existing 5 sessions / 5 envelope turns. No winner below it.
- `--no-ci` escape hatch only if the table becomes too wide; default is CI on.

Linkage limit: **imported markers alone cannot produce cost-per-clean-session.**
`imported_artifacts` carries the harness and a harness-local session id, but no
masked key, model, or gateway request link. Use them for harness-level
behavioral rates only. Compute `costPerCleanSession` only from envelopes that
are linked to request rows (live capture or a future gateway echo); when only
imports exist, emit `null` with a one-line coverage note. Never apportion
gateway cost to markers by time proximity — that is guessing.

**Why LiteLLM is the reference.** `LowestLatencyLoggingHandler` ranks on p95
with a usable-sample filter (`litellm/router_strategy/lowest_latency.py`), and
`LowestCostLoggingHandler` ranks on windowed cost
(`lowest_cost.py`). LiteLLM's adaptive router goes further with a Beta posterior
(`adaptive_router/bandit.py`), but a bandit is the wrong tool before the data
path is trustworthy. Percentile intervals are the boring version.

**Acceptance.**

- Two fixtures with overlapping CIs → no `▸`, exact `tied` note.
- Two fixtures with disjoint CIs → one `▸`, correct winner.
- Same store + flags → byte-identical intervals across runs (seed fixed).
- `cleanRate` with zero terminal info → `null`/`—`, not `0%`.
- `costPerCleanSession` with zero clean sessions → `null`, not `$0`.
- Existing tests that assert winner markers are updated only where confidence
  changes the verdict; no snapshot churn elsewhere.
- Effort: M. Files: `src/obs/evidence.ts` (new), `src/obs/harness-stats.ts`,
  `src/commands/harness-stats.ts`, `src/obs/pair-stats.ts`, `src/compare/table.ts`.

### 5.2 P1 — Recommend with a decision threshold

**Problem.** `recommend` prints a winner and an expected delta from point
estimates. The one-line wiring hint looks authoritative even when the top two
pairs overlap.

**What to build.**

- Reuse `evidence.ts` on session cost samples.
- Decision rule:
  - rank eligible pairs (n ≥ 5) by the existing key (cost p50 asc, cache hit
    desc, TTFT p50 asc);
  - compute 95% bootstrap CI for cost/session; if the leader's CI overlaps the
    runner-up's, output `tied — not distinguishable yet` and do not print a
    single "best" wiring line;
  - if the leader is decisive, keep the wiring line.
- Add `requiredSessions`: project the n needed for the observed CI half-width to
  shrink to a target (default 10% of the leader's median):
  `n_needed ≈ n * (halfWidth / targetHalfWidth)^2`, rounded up, capped at a
  sane ceiling (e.g. 5,000). Label `heuristic(session-cost variance)`.
- `--json` gains `verdict: "best"|"tied"|"insufficient"`, `leader`, `tiedWith`,
  `requiredSessions`, and per-pair `ci95`.
- Keep the no-auto-apply rule. `--apply` is deliberately out of scope for this
  round: the printed `aiand <harness> on --model <id>` line is the product
  boundary, and auto-writing agent config is a separate trust decision.
- Extend the same CI/verdict to `harness matrix` rows (JSON + optional column).

**Acceptance.** A fixture where two pairs overlap says `tied` and prints no
wiring line; a decisive fixture keeps today's output. `requiredSessions` is
monotonic as CI width shrinks. Empty window remains honest-empty. Effort: S/M.
Files: `src/commands/recommend.ts`, `src/obs/pair-stats.ts`,
`src/commands/harness-matrix.ts`.

### 5.3 P2 — Harness × task-cohort profile (deferred; not in the local-only ticket batch)

**Problem.** `--cohort <category>` narrows rows before sessionization, so the
user can compare harnesses for one category by running the command repeatedly.
There is no single view of "which harness is best for debugging vs refactoring
vs exploration", and no leader per cohort. `harness matrix` is harness × model,
not harness × task.

**What to build.**

- `aiand harness profile [--last 30d] [--harness <id>] [--cohort <cat>]
  [--min-sessions 5] [--json]`.
- For each harness × classifier category (the existing 13 in
  `src/obs/classifier.ts`), compute from store rows + behavioral data:
  sessions, cost/session p50 (CI), clean rate (CI), one-shot rate, tool-error
  rate, cache hit ratio, TTFT p50/p95. Mark a leader only when CIs are disjoint;
  otherwise `tied`.
- Coverage discipline: categories with no classified sessions are absent and
  counted (`excluded, not folded`); envelope/import coverage is printed once;
  a category with n < 5 is shown in an "insufficient" block, never ranked.
- If no behavioral data at all, exit 30 (`no-data`) with the exact fix:
  `aiand harness import` (or the future live capture). Do not print an empty
  matrix that looks like a result.
- Reuse the existing classifier. Do not import LiteLLM's 20-task taxonomy; the
  13 categories are already tested and map to coding work.
- LiteLLM reference: `/model-insights/tasks` returns per-task `share` and
  `leader` (`model_insights_endpoints.py`, `_summarize_tasks`). The difference:
  aiand's dimension is the harness, not the model group, and the leader is
  evidence-gated.

**Acceptance.** With imported markers for two harnesses, a category with n ≥ 5
prints both rows and a decisive/tied verdict; categories without data are
counted. `--json` shape is stable and provenance-labeled. Effort: M.
Files: `src/commands/harness-stats.ts` (new subcommand), `src/commands/harness.ts`
dispatch, `src/obs/classifier.ts`, `src/obs/harness-stats.ts`.

**Dependency:** §3 (behavioral loop). Without it, every cohort row is
uncovered. Ship §3 first or in the same change. Cohort **cost** columns require
request-linked envelopes (the classifier must know which gateway rows belong to
the session); imported markers can supply behavioral rates per harness but not a
per-cohort cost join. Until live capture or the gateway echo lands, `harness
profile` should show behavioral rates for imported harnesses and `—` for the
cost columns, with the coverage note — never a time-window approximation.

### 5.4 P3 — Compare statistics v2: cost/solve CI, pass@k/pass^k

**Problem.** `compare` has a Wilson solve-rate CI but `costPerSolve` is a point
estimate (`src/compare/table.ts:136`). Trials are treated as independent; when
one task is run three times, the effective n is smaller than `trials`. There is
no pass@k/pass^k distinction for stochastic agents.

**What to build.**

- Task-clustered bootstrap for `compare table` (live rows only):
  resample **tasks** with replacement, recompute pooled solve rate and
  cost/solve, 2,000 iterations, seeded. Report `costPerSolve.ci95` and, when
  `--trials > 1`, use the clustered CI for the solve rate instead of Wilson
  (keep Wilson for the single-trial case; show which method is in use).
- `--k <n>` (default 1):
  - `pass@k` unbiased estimator `1 - C(n-c,k)/C(n,k)`;
  - `pass^k` unbiased estimator `C(c,k)/C(n,k)`;
  - compute per task, then macro-average across tasks with equal task weight;
  - require `n >= k` for a task; tasks below k are excluded and counted;
  - label `pass@k` / `pass^k` explicitly; never quote one as the other.
- Keep infra rows excluded, recorded rows excluded, low-n flags, and the
  existing failure taxonomy.
- Do not add a sample-size planner flag in this round; `low n` plus the CI is
  enough, and a planner is a separate UX decision.

**Why.** Artificial Analysis's coding-agent index averages three attempts per
task, then averages tasks equally; OpenAI's SWE-bench audit shows why
single-run/test-quality claims mislead; pass@k vs pass^k at p=0.75, k=3 is
98% vs 42%, which is the difference between "retries will save it" and
"unattended use will fail." `compare` is aiand's controlled lane; this is where
those distinctions belong.

**Acceptance.** A fixture with three trials on two tasks: clustered CI differs
from the naive Wilson width; `--k 3` returns pass@3 and pass^3; a task with only
two trials is excluded at k=3 and counted; recorded rows never enter. Effort: M.
Files: `src/compare/table.ts`, `src/compare/run-rows.ts`,
`src/commands/compare.ts`.

### 5.5 P1 — Export the decision layer

**Problem.** `aiand export` emits only `gen_ai.*` request counters/histograms
(`src/obs/otel.ts`). A Grafana/Prometheus user cannot see the harness scorecard,
and the exporter still omits Prometheus `# HELP` lines (known PRD gap). There
are no sync/export reliability metrics, so a stale local store is invisible in
dashboards.

**What to build.**

- Add a custom, clearly namespaced gauge family (no GenAI semconv equivalent for
  harness scores; don't squat `gen_ai.*`):
  - `aiand.harness.sessions` (gauge)
  - `aiand.harness.cost_per_session_usd` (gauge, p50)
  - `aiand.harness.cost_per_clean_session_usd` (gauge; emitted only when clean
    sessions exist)
  - `aiand.harness.ttft_p95_ms` (gauge)
  - `aiand.harness.cache_hit_ratio` (gauge, 0–1)
  - `aiand.harness.error_rate` (gauge, 0–1)
  - `aiand.harness.clean_rate` (gauge, 0–1; null → omit)
  - `aiand.harness.one_shot_rate` (gauge, 0–1; omit when uncovered)
  - `aiand.harness.behavioral_coverage_ratio` (gauge, 0–1)
  - `aiand.store.sync_lag_seconds` (gauge)
  - `aiand.store.requests_total` (gauge)
- Attributes: `agent.name` on harness series. Do not add per-key attributes to
  an aggregate harness series (meaningless and high-cardinality). Per-model
  pairs can be a later opt-in.
- Emit only where data exists; never fabricate zeros. Use the same provenance
  labels as the CLI.
- Add `# HELP`/`# TYPE`/`# UNIT` to Prometheus output. Add OTel gauge data
  points to the OTLP/HTTP JSON; keep delta/cumulative semantics for counters and
  absolute values for gauges.
- LiteLLM reference: its Prometheus families + label set
  (`litellm/integrations/prometheus.py`, `litellm/types/integrations/prometheus.py`)
  and Lens exporter reliability counters (`litellm/tracing/exporter.py`). The
  difference: aiand exports decision metrics, not proxy/deployment internals.

**Acceptance.** Prometheus text parses (including `# HELP`); an OTel collector
accepts the payload; every gauge matches the corresponding CLI value; same
store + flags → identical payload modulo timestamps; no content. Effort: S/M.
Files: `src/obs/otel.ts`, `src/commands/export.ts`,
`docs/observability/otel-export.md`.

### 5.6 P2 — Regression watch without a daemon

**Problem.** There is no way to answer "did this harness get worse this week?"
`harness stats` reports one window. The user must eyeball two runs, and small-n
noise invites false alarms.

**What to build.**

- `aiand harness compare --baseline previous` (or `--baseline 7d`):
  - baseline window = the immediately preceding window of the same length;
  - for each (harness, model) with n ≥ 5 in both windows, compute the delta in
    cost/session, TTFT p95, error rate, clean rate, and one-shot rate;
  - bootstrap the **difference** (paired by session is not possible across
    windows; use independent resamples), 95% CI;
  - print `regression` / `improvement` / `no change` only when the CI excludes 0;
  - otherwise `noise — not distinguishable`.
- `--fail-on-regression` exits 1 when any metric regresses; default exit 0.
- Add a one-line summary to `aiand doctor` ("harness regressions: none / N").
- No daemon, no scheduled job, no new state. Cron/CI can run the command.
- Multiple metrics: label the report "screening, not proof"; require n ≥ 5.
- LiteLLM reference: its router uses cooldowns/health state for runtime failover
  (`router_utils/cooldown_cache.py`, `health_state_cache.py`); aiand cannot fail
  over, but it can detect the same drift after the fact.

**Acceptance.** A fixture with a deliberate 2× cost shift and n=10 flags a
regression; a fixture with n=3 or overlapping CIs does not; baseline
window with no data exits 30 with a clear message. Effort: M. Files:
`src/obs/evidence.ts`, `src/obs/harness-stats.ts`,
`src/commands/harness-stats.ts`, `src/commands/doctor.ts`.

### 5.7 P2 — Attribution coverage for the remaining harnesses

**Problem.** Local-usage refinement reads omp/pi session JSONL and opencode.db
only (`src/store/local-usage.ts:88-139`). Claude Code, Codex, Copilot, Copilot
app, and Hermes rely on the weaker masked-key + wire-dialect label. When keys
are shared, those requests stay `shared`, which biases harness comparisons.

**What to build.**

- Reuse the existing parsers in `src/store/artifact-import.ts` to extract
  **usage records** (model, input/output/cached tokens, timestamp) for Claude
  Code JSONL and Codex rollout files; add them to the `local-usage` record set.
- Keep the existing tolerance and uniqueness rules
  (`TIME_TOLERANCE_MS`, `INPUT_TOLERANCE_RATIO`); ambiguous matches stay
  `shared`. Never guess.
- Hermes/Copilot only if their local stores expose usage metadata; otherwise
  document the gap and leave them on the key/dialect label.
- Do not change the attribution precedence rules (specific key/dialect label
  wins; local evidence refines `shared` only).

**Acceptance.** Fixtures for Claude and Codex refine the matching rows; two
agents with equal matches stay `shared`; coverage notes update. Effort: M.
Files: `src/store/local-usage.ts`, `src/store/artifact-import.ts`,
`src/api/agent-keys.ts` (tests only).

## 6. Rejected and deferred

**Rejected by architecture (no proxy/daemon, zero runtime deps):** local
model endpoint/SSE parser, sandbox/Docker, semantic/cross-request cache,
routing enforcement, fallbacks/retries/cooldowns, rate-limit enforcement,
deployment health, Prometheus scrape server, OTLP trace ingestion, 247 logging
integrations, MCP/A2A gateway, virtual keys/SSO/SCIM, guardrails/policy engine,
secret managers, spend/budget/team CRUD, audit log, daily user/tag aggregate
endpoints, spend-capture-vs-provider-bill, CloudZero/Vantage exports.

**Rejected by privacy:** content capture modes, prompt management, semantic
cache keys, full-file paths, prompt/completion bodies in logs or exports.

**Rejected by data model:** recomputing cost from price tables; importing
provider quota windows; per-user/team analytics without a `user_id` dimension;
ROI calculator revival (retired in LiteLLM; needs GitHub identity mapping).

**Deferred (not wrong, just not now):** run-agent state resume, permission
modes, capability query, option passthrough, file-change summaries, compaction
ratio, OTel span/trace export, metric attribute filters, ROI/yield (`cost per
merged PR`), per-model pair gauges.

**Deferred with a trigger:** live envelope capture (only if imported markers are
insufficient); `recommend --apply` (only if users ask; the printed wiring line
is the current trust boundary).

## 7. Gateway asks (out of scope by decision, 2026-11-02)

`#80` is kept for reference only; no item in this batch depends on it and no new
server scope is requested. The list below is not planned work.

| Priority | Ask | Why | Shape |
| --- | --- | --- | --- |
| 1 | Echo the existing `x-aiand-agent` header into `/logs` | Claude Code, Codex, and Hermes already send it; this removes the masked-key/dialect guess for the three most-used harnesses. | nullable `agent` string on each `/logs` row; echo-only, NULL when absent. |
| 2 | `session_id` echo | Exact session boundaries; removes the 10-minute gap heuristic. | `x-aiand-session-id` (regex bounded) → column; never synthesized. |
| 3 | `cache_write_tokens` split | Cache economics; current `input_tokens` includes cached and cache-write is invisible. | Subset of `input_tokens`, same convention as `cached_tokens`; document it. |
| 4 | Project/task tags | Cohort attribution without local envelopes. | `project`/`task` string or `x-aiand-project`/`x-aiand-task` echoed; NULL allowed. |
| 5 | 90-day cost analytics | Local store is the archive, but reconciliation beyond 3 months has no cost. | Add cost to `/analytics/summary` or extend `/logs` retention. |
| 6 | Self-scoped per-key cap | Lets a runaway agent stop server-side; CLI stays advisory. | `GET / PUT / DELETE /keys/self/cap`. |
| 7 | Rate-limit status | Only 429 headers today. | Read-only per-org endpoint. |

Small client-side API fixes, not gateway asks: add `request_at` and
`content_logged` to `LogEntry`/store (both are in the OpenAPI `/logs` row today,
`src/api/logs.ts` omits them); use the existing `/logs` `endpoint` and
`content_logged` query filters instead of client-side filtering. `content_logged`
is metadata, never content; do not auto-enable capture.

## 8. Metric definitions (the part that must not drift)

- **Cost/session p50** — gateway `cost_value` summed per session (time-gap),
  median; bootstrap 95% CI over sessions. Mixed-model sessions are excluded from
  harness aggregates and counted.
- **Clean rate** — sessions with at least one `terminal === "clean"` turn ÷
  sessions with any terminal info. Null when no terminal info. Label
  `heuristic(envelope terminal rule)`. This is the real-workload success proxy;
  it is not a benchmark solve rate.
- **Cost per clean session** — total gateway cost ÷ clean sessions. Null when
  zero clean. Bootstrap ratio CI. **Deferred:** imported markers have no request
  link, so this cannot be computed in the local-only batch; do not approximate it
  by time proximity.
- **One-shot rate** — one-shot edit events ÷ (one-shots + retries), with a retry
  defined as the same file re-edited after a shell command. Existing exact rule,
  `src/model-efficiency.ts`. Envelope-only; imported markers have no edit targets,
  so no CI is available from imports.
- **Tool-error rate** — errored tool calls ÷ tool calls with outcome info; null
  when no outcome info. Existing rule.
- **Error rate** — non-2xx excluding 429 ÷ requests. Wilson 95%.
- **Cache hit ratio** — `cached_tokens / input_tokens` (gateway convention,
  input includes cached). Bootstrap 95%.
- **TTFT p50/p95** — gateway `ttft_ms`, linear interpolation; bootstrap 95% for
  p50/p95.
- **Wilson 95%** — `center = (p + z²/2n)/(1+z²/n)`,
  `half = z/(1+z²/n) * sqrt(p(1-p)/n + z²/4n²)`, `z = 1.96`.
- **Bootstrap** — percentile method, B = 2000, seeded mulberry32; resample
  sessions (or tasks for `compare`), not requests. Deterministic output is a
  requirement.
- **pass@k** — `1 - C(n-c,k)/C(n,k)`; **pass^k** — `C(c,k)/C(n,k)`. Per task,
  then macro-average across tasks; require `n >= k`; cluster, never pool trials
  as independent.
- **Required sessions** — `n_needed ≈ n * (currentHalfWidth/targetHalfWidth)²`,
  target = 10% of the leader's median; cap and label heuristic.
- **Kish n_eff** — `(Σw)² / Σw²`; only if cohort reweighting to the user's task
  mix is added later. Not in the first cut.

Honesty rules stay: nulls never become 0; uncovered cells are `—`; recorded
(simulated) rows never join observed rankings; mixed currencies are never summed;
synthetic sweeps stay display-only.

## 9. Sequencing

| Phase | Work | Why first |
| --- | --- | --- |
| P0 | §3 behavioral loop: consume `imported_artifacts`; document that only tool-error/clean rate are importable | Without it, those behavioral columns stay empty. |
| P1 | §5.1 scorecard evidence + §5.2 recommend verdict | Changes the decision the user makes; no gateway dependency. |
| P1 | §5.5 export decision metrics + `# HELP` | Turns the CLI into an observability source; small. |
| P2 | §5.7 attribution readers | Improves every ranking; data quality. |
| P2 | §5.6 regression watch | Depends on P0/P1 evidence. |
| P3 | §5.4 compare pass@k/cluster bootstrap | High-value controlled eval, larger surface. |
| P3 | Deferred items (profile, trace spans, compaction, ROI) | Only with a concrete user pull. |

Suggested first PR: `evidence.ts` + `harness compare` CIs + `recommend` verdict,
with fixtures for overlapping/disjoint intervals. Second PR: behavioral-loop
consumer + export gauges. Keep each behind existing commands; no new top-level
commands.

## 10. Risks and open questions

1. **Confidence intervals change the product's voice.** "Tied" is less
   satisfying than a winner. It is also the honest answer at n=8. Decide whether
   `harness compare` defaults to CI on or `--confidence` opt-in; the review
   recommends default-on for `compare`/`recommend`, opt-in for the wide matrix.
2. **Multiple comparisons.** Checking eight metrics at 95% invites false
   positives. The first cut should call verdicts "screening" and avoid a single
   composite score. Do not add a p-value theater layer.
3. **Cost/session is a workload mix, not a harness property.** A harness used
   for bigger tasks costs more per session. The cohort profile would be the
   mitigation, but it is deferred in the local-only batch; until it ships, label
   the comparison as workload-conditional.
4. **Behavioral coverage is selection-biased.** Imported markers exist only for
   users who run `harness import`; coverage must be printed next to every rate,
   and uncovered harnesses must not silently lose.
5. **Attribution remains the ceiling.** Even with local readers, keys can be
   shared and sessions ambiguous. `shared` must stay a first-class label, not a
   bucket to guess into.
6. **No quality ground truth.** `compare` task packs give a verifier; real
   workload gives a terminal marker. Do not call the latter "success rate"
   without the heuristic label, and do not mix it with solve rate.
7. **Gateway field semantics.** Out of scope for this batch: no cache-write
   split, session id, or agent echo is assumed. If #80 ever lands, the subset
   convention must be written into the API contract before the client uses it.
8. **Zero-dep rule.** Bootstrap, Wilson, and pass@k are small pure functions;
   no statistics dependency. Keep them in `src/obs/evidence.ts`, not in command
   modules.

Open questions for the product owner:

- Should `harness compare` rank only when CIs are disjoint, or also require a
  minimum effect size (e.g. 10% cheaper) to recommend a switch?
- Should `recommend` ever write agent config, or is the printed wiring line the
  permanent boundary?
- If the deferred cohort profile is ever picked up, which taxonomy matters for
  coding work: the existing 13 categories, or a smaller set (debug / feature /
  refactor / explore / review)?
