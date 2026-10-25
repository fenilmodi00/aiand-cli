# Harness Observability: Demand Research (2026-10-25)

Purpose: before porting the harness-observability features of this repo (CacheLane / Harness-bench) into [fenilmodi00/aiand-cli](https://github.com/fenilmodi00/aiand-cli), establish (1) how developers currently compare coding-agent harnesses, (2) what observability features they demand, (3) what repos/products already exist in this space, and (4) which gaps aiand-cli can credibly own.

Method: orchestrated research on 2026-10-25. Two background agents completed — community sentiment (Reddit / Hacker News / X / blogs) and GitHub issue-mining (claude-code, codex, opencode, gemini-cli, ccusage, aider, litellm, oh-my-pi). The dedicated ecosystem-sweep agent was lost twice to API concurrency limits, so §5's landscape (adoption numbers, feature matrix, standards status) was completed directly via GitHub search + OTel sources by the orchestrator. All claims carry source links.

---

## 1. Executive summary

1. **How users compare harnesses today:** almost entirely through *subscription-limit economics* — "how much real work do I get from $20/$100/$200 per 5-hour window" — argued from anecdote on Reddit (r/ClaudeCode, r/codex, r/opencodeCLI, r/GeminiCLI, r/cursor). Nobody has personal, instrumented numbers; they infer from burn-rate feelings and vendor dashboards they don't trust.
2. **The single most-demanded capability** is accurate, trustworthy, per-session/per-harness cost & usage accounting — and it is *unmet by the vendors themselves*: usage visibility is described as "the #1 most-requested feature category in Claude Code issues" ([claude-code#33978](https://github.com/anthropics/claude-code/issues/33978), consolidating 10+ issues). The largest analytics-adjacent issue in claude-code is users disputing vendor quota math ([claude-code#38335](https://github.com/anthropics/claude-code/issues/38335), 👍475, 879 comments).
3. **The defensible gap is cross-harness comparison + outcome metrics.** Usage *reporting* is commoditized at scale — [ccusage](https://github.com/ccusage/ccusage) at 19.2k★ and [CodeBurn](https://github.com/getagentseal/codeburn) at 11.6k★ (37 tools, per-task attribution) both report *per-tool totals* — but nothing on the market answers "same project, same task: Claude Code vs Codex vs OpenCode — cost, tokens, turns, success rate, side by side." Everyone tracks tokens; almost nobody tracks task success or turns-to-completion per harness.
4. **Benchmark credibility collapsed in 2026**, which *raises* demand for personal/workload-grounded measurement: OpenAI withdrew from SWE-bench Verified as "contaminated" ([openai.com](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified); [HN debate](https://news.ycombinator.com/item?id=47910388)), and community sentiment moved to "do your own benchmarking."
5. **Accuracy is table stakes, not a feature.** The largest reaction clusters on ccusage are "live usage is wrong / double-counted" ([ccusage#288](https://github.com/ccusage/ccusage/issues/288), [#483](https://github.com/ccusage/ccusage/issues/483), [#705](https://github.com/ccusage/ccusage/issues/705)). A comparison tool whose numbers don't reconcile to billing reality will be rejected.
6. **Contrarian signals worth respecting:** budgets/alerts are demanded at the *org/proxy* tier (LiteLLM) but almost absent at local-CLI level — local users want *visibility*, orgs want *enforcement*. And SaaS-only/cloud-upload tracking is explicitly distrusted; local-first is a selling point, not a limitation.

**Implication for aiand-cli:** aiand already sits in the perfect position — every wired agent routes through the ai& gateway, so it sees *normalized, cross-dialect request logs for every harness in one place* (something ccusage approximates by parsing each harness's local files). The research says the winning feature set is: per-session/per-harness cost+token accounting that reconciles exactly, cross-harness comparison on the *user's own workload*, turns/success/outcome metrics, burn-rate/limit forecasting, and export (CSV/JSON/OTel). Details and phasing: see the companion plan, `docs/research/aiand-harness-observability-plan.md`.

---

## 2. How users compare harnesses today (venues & behavior)

- **Reddit is the primary venue.** Recurring archetypes:
  - Budget-tier head-to-heads: ["For $20 which is better, Claude Code or Codex?"](https://www.reddit.com/r/ClaudeCode/comments/1n48ppq/for_20_which_is_better_claude_code_or_codex), ["Claude vs Codex $20 plans"](https://www.reddit.com/r/ClaudeCode/comments/1roeg77/claude_vs_codex_20_plans) ("For $20, codex wins hands down... Claude will run out of its 5-hour quota mid-task").
  - Tool-vs-tool: [OpenCode vs ClaudeCode](https://www.reddit.com/r/opencodeCLI/comments/1s38apa/opencode_vs_claudecode/), [Gemini CLI vs Claude Code](https://www.reddit.com/r/GeminiCLI/comments/1nxd5pu/how_does_gemini_cli_compare_to_claude_code), [Claude Code vs Cursor](https://www.reddit.com/r/cursor/comments/1qhjl3e/claude_code_vs_cursor), [A week running Claude Code, Codex, and Gemini CLI](https://www.reddit.com/r/AI_Agents/comments/1v5i5qb/a_week_running_claude_code_codex_and_gemini_cli).
  - Real-usage cost posts: [Claude Pro/5x Max vs Codex Plus real usage](https://www.reddit.com/r/ClaudeCode/comments/1qj6kvl/claude_code_pro5x_max_vs_codex_plus_real_usage) (~$400/mo API-equivalent to match heavy Codex Plus usage).
- **Hacker News:** Show HNs for usage trackers get real traction (ccusage 75 pts/2025-07; CodeBurn 112 pts/2026-04), plus benchmark-legitimacy debates ([SWE-bench Verified no longer measures frontier coding](https://news.ycombinator.com/item?id=47910388)).
- **Structured comparison sites users cite:** [Artificial Analysis Coding Agent Index](https://artificialanalysis.ai/agents/coding-agents/comparisons/claude-code-vs-opencode) (cost/task, time/task, tokens/task) — third-party, not personal data.
- **Benchmarks-by-blog:** [Composio 100-hour OpenCode vs Claude Code](https://composio.dev/content/claude-code-vs-open-code), [Medium: benchmarked Gemini CLI vs Claude Code vs Codex](https://medium.com/@anupkawarase.akz/gemini-cli-vs-claude-code-vs-codex-i-benchmarked-all-three-heres-the-honest-verdict-a9b830313cc5).

**Metrics people actually use, ranked by observed frequency** (community-sentiment agent):

| Rank | Metric | Evidence signal |
|---|---|---|
| 1 | Subscription-limit consumption / burn rate | [usage-limits megathread](https://www.reddit.com/r/ClaudeAI/comments/1s7fcjf/claude_usage_limits_discussion_megathread_ongoing/); ["limits silently reduced"](https://www.reddit.com/r/ClaudeCode/comments/1s2lye7/claude_code_limits_were_silently_reduced_and_its/) |
| 2 | $ / month & API-equivalent value of a subscription | [r/opencode](https://www.reddit.com/r/opencode/comments/1wzb4oy/is_opencode_still_worth_it_against_20_claude/); [Pro 5x vs Codex Plus](https://www.reddit.com/r/ClaudeCode/comments/1qj6kvl/claude_code_pro5x_max_vs_codex_plus_real_usage) |
| 3 | Tokens per task/session | [DataCamp Codex vs Claude](https://www.datacamp.com/blog/codex-vs-claude-code); [AA "tokens/task"](https://artificialanalysis.ai/agents/coding-agents/comparisons/claude-code-vs-opencode) |
| 4 | Cost per task | AA publishes $14.19 vs $4.37 directly |
| 5 | Context-window capacity / efficiency | ["Gemini won on raw context size"](https://www.reddit.com/r/AI_Agents/comments/1v5i5qb/a_week_running_claude_code_codex_and_gemini_cli) |
| 6 | Wall-clock time per task | AA "time/task"; blog benchmarks |
| 7 | Task success / quality on real work | [Duet](https://duet.so/blog/codex-vs-claude-code), [Composio](https://composio.dev/content/claude-code-vs-open-code) |
| 8 | Cache hit rate | [CodeBurn HN thread](https://news.ycombinator.com/item?id=47759035) ("98.2% cache hit rate on Opus") |
| 9 | Spend attribution by activity/task type | [CodeBurn HN](https://news.ycombinator.com/item?id=47759035): "Most token trackers just tell you total spend. This tells you what kind of work the spend went to" |

---

## 3. Pain points (each with evidence)

1. **Opaque, silently-shifting limits.** "Since March–April 2026, Claude usage limits got brutal across all plans. Single prompts eating 50%+ of sessions" ([megathread](https://www.reddit.com/r/ClaudeAI/comments/1s7fcjf/claude_usage_limits_discussion_megathread_ongoing/)); ["It costs you around 2% session usage to say hello"](https://www.reddit.com/r/ClaudeCode/comments/1s54q0d/it_costs_you_around_2_session_usage_to_say_hello/).
2. **Unpredictable burn, no forecasting.** Pro users hitting 5h limits in <20 min ([r/ClaudeAI](https://www.reddit.com/r/ClaudeAI/comments/1satb89/claude_usage_gets_burned_absurdly_fast_for/)); spawned dedicated forecasters ([claumon](https://github.com/fabioconcina/claumon)).
3. **Benchmark scores don't match real-world performance.** OpenAI dropped SWE-bench Verified as "contaminated and mismeasuring frontier coding" ([OpenAI](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified)); sentiment moved to "do your own benchmarking."
4. **No cross-tool aggregate view.** The tool wave exists because each harness shows only its own numbers: ccusage expanded Claude-only → "Claude Code, Codex, OpenCode, Amp, Droid, Codebuff" ([ccusage.com](https://ccusage.com)); [coding_agent_usage_tracker](https://github.com/Dicklesworthstone/coding_agent_usage_tracker) exists to "monitor usage across Codex, Claude, Gemini, and Cursor."
5. **Dashboards show totals, not causes.** "Most token trackers just tell you total spend" ([CodeBurn HN](https://news.ycombinator.com/item?id=47759035)).
6. **In-tool stats disagree with reality / hide cache tokens.** ccusage numbers "often much higher than Claude Code's built-in /stats" because they count cache reads ([ccusage guide](https://ccusage.com/guide)).
7. **Parallel sessions & multi-agent runs unaccounted.** Per-session breakdown "when running parallel sessions" requested in [CodeBurn thread](https://news.ycombinator.com/item?id=47759035); vendor OTel cost counters collide across parallel processes, inflating `increase()` 100× ([claude-code#56317](https://github.com/anthropics/claude-code/issues/56317)).
8. **Silent billing distortions.** API-key fallbacks billed silently ([Composio](https://composio.dev/content/claude-code-vs-open-code)); Cursor extras ballooning to "$6k–8k with the $200 plan" ([r/cursor](https://www.reddit.com/r/cursor/comments/1qhjl3e/claude_code_vs_cursor)).

---

## 4. Feature demands (merged: community + GitHub issues, ranked by evidence volume)

| # | Demand | Evidence (selection) | Frequency |
|---|---|---|---|
| 1 | **Accurate cost/usage accounting per session/day/week** — programmatic access, not just vendor UI | [claude-code#33978](https://github.com/anthropics/claude-code/issues/33978) (👍11, "consolidates 10+ issues"); [#11008](https://github.com/anthropics/claude-code/issues/11008) (usage in hook inputs, 👍34); [codex#117](https://github.com/openai/codex/issues/117) (/cost, 👍32); [opencode#5374](https://github.com/sst/opencode/issues/5374) (tokens/s, 👍112); [#6152](https://github.com/sst/opencode/issues/6152) (session context usage, 👍142) | **High** |
| 2 | **Limit/quota visibility & trust** — verify vendor quota math, see 5h/weekly windows | [claude-code#38335](https://github.com/anthropics/claude-code/issues/38335) (👍475); [#13585](https://github.com/anthropics/claude-code/issues/13585) (quota access, 👍129); [codex#15281](https://github.com/openai/codex/issues/15281) (full limits in CLI, 👍28); [codex#9508](https://github.com/openai/codex/issues/9508) (deterministic weekly reset, 👍36) | **High** |
| 3 | **Cross-harness unified view** — one report across Claude/Codex/OpenCode/Gemini/Cursor | [ccusage#845](https://github.com/ccusage/ccusage/issues/845) (👍33), [#757](https://github.com/ccusage/ccusage/issues/757), [#222](https://github.com/ccusage/ccusage/issues/222) (multi-device); [gemini-cli#16607](https://github.com/google-gemini/gemini-cli/issues/16607) | **High** |
| 4 | **Per-task / per-project cost attribution** — "what kind of work did the spend go to" | [CodeBurn HN](https://news.ycombinator.com/item?id=47759035); [claude-code#1549](https://github.com/anthropics/claude-code/issues/1549) (JSON/CSV export per model/session/subagent) | **High** |
| 5 | **Burn-rate forecasting / limit depletion prediction** | [claumon](https://github.com/fabioconcina/claumon) (Gamma-process forecasting); burn-rate megathreads | **Medium-high** |
| 6 | **Personal benchmarking on real workloads** ("what am I actually getting for my subscription") | [OpenAI SWE-bench withdrawal](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified) + [HN](https://news.ycombinator.com/item?id=47910388); [SemiAnalysis sub-vs-API benchmark](https://x.com/SemiAnalysis_/status/2064815044085318040) | **Medium-high** |
| 7 | **Export & integrations: CSV/JSON, OTel, Grafana** | [claude-code#1549](https://github.com/anthropics/claude-code/issues/1549); [#32364](https://github.com/anthropics/claude-code/issues/32364) (OTel config, 👍36); [#56317](https://github.com/anthropics/claude-code/issues/56317) (OTel counter correctness) | **Medium** |
| 8 | **Parallel-session / subagent breakdowns** | [CodeBurn HN](https://news.ycombinator.com/item?id=47759035); [claude-code#22625](https://github.com/anthropics/claude-code/issues/22625) (per-subagent usage); [#24537](https://github.com/anthropics/claude-code/issues/24537) (agent hierarchy dashboard, 👍19) | **Medium** |
| 9 | **Cache-hit-rate visibility as a cost lever** | [CodeBurn HN](https://news.ycombinator.com/item?id=47759035); ccusage cache-counting debates | **Medium** |
| 10 | **Statusline / live surfaces** | [codex#17827](https://github.com/openai/codex/issues/17827) (customizable statusline, 👍206); [claude-code#8861](https://github.com/anthropics/claude-code/issues/8861) (statusline usage) | **Medium** |
| 11 | **Anomaly explanations / recommendations** ("why did this session cost 3×") | [CodeBurn HN](https://news.ycombinator.com/item?id=47759035) (recommendations on request); ["Mystery solved: why you're burning tokens"](https://www.reddit.com/r/ClaudeCode/comments/1wg9w9t/mystery_solved_why_youre_burning_through_claude) | **Medium** |
| 12 | Budgets/alerts | Present at org/proxy tier ([litellm#44358](https://github.com/BerriAI/litellm/issues/44358) etc.), **essentially absent at local-CLI tier** | Low (local) |
| 13 | Wrapped/year-in-review analytics | [Claude Wrapped](https://spader.zone/wrapped/), [yearincode.xyz](https://yearincode.xyz) | Low-medium |

**Surprising / contrarian signals:**
- **Budgets are an org-tier concern, not a CLI-tier one** — don't lead with them.
- **Accuracy complaints outnumber feature requests** on ccusage (#288, #483, #487, #705 are all "numbers are wrong"). Correctness of accounting is the moat's foundation.
- **Vendors are shipping the basics** (opencode /cost + /usage, Claude /status, ccusage multi-harness). Per-harness *reporting* is commoditizing; per-harness *comparison + outcomes* is not.
- **Subscription-vs-API blended cost** is unmodeled anywhere: users can't split subscription usage from pay-per-token in mixed sessions ([oh-my-pi#8247](https://github.com/can1357/oh-my-pi/issues/8247)).

---

## 5. Competitive landscape

Stars/activity checked 2026-10-25 via GitHub search. The headline: **this space already has large winners in per-harness usage reporting** — ccusage at **19.2k★** (rewritten in Rust) and CodeBurn at **11.6k★** claiming **37 tools/agents** with breakdowns "by model, project, and task." Per-tool reporting is deeply commoditized; the remaining gaps are comparison, outcomes, accuracy, and programmatic access (below).

### Usage/cost trackers (local CLI, parse each harness's own files)

- [ccusage](https://github.com/ccusage/ccusage) — **19,170★**, Rust, updated today; covers Claude Code, Codex, OpenCode, Amp, Droid, Codebuff (+more via [better-ccusage](https://github.com/cobra91/better-ccusage), 92★: Droid/Zcode/pi/omp); daily/weekly/session reports; Raycast extension; [site](https://ccusage.com). Gaps: per-tool reporting, not normalized comparison; recurring accuracy complaints (#288/#483/#705).
- [CodeBurn](https://github.com/getagentseal/codeburn) — **11,575★**, 892 forks, updated today; 37 tools/agents; TUI + menubar + web dashboard; turn classification into 13 activity categories; breakdowns by model/project/task. The fastest riser (Show HN Apr 2026 → 11.6k★ in ~6 months) — proves task-level attribution demand at scale.
- [coding_agent_usage_tracker](https://github.com/Dicklesworthstone/coding_agent_usage_tracker) — 90★, Rust; quota/rate-limits/cost across Codex, Claude, Gemini, Cursor, Copilot.
- [Claude-Code-Usage-Monitor](https://github.com/Maciek-roboblog/Claude-Code-Usage-Monitor) — **8,764★**; real-time monitor with **predictions and warnings** (burn forecasting demand, validated hard).
- Menu-bar/tray ecosystem: [ClaudeBar](https://github.com/tddworks/ClaudeBar) (1,556★, Claude/Codex/Gemini/Copilot quotas), [CodeZeno monitor](https://github.com/CodeZeno/Claude-Code-Usage-Monitor) (647★, Windows taskbar), [Usage4Claude](https://github.com/f-is-h/Usage4Claude) (411★), [cc-usage-bar](https://github.com/lionhylra/cc-usage-bar), [cctray](https://github.com/goniszewski/cctray), [claumon](https://github.com/fabioconcina/claumon) (forecasting), [claude-analyst](https://github.com/onmyway133/claude-analyst).
- [agentgraphed](https://github.com/sudomichael/agentgraphed) — local-first history/analytics (Claude Code + Codex). [summer](https://github.com/useautumn/summer) — multiplayer tracking. [Spenda](https://github.com/sshnaidm/spenda) — privacy-first local tracker (Claude Code/Codex/Cursor/OpenCode). [SessionWatcher](https://sessionwatcher.com/facts) (20 tools, SaaS).

### Feature matrix (✓ / partial / ✗)

| Tool | Multi-harness | Per-session cost | Per-harness *compare* | Task/project attribution | Forecast | Export (CSV/JSON/OTel) | Dashboard | Local-first |
|---|---|---|---|---|---|---|---|---|
| ccusage | ✓ (per-tool reports) | ✓ | ✗ (per-conversation only, [#1817](https://github.com/ccusage/ccusage/issues/1817)) | partial (session/project) | ✗ | JSON | ✗ (3rd-party Raycast) | ✓ |
| CodeBurn | ✓ (37 tools) | ✓ | ✗ | ✓ (13 task types) | partial | ✗ | ✓ TUI+menubar+web | ✓ |
| coding_agent_usage_tracker | ✓ (5 tools) | ✓ | ✗ | partial | ✗ | ✗ | ✗ | ✓ |
| CC-Usage-Monitor / ClaudeBar / tray apps | partial | ✗ (limits focus) | ✗ | ✗ | ✓ (predictions) | ✗ | ✓ (bar/tray) | ✓ |
| Artificial Analysis Index | ✓ (SaaS) | n/a | ✓ (their tasks, not yours) | n/a | ✗ | ✗ | site | ✗ |
| **aiand-cli (target)** | ✓ **gateway-normalized** | ✓ planned | ✓ planned (**your workload**) | ✓ planned | P2 planned | P3 planned (OTel-clean) | P2 planned (offline HTML) | ✓ (local cache; data org-side) |

### Benchmarks & telemetry standards

- **Benchmark harnesses:** SWE-bench (+Verified, credibility contested — see §3), [terminal-bench → now the Harbor framework](https://github.com/harbor-framework/terminal-bench) ("measuring and evolving with the frontier of agent work", 970★ + [2.6k★ predecessor](https://github.com/harbor-framework/terminal-bench-1) + [760★ science variant](https://github.com/harbor-framework/terminal-bench-science)), Aider leaderboards (model-level, [reproducibility contested](https://github.com/Aider-AI/aider/issues/4323)), [Artificial Analysis Coding Agent Index](https://artificialanalysis.ai/agents/coding-agents/comparisons/claude-code-vs-opencode).
- **OTel GenAI semantic conventions** moved into a dedicated repo, [open-telemetry/semantic-conventions-genai](https://github.com/open-telemetry/semantic-conventions-genai) (481★, created 2026-05); still **Development status** as of mid-2026 ([Greptime](https://greptime.com/blogs/2026-05-09-opentelemetry-genai-semantic-conventions), [OTel blog](https://opentelemetry.io/blog/2026/genai-observability)). Claude Code **exports OTel metrics + log events (stable), traces in beta** ([OTel blog](https://opentelemetry.io/blog/2026/genai-observability); Honeycomb remaps them for its Agent Timeline). Implication: emit `gen_ai.*`-compatible series in P3 export, don't invent a schema.
- **LLM-generic observability platforms** (Langfuse, Helicone, AgentOps, LangSmith, W&B Weave, Arize Phoenix, Braintrust): agent-trace generic, SaaS-leaning, none focused on coding-harness comparison.

**Direct harness-comparison tools: effectively none.** The closest are per-tool aggregators above. No product compares harnesses on cost/speed/success *on the user's own workload* — and only a gateway-side tool (aiand) can do it with billing-grade accuracy across dialects.

---

## 6. Gaps nobody covers (synthesis)

1. **Cross-harness comparison itself** — "same project, same task, Claude Code vs Codex vs Aider: cost/tokens/success side by side" does not exist as a product. Even ccusage's comparison requests are per-conversation, not per-harness ([ccusage#1817](https://github.com/ccusage/ccusage/issues/1817)).
2. **Outcome metrics** — turns-to-completion and task success per harness; everyone tracks tokens, nobody tracks outcomes (aider leaderboard is model-level and not reproducible locally, [aider#4323](https://github.com/Aider-AI/aider/issues/4323)).
3. **Programmatic/MCP access to usage data** — [claude-code#11008](https://github.com/anthropics/claude-code/issues/11008) (👍34) still open; an MCP server exposing per-session usage to the agent itself is unbuilt.
4. **Subscription-vs-API blended accounting** across harnesses.
5. **OTel-correct multi-process cost counters** — vendor counters break under parallel sessions ([claude-code#56317](https://github.com/anthropics/claude-code/issues/56317)); a local aggregator producing clean series is open.

---

## 7. Repo inventory (porting context)

**Source — this repo (cachelane 1.2.1, D:\Harness-bench):** local proxy + SQLite observability stack: per-turn records keyed workspace/session/turn with model, provider, **harness** (UA detection, migration 012), token counts, billing-tier reconciliation (`region_cost_json`); CLI `stats --scope`, `sessions`, `report` (self-contained HTML dashboard), `explain --turn --top-blocks` (per-block cost attribution by region/tier), `harness/stats --by-harness`, `benchmark harness-compare` (health verdicts: cache_hit_ratio < 0.2 / fallback_rate > 0.1 → bad), TUI `benchmark dashboard`, `benchmark latency` (TTFT A/B), `benchmark duel` (ON/OFF), deterministic recorded replay (`BENCHMARK.md`), MCP tools `cachelane_stats/_explain/_harness_stats/_expand/_health`.

**Target — aiand-cli (@aiand/cli):** gateway client CLI (Node ≥22, Biome, Commander-style). Already has: agent wiring for OpenCode, Claude Code, Codex, Pi, Oh My Pi, Copilot CLI/app, Hermes; `aiand usage` (requests/tokens vs previous period, org-wide); `aiand cache` (hit rate + savings per agent/model, key-based attribution); `aiand logs` (normalized cross-dialect request logs, `--follow`); `aiand harness` (synthetic request-*shape* benchmark: claude-code/omp/reordered-stable/rebuilt-system/compacting/reordered; `--scenario`, `--sweep-models`); `src/benchmark/` module exists. Key structural difference: aiand-cli's data lives **gateway-side (org-wide, normalized)**; CacheLane's lives **local-SQLite (per-turn deep)**. The port is gateway-first with local caching, not a proxy port.

---

## 8. Source index

Community: r/ClaudeCode [1n48ppq](https://www.reddit.com/r/ClaudeCode/comments/1n48ppq/for_20_which_is_better_claude_code_or_codex) · [1roeg77](https://www.reddit.com/r/ClaudeCode/comments/1roeg77/claude_vs_codex_20_plans) · [1qj6kvl](https://www.reddit.com/r/ClaudeCode/comments/1qj6kvl/claude_code_pro5x_max_vs_codex_plus_real_usage) · [1s2lye7](https://www.reddit.com/r/ClaudeCode/comments/1s2lye7/claude_code_limits_were_silently_reduced_and_its/) · [1s54q0d](https://www.reddit.com/r/ClaudeCode/comments/1s54q0d/it_costs_you_around_2_session_usage_to_say_hello/) · [1wg9w9t](https://www.reddit.com/r/ClaudeCode/comments/1wg9w9t/mystery_solved_why_youre_burning_through_claude) · r/ClaudeAI [1s7fcjf](https://www.reddit.com/r/ClaudeAI/comments/1s7fcjf/claude_usage_limits_discussion_megathread_ongoing/) · [1satb89](https://www.reddit.com/r/ClaudeAI/comments/1satb89/claude_usage_gets_burned_absurdly_fast_for/) · [1t6asgc](https://www.reddit.com/r/ClaudeAI/comments/1t6asgc/things_i_wish_i_knew_earlier_about_claude_token) · r/opencodeCLI [1s38apa](https://www.reddit.com/r/opencodeCLI/comments/1s38apa/opencode_vs_claudecode/) · r/opencode [1wzb4oy](https://www.reddit.com/r/opencode/comments/1wzb4oy/is_opencode_still_worth_it_against_20_claude/) · r/GeminiCLI [1nxd5pu](https://www.reddit.com/r/GeminiCLI/comments/1nxd5pu/how_does_gemini_cli_compare_to_claude_code) · r/cursor [1qhjl3e](https://www.reddit.com/r/cursor/comments/1qhjl3e/claude_code_vs_cursor) · r/AI_Agents [1v5i5qb](https://www.reddit.com/r/AI_Agents/comments/1v5i5qb/a_week_running_claude_code_codex_and_gemini_cli) · HN [ccusage Show HN](https://news.ycombinator.com/item?id=44426666) · [CodeBurn](https://news.ycombinator.com/item?id=47759035) · [SWE-bench debate](https://news.ycombinator.com/item?id=47910388) · Articles [Artificial Analysis](https://artificialanalysis.ai/agents/coding-agents/comparisons/claude-code-vs-opencode) · [Composio](https://composio.dev/content/claude-code-vs-open-code) · [DataCamp](https://www.datacamp.com/blog/codex-vs-claude-code) · [Duet](https://duet.so/blog/codex-vs-claude-code) · [SemiAnalysis](https://x.com/SemiAnalysis_/status/2064815044085318040) · [OpenAI SWE-bench withdrawal](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified)

GitHub issues: anthropics/claude-code [#33978](https://github.com/anthropics/claude-code/issues/33978) · [#38335](https://github.com/anthropics/claude-code/issues/38335) · [#13585](https://github.com/anthropics/claude-code/issues/13585) · [#11008](https://github.com/anthropics/claude-code/issues/11008) · [#32364](https://github.com/anthropics/claude-code/issues/32364) · [#56317](https://github.com/anthropics/claude-code/issues/56317) · [#24537](https://github.com/anthropics/claude-code/issues/24537) · [#22625](https://github.com/anthropics/claude-code/issues/22625) · [#1549](https://github.com/anthropics/claude-code/issues/1549) · openai/codex [#17827](https://github.com/openai/codex/issues/17827) · [#15281](https://github.com/openai/codex/issues/15281) · [#117](https://github.com/openai/codex/issues/117) · [#9508](https://github.com/openai/codex/issues/9508) · sst/opencode [#5374](https://github.com/sst/opencode/issues/5374) · [#6152](https://github.com/sst/opencode/issues/6152) · ccusage [#845](https://github.com/ccusage/ccusage/issues/845) · [#288](https://github.com/ccusage/ccusage/issues/288) · [#483](https://github.com/ccusage/ccusage/issues/483) · [#705](https://github.com/ccusage/ccusage/issues/705) · [#222](https://github.com/ccusage/ccusage/issues/222) · [#757](https://github.com/ccusage/ccusage/issues/757) · [#1817](https://github.com/ccusage/ccusage/issues/1817) · google-gemini/gemini-cli [#16607](https://github.com/google-gemini/gemini-cli/issues/16607) · Aider-AI/aider [#4323](https://github.com/Aider-AI/aider/issues/4323) · BerriAI/litellm [#44358](https://github.com/BerriAI/litellm/issues/44358) · can1357/oh-my-pi [#8247](https://github.com/can1357/oh-my-pi/issues/8247)

Repos: [ccusage](https://github.com/ccusage/ccusage) · [coding_agent_usage_tracker](https://github.com/Dicklesworthstone/coding_agent_usage_tracker) · [codeburn](https://github.com/AgentSeal/codeburn) · [claumon](https://github.com/fabioconcina/claumon) · [agentgraphed](https://github.com/sudomichael/agentgraphed) · [cc-usage-bar](https://github.com/lionhylra/cc-usage-bar) · [cctray](https://github.com/goniszewski/cctray) · [claude-analyst](https://github.com/onmyway133/claude-analyst) · [summer](https://github.com/useautumn/summer) · [SessionWatcher](https://sessionwatcher.com/facts) · [ccusage.com](https://ccusage.com)
