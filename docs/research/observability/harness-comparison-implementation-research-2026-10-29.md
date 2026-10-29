# Personal Harness Comparison: Implementation Research (2026-10-29)

Purpose: `aiand harness compare` (ticket #64) today aggregates per-harness cost/session, TTFT, cache-hit, and error rate from gateway-verbatim rows and marks per-metric winners (`compareWinners`, `src/obs/harness-stats.ts:275`). It feels impersonal — it compares *harness averages*, not *how the user works in each harness*: no tool failures, no retries, no missed catches, no task outcomes. This research asks, against primary sources: (1) how the inspiration repos (ccusage, CodeBurn, and siblings) implement personal usage analytics and any comparison, (2) how comparison-style repos (promptfoo, Terminal-Bench/Harbor, aider, Artificial Analysis, arenas) design comparisons, and (3) what signals exist — in our own telemetry and in each harness's local artifacts — to make a comparison personal. It is the implementation-side companion to `harness-observability-research-2026-10-25.md` (demand evidence) and the feature catalog (`aiand-observability-feature-catalog.md`, C1–C7).

Method: orchestrated research on 2026-10-29. Four background agents (relaunched once mid-run onto a faster task model with their gathered evidence preserved): a ccusage code-level deep-dive, a sibling-tracker survey (CodeBurn, caut, CC-Usage-Monitor, claumon, ccstatusline, agentgraphed, spenda), a comparison-patterns survey (10 projects), and a signal-inventory pass (our repo + Claude Code / Codex / OpenCode artifact schemas). Sources: source files read via GitHub (ccusage verified against a clone of `main` @ `757b457`), official docs, and issue threads. Four working artifacts with full per-claim citations live at `local://research-ccusage.md`, `local://research-siblings.md`, `local://research-compare-patterns.md`, `local://research-signals.md` (session store; key findings inlined below).

---

## 1. Executive summary

1. **Nobody computes the metrics the user is asking for.** Across ccusage (~19.2k★), CodeBurn (~11.6k★), and every other surveyed tracker: zero compute tool-error rate, missed-catch rate, turns-to-success, compaction frequency, or session outcome. ccusage reads `isApiErrorMessage` *only* to scrape the usage-limit reset timestamp and still counts error lines in totals (`rust/adapters/claude/src/lib.rs:915-931`); ccstatusline has no error/retry widget at all. The personal-outcome space is empty.
2. **CodeBurn is the closest inspiration and already does "personal A/B"** — but models, not harnesses: `codeburn compare` puts two models side by side *on your own history* with one-shot rate, retry rate, self-correction, cost/edit, cache hit, and a per-metric winner ([README L331](https://github.com/getagentseal/codeburn/blob/main/README.md); `src/compare-stats.ts`). Its retry/one-shot rule (same file re-edited after a shell command ran in between) is already ported into our `src/model-efficiency.ts`.
3. **Comparison-style repos all compare on their own task sets, not the user's history** — except promptfoo (your own prompts × providers in a matrix) and the worktree-arena tools (bon-arena, agent-arena: same task, two agents, human picks). **No surveyed tool replays a captured session on another model**, and none does cohort-matched comparison on personal history. aiand's `MIN_SAMPLE_SESSIONS=5` gate in `pair-stats.ts` is ahead of every surveyed external repo.
4. **All the missing personal metrics are computable from data every harness already writes locally.** Claude Code JSONL has `tool_result.is_error` + `toolUseResult` shapes; Codex rollouts have `TurnComplete.error`/`TurnAborted` + `Compaction*` items; OpenCode has `ToolStateError{error}` parts + compaction parts. The gateway /logs feed never carries tool outcomes — the enrichment must come from adapters/envelope (forward capture) and/or artifact import (retroactive), the pattern our `src/store/local-usage.ts` already uses.
5. **Accuracy machinery is the table stakes every mature repo converges on**: structural dedup keys (ccusage `usage_dedupe_hash(message_id, request_id, session_id, timestamp)`; CodeBurn content-derived `deduplicationKey` → deterministic OTLP trace ids), stored-cost-over-recomputation fallbacks (Grok `costUsdTicks`, Codex service tiers), explicit unpriced-model warnings, and excluded-but-counted cohorts (CodeBurn's multi-model-turn discipline — which our `harness-stats.ts` already mirrors for mixed-model sessions).

**Implication:** the personal `harness compare` is not a new aggregation over /logs — it needs (a) envelope enrichment with per-tool outcome + turn terminal markers, (b) optional artifact import per harness, (c) a compare surface built on CodeBurn's personal-A/B pattern (rates + winner per metric + cohort exclusions + n labels) rather than bare totals.

---

## 2. ccusage: the reference usage-analytics implementation

Repo: [ccusage/ccusage](https://github.com/ccusage/ccusage) (~19.2k★, Rust rewrite under `rust/`). Verified against a clone of `main` @ `757b457`.

**Architecture — normalize early.** ~20 adapters under `rust/adapters/<agent>/src/{paths,parser,loader}.rs`, each producing the shared core `UsageEntry` (`session_id, timestamp, version, message{id,model,usage}, costUSD, request_id, isApiErrorMessage, isSidechain` — `rust/crates/ccusage-core/src/types.rs:9-26`), so daily/monthly/session/pricing logic is written once. The unified layer (`rust/crates/ccusage-adapter-all/src/loader.rs`) folds each into `AllRow {period, agent, models_used, tokens…, total_cost, model_breakdowns}`.

**Inputs per harness** (fields table in the full artifact): Claude `~/.claude/projects/*/*.jsonl`; Codex `$CODEX_HOME/sessions` rollouts incl. `.jsonl.zst`; OpenCode SQLite `message` table (+JSONL fallback); Amp thread JSON; Droid/Codebuff/Gemini JSON; Grok session JSONL (`costUsdTicks` fixed-point 1e-10 USD); Copilot OTel JSONL.

**Cost math.** Embedded LiteLLM + models.dev snapshots; cache rates derived when absent (`cache_read = input × 0.1`, `cache_create = input × 1.25`, 1h = 2×; `pricing.rs:1151-1152`, `cost.rs:7`); Display/Auto/Calculate modes — stored `costUSD` wins when the vendor's math can't be reproduced (Grok, Codex tiers); unpriced models cost 0 **and are reported** via `missing_pricing_model_*` warnings (`cost.rs:52-95`).

**Grouping.** Session ids are harness-native (Claude filename, Codex rollout path, OpenCode DB column) — no time-gap heuristics for session reports; 5-hour billing blocks via `identify_session_blocks` (`rust/crates/ccusage/src/blocks.rs:53-113`).

**Errors: the blind spot.** Only the Claude adapter parses `isApiErrorMessage`, solely to extract `usage_limit_reset_time` from "Claude AI usage limit reached" lines (`lib.rs:915-931`) — not counted, not excluded. No adapter reads tool results, retries, or failures. Dedup: `usage_dedupe_hash(message_id, request_id, session_id, timestamp)` + sidechain-replay hashes, higher-token duplicate wins (`lib.rs:214-386`); #288/#483/#705 were aggregation-accuracy bugs (live blocks, water-mark heuristics), fixed in main.

**Comparison: deliberately absent.** No compare command. Unified tables add an "Agent" column — "so you can compare sources in one view" ([all-reports.md L47](https://github.com/ccusage/ccusage/blob/main/docs/guide/all-reports.md)) — plus per-session drill-down. Issue [#1817](https://github.com/ccusage/ccusage/issues/1817) (per-conversation Codex/Claude compare incl. subagents) was closed unmerged as "new report surface… no maintainer endorsement"; [#222](https://github.com/ccusage/ccusage/issues/222) (multi-device) is delegated to file sync. Stated limits: "local, read-only analyzer… does not scrape private cloud services" and never estimates tokens from transcript text ([source-support-qa.md](https://github.com/ccusage/ccusage/blob/main/docs/guide/source-support-qa.md)).

**Lessons:** normalize to one event record early; prefer native session ids over time-gap; trust stored costs where vendor math is non-reproducible; dedup structurally; refuse fake precision. The error/retry silence is our opening.

---

## 3. CodeBurn and the siblings: what personal analytics already exists

**CodeBurn** ([getagentseal/codeburn](https://github.com/getagentseal/codeburn), ~11.6k★) — the deepest implementation:

- **Personal model A/B** (`src/compare-stats.ts`): per-model `ModelStats` over your own history — one-shot rate, retry rate, self-correction (assistant-apology regexes), cost/call, cost/edit, cache hit (`cacheRead/(input+cacheRead)`), working style (delegation rate, planning rate, tools/turn) — with per-metric winners (`higherIsBetter` flags). Turn ownership = first behavioral call's model. README: "two models side by side **on your own history**" (L331).
- **Retry/one-shot semantics** (README L412): "A retry is counted when the same file is edited again after a shell command ran in between… A turn with `hasEdits && retries===0` is a oneShotTurn." File-level for Claude/Codex/Goose; tool-name fallback elsewhere.
- **13-category rule-based classifier** (`src/classifier.ts`): regex/tool-shape per turn (TEST/GIT/BUILD/INSTALL patterns; read-shaped bash ⇒ exploration). No LLM. (agentgraphed is the inverse — LLM classification, 11 labels, per session, editable — costs money, non-deterministic.)
- **Cohort discipline** (`src/compare-cohorts.ts`): an observation = one edit turn with exactly one model; multi-model turns excluded *and counted*; `$0` on a paid model = UNKNOWN cost, not zero; context size labeled a proxy; median + P90 with inspectable sample list. (Our mixed-model exclusion in `harness-stats.ts` follows this discipline already.)
- **Accuracy**: content-derived `deduplicationKey` → deterministic OTLP trace/span ids (`src/sync/otlp.ts`); per-span `ai.cost_estimated` flag; Copilot credit reconciliation with twin-row folding and `creditsIncomplete`; 10-year daily cache that *names* unexplained days instead of folding them into totals (README L442).
- **Attribution**: spend cut by project, git branch, model, and task category; `categoryBreakdown` per session = `{turns, costUSD, savingsUSD, retries, editTurns, oneShotTurns}` per category (`src/types.ts:355`). Branch is recorded per turn by Claude Code "and by almost nothing else" — coverage split three ways honestly (README L88).
- **Forecasting**: trailing-7-day-median daily cost extrapolated to period end — a pace line, not a model.

**The rest** (full sections in the artifact): **caut** (`Dicklesworthstone/coding_agent_usage_tracker`) — quota prediction from server-reported percent-used snapshots: reset-stripped regression velocity + CodexBar pace classification; prediction works on *snapshots*, not token logs. **Claude-Code-Usage-Monitor** (~8.7k★) — linear burn-rate extrapolation + the p90-of-historical-blocks trick to infer plan limits empirically. **claumon** — the forecasting ceiling: published, versioned empirical-Bayes Gamma-process model (MODEL.tex v2.2) with Monte Carlo CIs, calibrated on your own history; "measured, not estimated" gauges from the OAuth usage API. **ccstatusline** (~13.4k★) — live Status-hook fields only (cost, context, rate limits, compaction counter widget); no behavioral analytics by design. **spenda** — the most rigorous accounting doc: every dollar reproducible from normalized usage rows; atomic records with stable `response_id`, monotonic-delta fallback with `counter_reset` warnings. **agentgraphed** — LLM session classification (11 labels, editable, costs money).

**Cross-repo matrix** (✓ full / ⚠️ partial / ❌ none):

| Capability | ccusage | CodeBurn | caut | CC-Usage-Monitor | claumon | ccstatusline |
|---|---|---|---|---|---|---|
| Per-tool totals | ✓ (~20 adapters) | ✓ (46 parsers + 14 quota readers) | ✓ (16 providers) | ⚠️ Claude only | ⚠️ Claude only | ⚠️ live only |
| Task classification | ❌ | ✓ rules, 13 cat | ❌ | ❌ | ❌ | ❌ |
| Error/self-correction | ❌ | ⚠️ self-correction regex only | ❌ | ❌ | ❌ | ❌ |
| Retry / one-shot | ❌ | ✓ file-level turn semantics | ❌ | ❌ | ❌ | ❌ |
| Forecasting | ❌ | ⚠️ 7d-median pace | ✓ velocity+pace | ✓ linear + p90 | ✓✅ Gamma-process MC | ❌ |
| Cross-tool compare | ⚠️ Agent column | ✓✅ model A/B + cohorts | ⚠️ quota cards | ❌ | ❌ | ❌ |

---

## 4. How comparison-style repos compare

Ten projects surveyed (full sections + pattern table in the artifact):

- **promptfoo** ([promptfoo/promptfoo](https://github.com/promptfoo/promptfoo)) — the closest "replay your own tasks" mechanism: your prompts become test-case `vars` run against every configured provider; `promptfoo view` renders a rows=tests × columns=providers matrix with pass/fail, cost, latency, tokens per cell (`src/util/eval/evalTableUtils.ts`). No winner marking, no n-guards.
- **Terminal-Bench / Harbor** ([laude-institute/terminal-bench](https://github.com/laude-institute/terminal-bench), [harbor](https://github.com/laude-institute/harbor)) — agents × models on a fixed public suite; leaderboard **submissions require 5 runs per agent+model**; verifiers are deterministic test scripts.
- **aider leaderboards** — models on fixed suites; the exemplary honesty writeup: 10× reruns of one model to measure API nondeterminism with **error bars**, SHA hashes of every request/reply to detect nondeterminism ([benchmarks.md §Randomness](https://github.com/Aider-AI/aider/blob/main/aider/website/docs/benchmarks.md)).
- **Artificial Analysis Coding Agent Index v2.0** ([methodology](https://artificialanalysis.ai/methodology/coding-agents-benchmarking)) — harness+model variants on fixed suites, 3 attempts/task task-weighted; cache-aware cost; blocked attempts score zero → "a blocked rate of 2% means **at most 2 points** lost" (explicit upper-bound framing); provider-error retries re-run up to 10× and superseded runs excluded from rates; reward-hacking reported only once every passing attempt has an integrity review.
- **Arenas** — Harness Arena (blind Elo for harnesses), bon-arena / agent-arena (same task in parallel git worktrees, two agents, human picks the diff — n=1 by design, on personal subscriptions). **Verdict for us: don't build an arena**; blind voting suits public judging, not personal history.
- **spendwatch** — personal cost leaderboards across your own agents' local transcripts; the closest spiritual match on the cost axis.

**Key negative findings** (searches logged in the artifact): no tool replays a captured agent session on another model (all "replay" tools re-execute from the task prompt); no cohort-matched comparison over personal history exists outside aiand; no "compare harnesses on MY usage" product exists.

**Statistical honesty techniques worth adopting:** n-labels beside every median; error bars / min-max ranges; mandatory multiple runs (TB); retry-supersession so flaky infra doesn't contaminate outcome rates (AA); penalty metrics with "at most X points" interpretation; excluded-not-folded data (CodeBurn, ccusage, AA).

---

## 5. What aiand has today vs what's missing (signal feasibility)

| Metric | aiand today | Needed input | External repo computing it |
|---|---|---|---|
| Cost/session, cache hit, TTFT, API error rate | ✓ (`harness-stats.ts`, gateway-billed) | — | ccusage, ccstatusline (partial) |
| One-shot / retry rate | ✓ but envelope-gated, default OFF (`src/model-efficiency.ts`, CodeBurn rule) | envelope capture on | CodeBurn (source of the rule) |
| Task mix (13 categories) | ✓ envelope-gated (`src/obs/classifier.ts`) | envelope capture on | CodeBurn (rules), agentgraphed (LLM) |
| **Tool-error rate** | ✗ | per-tool outcome (envelope: names only today, `envelope-capture.ts:65-66`) | — none |
| **Missed-catch rate** | ✗ | tool outcome + edit sequencing | — none |
| **Compaction frequency** | ✗ | harness artifacts (envelope has no signal) | — none (ccusage *parses* Codex `compacted` but reports nothing) |
| **Turns-to-success** | ✗ | turn terminal markers | — none |
| **Session outcome** | ✗ | terminal state (sessionization is time-gap only, `sessions.ts:54`) | — none |

**Every harness records the missing signals locally** (field tables with citations in the artifact):

- **Claude Code** `~/.claude/projects/*.jsonl`: `message.content[].type:"tool_result"` with `is_error: true`; structured `toolUseResult` (Bash `{stdout, stderr, interrupted}`, Edit `{filePath, structuredPatch}`, string form = error); `message.stop_reason` (`tool_use|end_turn`); `isApiErrorMessage`; `isSidechain`; compaction = JSONL rewrite with changed `first_message_uuid` (community-documented schema, cross-checked against ccusage's parser; no official Anthropic schema doc exists — [UNVERIFIED] against first-party docs).
- **Codex** `$CODEX_HOME/sessions/**/rollout-*.jsonl`: `response_item` payload kinds incl. `Compaction`, `CompactionTrigger`, `FunctionCall(Output)`; `event_msg` types `TurnComplete{error: Option}`, `TurnAborted`, `TokenCount`, `ExecCommandBegin/End`, `McpToolCallBegin/End`; explicit `type:"compacted"` records (verified in openai/codex source at HEAD 2026-10-29).
- **OpenCode** SQLite (`session_part` table, migration 2026-10-29): `ToolState` union `Streaming|Running|Completed|Error{error}`; per-message `tokens.cache{read,write}` + `cost`; compaction parts with running/completed status (verified in sst/opencode `packages/schema/src/session-message.ts`).

**Architectural conclusion:** all six missing metrics need tool-outcome + turn-terminal data that (a) exists in all three harnesses' local artifacts, (b) is *not* in the gateway /logs feed, and (c) is only partially reachable through aiand envelopes today. Two capture paths, both precedented in-repo: enrich the envelope (`src/agents/envelope-capture.ts`) with a per-tool outcome flag + turn terminal marker for forward capture; extend the artifact-import pattern (`src/store/local-usage.ts` already reads pi JSONL + opencode SQLite) for retroactive coverage.

---

## 6. Design recommendations for a personal `aiand harness compare`

1. **Keep gateway-billed aggregates as the base layer** (cost/session, TTFT, cache hit, error rate — unchanged provenance) and add a *behavioral layer* on top: one-shot rate, retry rate, task-mix-matched cohorts, tool-error rate, missed-catch rate, turns-to-success, session outcome. Label every metric with its provenance as today (`src/obs/provenance.ts`).
2. **Follow CodeBurn's compare shape, extended to harnesses**: rows = harnesses, columns = metric families (performance: one-shot/retry/self-correction; efficiency: cost/session, cost per successful outcome, cache hit; friction: tool-error rate, missed-catch, compaction frequency), deterministic winner marker per metric (existing `WINNER_MARKER`), and per-category comparisons where envelopes allow.
3. **Cohort discipline first**: same-task-category sessions only (the `cohort` seam already reserved in `HarnessStatsOptions`, `harness-stats.ts:96-101`); mixed-model sessions stay excluded-and-counted; n-labels beside every median; `MIN_SAMPLE_SESSIONS` gates rankings; a CodeBurn-style inspectable sample list per cell (our `--samples` today).
4. **Capture path**: envelope enrichment (per-tool outcome, terminal marker, compaction event) + artifact import per harness. ccstatusline's field list proves Claude Code exposes live session-level cost/context/rate-limit state via hooks if a live surface is ever wanted.
5. **Accuracy rules to copy**: structural dedup keys for any imported records; stored-cost fallback where vendor math is non-reproducible; `$0` on a paid model = UNKNOWN cost, not zero; excluded rows reported, never folded.
6. **Don't**: build an arena (n=1 voting), replay trajectories across models (no precedent, dubious validity), or estimate tokens from transcripts (ccusage's refusal is the right call).

---

## 7. Source index

**Working artifacts (full per-claim citations):** `local://research-ccusage.md` · `local://research-siblings.md` · `local://research-compare-patterns.md` · `local://research-signals.md`

**Repos:** [ccusage/ccusage](https://github.com/ccusage/ccusage) (clone of main @ 757b457) · [getagentseal/codeburn](https://github.com/getagentseal/codeburn) · [Dicklesworthstone/coding_agent_usage_tracker](https://github.com/Dicklesworthstone/coding_agent_usage_tracker) · [Maciek-roboblog/Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor) · [fabioconcina/claumon](https://github.com/fabioconcina/claumon) · [sirmalloc/ccstatusline](https://github.com/sirmalloc/ccstatusline) · [sudomichael/agentgraphed](https://github.com/sudomichael/agentgraphed) · [sshnaidm/spenda](https://github.com/sshnaidm/spenda) · [promptfoo/promptfoo](https://github.com/promptfoo/promptfoo) · [laude-institute/terminal-bench](https://github.com/laude-institute/terminal-bench) + [leaderboard](https://github.com/laude-institute/terminal-bench-leaderboard) · [laude-institute/harbor](https://github.com/laude-institute/harbor) · [Aider-AI/aider](https://github.com/Aider-AI/aider) · [Ondemand-OSS/harness-arena](https://github.com/Ondemand-OSS/harness-arena) · [jacksuzuki/bon-arena](https://github.com/jacksuzuki/bon-arena) · [orangejustin/agent-arena](https://github.com/orangejustin/agent-arena) · [edihasaj/spendwatch](https://github.com/edihasaj/spendwatch) · [openai/codex](https://github.com/openai/codex) · [sst/opencode](https://github.com/sst/opencode) · [quickcall-dev/quickcall-supertrace](https://github.com/quickcall-dev/quickcall-supertrace) (community Claude JSONL schema doc)

**Issues:** ccusage [#1817](https://github.com/ccusage/ccusage/issues/1817) (per-conversation compare, closed unmerged) · [#222](https://github.com/ccusage/ccusage/issues/222) (multi-device) · [#288](https://github.com/ccusage/ccusage/issues/288) / [#483](https://github.com/ccusage/ccusage/issues/483) / [#705](https://github.com/ccusage/ccusage/issues/705) (live-accuracy family) · [#1987](https://github.com/ccusage/ccusage/issues/1987) (unpriced tier gap)

**Docs:** ccusage [all-reports](https://github.com/ccusage/ccusage/blob/main/docs/guide/all-reports.md) · [session-reports](https://github.com/ccusage/ccusage/blob/main/docs/guide/session-reports.md) · [source-support-qa](https://github.com/ccusage/ccusage/blob/main/docs/guide/source-support-qa.md) · CodeBurn README (L231, L331, L412, L442) · aider [benchmarks §Randomness](https://github.com/Aider-AI/aider/blob/main/aider/website/docs/benchmarks.md) · AA [methodology](https://artificialanalysis.ai/methodology/coding-agents-benchmarking) · promptfoo [intro](https://www.promptfoo.dev/docs/intro/)

**aiand-cli files cited:** `src/obs/harness-stats.ts` · `src/obs/pair-stats.ts` · `src/obs/classifier.ts` · `src/model-efficiency.ts` · `src/agents/envelope-capture.ts` · `src/agents/envelope.ts` · `src/store/{sessions,local-usage,envelopes,index}.ts` · `src/store/migrations/0001–0006` · `src/api/{logs,cache-report}.ts` · `src/commands/{harness-stats,efficiency,recommend}.ts`
