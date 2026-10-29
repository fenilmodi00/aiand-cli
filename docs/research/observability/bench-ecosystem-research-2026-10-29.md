# Bench Ecosystem Patterns for aiand `harness compare`

Research date: 2026-10-29. Every claim cites a file path + line (raw.githubusercontent, main branch at time of reading) or a doc URL. `[UNVERIFIED]` marks things I could not open.

---

## 1. terminal-bench (laude-institute/terminal-bench)

### (a) What a run records
- **Task definition**: a directory per task: `task.yaml` (instruction, difficulty, tags, parser name, timeouts), `solution.sh`/`solution.yaml` (oracle), `run-tests.sh`, `tests/`, `docker-compose.yaml`. Documented in the `TaskPaths` docstring: `terminal_bench/handlers/trial_handler.py` ("Folder structure: input_path/ ├── task.yaml ├── solution.sh ├── run-tests.sh ├── docker-compose.yaml └── tests/"). The `Task` model with `instruction`, `parser_name` (default pytest), `max_agent_timeout_sec`, `estimated_duration_sec`, expert/junior time estimates is at the top of that file.
- **Per-trial output tree** (`TrialPaths` docstring, same file): `{output_path}/{task_id}/{trial_name}/` containing `sessions/`, `panes/pre-agent.txt|post-agent.txt|post-test.txt`, `commands.txt` (command history), `results.json` (test results), `agent-logs/`, plus asciinema terminal recording (`recording_path`).
- **Run-level metadata** (`RunMetadata`, `terminal_bench/harness/models.py`): run_id, dataset name/version, agent_name, model_name, n_attempts, n_concurrent_trials, accuracy, pass_at_k, start/end times, commit_hash, username, s3_bucket.
- **Per-trial result** (`TrialResults`, same file): `trial_name`, `task_id`, `instruction`, `is_resolved: bool`, `failure_mode` (enum: agent_timeout, test_timeout, parse_error, context_length_exceeded, agent_installation_failed, … — `terminal_bench/agents/failure_mode.py`), `parser_results` (per-test status), `recording_path`, `total_input_tokens`, `total_output_tokens`, and four timestamps (trial started/ended, agent started/ended, test started/ended).
- The agent under test (e.g. Claude Code) is installed in the container and driven via its own headless JSON stream: `claude --verbose --output-format stream-json -p <instruction>` (`terminal_bench/agents/installed_agents/claude_code/claude_code_agent.py`, `_run_agent_commands`). Token totals are extracted from that stream by the harness wrappers (BaseAgent returns `AgentResult(total_input_tokens=…, total_output_tokens=…, failure_mode=…)` — see `oracle_agent.py` returning zeros).

### (b) Success judging
- Tests run **outside the agent**, in a separate phase, and a per-framework parser converts test output into per-test pass/fail (`ParserFactory`, `terminal_bench/parsers/`: pytest_parser, swebench_parser, mlebench_parser, …). `is_resolved` = all tests pass. No oracle agent judges quality; the oracle (`terminal_bench/agents/oracle_agent.py`) is only a reference *solver* that replays `solution.sh` to prove the task is solvable.
- Failure modes are classified structurally (timeout vs parse error vs context exceeded), which turns "failed" into *why it failed* — a habit aiand should copy for harness behavior.

### (c) Comparison across agents/models
- One run directory per (agent, model, dataset) invocation; results.json at run root aggregates `TrialResults`. CLI prints a tabulated summary: Resolved/Unresolved/Accuracy/Pass@k (`terminal_bench/cli/tb/runs.py`, `_print_rich_results`).
- The public leaderboard (`laude-institute/terminal-bench-leaderboard/README.md`) requires **five full runs** of `tb run -d terminal-bench-core==0.1.1 -a <agent> -m <model>`, PR'd as raw run directories under `results/terminal-bench-core:0.1.1/YYYYMMDD_<agent>_<model>/`.

### (d) Statistical honesty
- pass@k uses the **unbiased HumanEval estimator** `1 − comb(n−c,k)/comb(n,k)` over per-task attempt counts (`BenchmarkResults._pass_at_k_estimator`, `harness/models.py`). k values are only offered when `min_attempts >= k` (powers of 2, plus 5 and 10) — you literally cannot report pass@5 from 3 attempts. This is the "5-run rule" made mechanical.

### (e) Own tasks?
- Yes: `-p/--dataset-path` and `-d terminal-bench-core==X` both exist (`cli/tb/runs.py` create options), plus `task_ids` / `exclude_task_ids` filters. Personal datasets are first-class; the leaderboard just pins the public one.

---

## 2. Harbor (laude-institute/harbor) — terminal-bench's successor framework

### (a) What a run records
- **TrialResult** (`src/harbor/models/trial/result.py`): task_name, trial_name, trial_uri, task_id (+ **task_checksum** for reproducibility), full `TrialConfig`, `agent_info` (AgentInfo{name, version, model_info{name, provider}}), `verifier_result`, `exception_info` (ExceptionInfo with type/message/traceback + `occurred_at`), and **five TimingInfo phases**: environment_setup, agent_setup, agent_execution, verifier, plus started/finished. Multi-step trials add `step_results[]` each with its own agent/verifier result and timings.
- **AgentContext** (`src/harbor/models/agent/context.py`): `n_input_tokens` (including cache), `n_cache_tokens` (tracked separately), `n_output_tokens`, `cost_usd`, and `model_usage: dict[str, ModelUsage]` — **per-model breakdown including subagents** ("as reported by the agent, including subagents. Backfilled from the ATIF trajectory when the agent does not populate it").
- **Trajectories** are a first-class artifact: ATIF (agent trajectory interchange format) models under `src/harbor/models/trajectories/` (trajectory, step, tool_call, observation, observation_result, metrics, final_metrics). Harbor even converts native harness logs to ATIF (`tests/unit/agents/installed/test_claude_code_trajectory.py`, `atif_to_native` tests).
- Claude Code usage mapping is null-tolerant and cache-aware: `prompt_tokens = input + cache_read + cache_creation`, `cached_tokens = cache_read` (`tests/unit/agents/installed/test_claude_code_metrics.py`).

### (b) Success judging
- **Verifier pattern**: the verifier runs in its own phase/environment (`verifier_environment_mode: 'shared' | 'separate'`, `trial/result.py`), producing `VerifierResult.rewards: dict[str, float|int]`. `reward_valid` = rewards exist AND no exception policy invalidates them (`reward_valid` property).
- `harbor analyze` judges **trajectories**, not just outcomes (`src/harbor/analyze/analyzer.py`): it spins up a fresh agent job per trial, hands it the trial dir (`result.json`, `agent/trajectory.json`, `verifier/test-stdout.txt`, `exception.txt`), and asks it to fill a **rubric** (`analyze-rubric.toml`) of criteria with structured PASS/FAIL/NOT_APPLICABLE + explanation. Default rubric criteria: `reward_hacking` (did the agent modify test files / write reward.txt / copy from solution/) and `task_specification` (are the instructions sufficient for the tests?). Output is `analysis.json` + a Rich table of pass/fail/N-A per check with cost (`src/harbor/cli/analyze.py`, `_render_check_summary`). Prompt: `src/harbor/analyze/prompts/analyze.txt`.
- This is exactly the "missed catch / suspicious success" layer aiand wants: an LLM auditor with a fixed rubric over the recorded trajectory.

### (c) Comparison across agents/models
- `JobStats` (`src/harbor/models/job/result.py`) groups everything under `evals_key = "{agent}__{model}__{dataset}"` (`format_agent_evals_key`) — one stats block per harness×model×dataset with n_trials, n_errors, pass_at_k, `reward_stats` (reward value → trial names), `exception_stats` (exception type → trial names), and run-level `n_input_tokens / n_cache_tokens / n_output_tokens / cost_usd`.
- Per-metric aggregation is pluggable: `src/harbor/metrics/` (mean, max, min, sum, uv_script) with a metrics factory.

### (d) Statistical honesty
- Same unbiased pass@k estimator, generalized: `src/harbor/utils/pass_at_k.py` computes per evals_key, requires **single binary reward** (returns {} — refuses to compute — for multi-reward or non-0/1 rewards), and `_eligible_k_values` offers k∈{2,4,8,…} plus {5,10,15,…} only up to min trials per task.
- Error accounting is separate from success: errored trials are counted (`n_errored_trials`, `exception_stats`) and are excluded from pass@k denominators only by the `task_successes[task].append(0)` path — i.e., an exception counts as a failure, not silently dropped.

### (e) Own tasks?
- Fully: `harbor run -d <dataset@version>` for registries, or local task dirs; adapters exist for ~60 external benchmarks (`adapters/` tree). Tasks are just directories with `task.toml`, `instruction.md`, `environment/`, `tests/`, `solution/` (see OpenBench's Harbor-native doc below for the schema).

---

## 3. promptfoo (promptfoo/promptfoo)

### (a) What a run records
- The unit is an **EvaluateResult** (`src/types/index.ts`): `promptIdx`, `testIdx`, `provider`, `prompt`, `vars`, `response`, `success: boolean`, `score`, `latencyMs`, `gradingResult` (with `namedScores`), `cost`, `incurredCost`, `tokenUsage` (NormalizedTokenUsage: prompt/completion/cached/total/numRequests + completionDetails{reasoning, cacheReadInputTokens, cacheCreationInputTokens,…} + `assertions` token sub-accounting), `metadata`, `traceId`, `repeatIndex`/`repeatGroupId`.
- Latency is measured around the provider call (`src/evaluator.ts:952` `const startTime = Date.now()` → `:990` `latencyMs: Date.now() - startTime`); cost/tokens arrive on the `ProviderResponse` and are accumulated per row (evaluator.ts:1203-1222 `accumulateResponseTokenUsage`, `cost = (cost ?? 0) + target.cost`), then per-prompt (`PromptMetrics` schema: score, pass/fail/error/cache counts, totalLatencyMs, tokenUsage, namedScores, cost, incurredCost) and per-eval (`EvaluateStats`: successes/failures/errors + tokenUsage + durationMs + **cacheHits** "so an all-cached re-run is distinguishable from a freshly measured one").
- Dual accounting is explicit: `cost` vs `incurredCost` and `tokenUsage` vs `incurredTokenUsage` — cached replays count toward `cost` but not incurred spend (`src/util/tokenUsageUtils.ts`, `cloneTokenUsageBreakdown`; evaluator.ts:1211 `target.incurredCost ?? (target.cached ? 0 : target.cost)`).

### (b) Success judging — the assertion library
- `src/assertions/` has ~50 handlers: deterministic (equals, contains, regex, json, javascript, python, is-json, similarity, levenshtein, rouge/bleu/ngrams), model-graded (llm-rubric, factuality, answer-relevance, context-faithfulness/recall/relevance, geval, model-graded-closedqa, agent-rubric, search-rubric), and **metric assertions on the run itself**: `cost.ts` (threshold on $ or metric-only reporting), `latency.ts` (threshold on ms; errors helpfully on cached results: "does not support cached results. Rerun the eval with --no-cache"), `finishReason`, `refusal`, `moderation`, `guardrails`, `toolCallF1`, `trajectory`, `traceSpanCount/Duration`.
- Assertion schema (`AssertionSchema`, `src/types/index.ts`): `type`, `value`, `threshold`, `weight`, `metric` (tag result as a named metric), `provider` (override the grading model), `rubricPrompt`, `transform`. `assert-set` groups assertions with a shared threshold.
- Grading is compositional: each assertion returns a `GradingResult{pass, score, reason, tokensUsed}`; component results merge into the row (`namedScores` accumulate per metric tag; `success = pass && …` at evaluator.ts:2326).

### (c) Comparison across providers — the matrix
- The eval loop is **providers × tests**: `for (const provider of testSuite.providers)` (evaluator.ts:2395, 2523) × `for (const testCase of tests)` (:2949); every (provider, test) cell produces one result row.
- The side-by-side table (`src/table.ts` `generateTable`) renders rows = test cases (with vars), columns = `[provider] prompt-label`, cells colored `[PASS]`/`[FAIL]`/`[ERROR]` — the canonical CLI comparison UX. The same table backs the web viewer.

### (d) Statistical honesty
- Repeated-test stability: `repeat` runs a test N times; `RepeatStabilityCalculator` (`src/util/eval/repeatStability.ts`) groups by repeatGroupId and computes a **Wilson 95% interval** per group (`WILSON_Z_95 = 1.959963984540054`), flags `unstable` groups, and excludes cached results from stability judgments.

### (e) Own tasks?
- This is its sweet spot: `promptfooconfig.yaml` with your own providers and test cases (inline vars, external scripts, asserts). It is the direct pattern for "run MY task set across N harnesses."

---

## 4. SWE-bench-style outcome verification (no oracle agent)

- **Verification = apply the model's patch, run the repo's real test suite, parse logs.** `swebench/harness/grading.py`: `get_logs_eval()` slices the log between `START_TEST_OUTPUT`/`END_TEST_OUTPUT` markers, runs a language-specific **log parser** (`swebench/harness/log_parsers/{python,go,java,javascript,ruby,c,rust,php}.py`) to build a per-test status map, then compares against the dataset's precomputed `FAIL_TO_PASS` / `PASS_TO_PASS` sets: resolved = all F2P now pass AND no P2P regressed (`test_passed`/`test_maintained`/`test_failed` helpers).
- **Hardening against lying logs** (this file is a masterclass):
  - `SUITE_RAN` regex (`grading.py` top): evidence the test runner actually executed ("Executed 1 of 5", "5 passing", …) — because "ran with no failures" must be distinguishable from "never ran"; an empty status map under FAIL_ONLY would otherwise score a never-run suite as fully passing.
  - Bad-code sentinels: `APPLY_PATCH_FAIL`, `RESET_FAILED`, `TESTS_ERROR`, `TESTS_TIMEOUT` in the log → graded unresolvable, not crashed.
  - The eval script records the **test command's own exit code** after the output marker (`TEST_EXIT_CODE_RE`) so the parse region can't be spoofed.
  - Truncated parametrized test IDs get prefix-matching only when candidates agree on pass/fail (`_resolve_case`, issue #290).
- **Reporting** (`swebench/harness/reporting.py` `make_run_report`): every instance lands in exactly one of resolved/unresolved/error/incomplete/empty-patch sets, **denominator unchanged**; unresolved ones are additionally classified as infra vs ambiguous failures (`classify_logs`, #586) so a Docker hiccup isn't scored as model failure.
- Personal-task translation: you don't need SWE-bench's scale — you need its *distrust*: marker-delimited output, parser per test framework, "did anything run at all" check, exit code capture, and infra-failure classification.

---

## 5. Harness-behavior benchmarks (the direct precedents)

### 5a. OpenBench (minghinmatthewlam/openbench) — same model, harness varies
The closest existing thing to aiand's harness compare. README (`README.md`):
- "**A benchmark for comparing coding-agent harnesses** — the CLI tools that wrap a model in a run loop, tool set, and permission policy… *given the same underlying model and task, how much does the harness around it matter?*" Track A pins every harness to the same model (`gpt-5.5-medium`) so differences are attributable to the harness.
- **Task format**: `tasks/<name>/{instruction.md, workspace/ (fresh copy per run), checker.sh, solution/}`. "A task is graded by a checker script (exit 0 = solved, optional `SCORE:` for partial credit), **never by the harness's own claim of success**." Checkers get `$TASK_DIR` for private checker data. Instructions never mention the checker/solution.
- **Validation discipline** (`validate_tasks.py`): every checker must FAIL on the untouched workspace and PASS on the golden solution — "catches the two ways a checker can silently lie about difficulty."
- **Negative control**: a built-in `null` adapter does nothing and must score 0%; nonzero null ⇒ broken checker.
- **Result row** (`results/results.jsonl` fields table, README): `run_id` = `harness:task:model:trialN` (resumable identity), `success` (graded), `completed` (CLI exited cleanly — explicitly *not* success), `error`, `wall_time_s`, `tokens` (self-reported fresh tokens; `null` never treated as 0), `turns`, `cmd`, `checker_exit`, `score`, `harness_version`, `timeout_s`, `exec_mode`.
- **Report** (`obench/report.py`): per-harness row with per-task x/n, **overall with Wilson 95% CI** (`wilson_ci` at :58), mean score, mean wall-clock, **tokens-per-solve** = total tokens ÷ number of solves (`tokens_per_solve` :309, None when no solves or no token data), turns-per-solve, and a **token-basis discipline**: self-reported vs proxy-counted tokens are never mixed silently — proxy rows get a `*` and mixed-basis tables print a warning (`token_basis_is_proxy` :327, `table_has_mixed_token_bases` :333).
- **Headline finding** (README): "Correctness saturates for frontier harnesses… **Efficiency separates even when correctness does not.** Wall-clock spread is up to ~4× and token tax up to ~8×." — the exact justification for aiand's cost/behavior-first comparison.
- **Personal/private tasks**: `obench init` scaffolds Harbor-native tasks inside *your repo* (`.openbench/tasks/`, suites, profiles) with local results and trajectories; private-evals are a first-class mode (`docs/private-evals.md`).
- Privacy: full transcripts are local-only, gitignored, and `obench publish` refuses to include them; a scrubber redacts PII before sharing.

### 5b. SanityHarness (lemon07r/SanityHarness) — weighted, integrity-checked agent eval
- 19 built-in agents (Claude, OpenCode, Codex, Gemini, Goose…) × 26 tasks in 6 languages, Docker-isolated, `sanity eval --agent X --model Y`.
- **Integrity verification**: statuses include `integrity_violation` — "Agent modified protected files (tests or support files)" — scored **−0.25 penalty** (docs/SCORING.md), with forensic artifacts per violation (`integrity.json`, `integrity-files/`, `integrity-diff/`).
- **Weighted scoring**: task weights 1.0–1.5 from difficulty factors (language rarity, esoteric features, novel algorithms) — `weight = 1.0 + lang_rarity*0.5 + esoteric*0.8 + …` (docs/SCORING.md).
- Per-attempt records: `result.json` with `attempts`, `all_attempts[{exit_code, duration_ms, output, error_summary}]` — retry visibility built in.
- BLAKE3 attestation hashes for submissions; eval output includes `summary.json` (pass_rate, weighted_pass_rate, by_language/by_tier), `run-config.json` (resume + audit), per-task `agent.log` + `validation.log`.

### 5c. Aider's benchmark harness (Aider-AI/aider/benchmark/) — edit-format correctness
- Task: Exercism-style exercises; end-to-end measure of "translate a request into code that passes unit tests" **plus the model's capacity to format edits so aider can apply them** (`benchmark/README.md`).
- Per-case record (`benchmark/benchmark.py:942-968`): `testcase`, `model`, **`edit_format`**, `tests_outcomes` (list of bools per test run), `cost`, `duration`, `test_timeouts`, `num_error_outputs`, `num_user_asks`, `num_exhausted_context_windows`, **`num_malformed_responses`**, `syntax_errors`, `indentation_errors`, `lazy_comments`, `prompt_tokens`, `completion_tokens`, `thinking_tokens`, chat completion hashes.
- **The harness-behavior metric**: `percent_cases_well_formed = 1 − num_with_malformed_responses / completed_tests` (:587-588) — the % of exercises where the model's edits were parseable in the requested edit format. This is "edit-format correctness" as a first-class number next to pass_rate_1..N. Summary also red-flags any run where `edit_format` or `model` varied across cases (:534-537, :568-575) and prints `costs: $X/test-case, $Y total, $Z projected` (:614-624).
- `pass_rate_i` per try (retry curve): pass rate after 1, 2, … test-fix loops (:557-563).

---

## 6. Cost & token capture across frameworks (the "cheapest pair" machinery)

| Framework | Where tokens come from | Where cost comes from | Cache handling |
|---|---|---|---|
| terminal-bench | Agent's own stream (`--output-format stream-json` for Claude Code) aggregated into `AgentResult.total_input/output_tokens` → `TrialResults` | **No cost field** — tokens only | None visible in TrialResults |
| Harbor | AgentContext totals + `model_usage` per model (subagents included); backfilled from ATIF trajectory if agent doesn't report | `cost_usd` on AgentContext, summed per job (`TrialResult.compute_token_cost_totals`) | `n_cache_tokens` separate; input includes cache, documented |
| promptfoo | Provider response `tokenUsage`, accumulated per row/prompt/eval + separate **assertion-token** sub-accounting | `cost` per response + `incurredCost` (cached excluded) | cached counts in totals; `incurred*` excludes; cacheHits stat |
| OpenBench | Harness self-report (`tokens`) else proxy count; **basis never mixed silently** | No $ — tokens per solve; user's own spend tracked anecdotally ($1.02 for a 72-run matrix) | "fresh tokens (uncached input + output)"; cache-read excluded |
| Aider | `prompt_tokens`/`completion_tokens` from coder | `cost` per case (from litellm-style totals) + $/case and projected cost in summary | context-window exhaustion counted |
| SanityHarness | agent.log (not structured in README examples) | not in summary.json [UNVERIFIED beyond README] | n/a |

Pattern: **the agent harness self-reports usage; the framework cross-checks or proxies it and never lets a missing number pass as zero.** Harbor additionally backfills from a normalized trajectory format when the agent won't say.

---

## Pattern table: mechanism → aiand design option

| Mechanism | terminal-bench / Harbor | promptfoo | SWE-bench | OpenBench / SanityHarness / Aider | aiand design option |
|---|---|---|---|---|---|
| **Task definition** | dir: instruction + tests + oracle solution + timeouts (trial_handler.py TaskPaths) | YAML: providers × tests × assertions (AssertionSchema) | dataset row + test patch + F2P/P2P sets | dir: instruction + workspace + checker.sh + solution/ | Personal task = markdown instruction + a `verify` script (or "watch me do it once" recorded trace). Store `{id, instruction, verify_cmd, timeout, weight, tags}`; aiand's existing scenario fixtures (src/benchmark/scenarios.ts) are this shape already |
| **Run recording** | TrialResults + run_metadata.json + asciinema + agent-logs; Harbor adds checksum, 5 timing phases, ATIF trajectory | EvaluateResult rows: success/score/latencyMs/cost/incurredCost/tokenUsage/metadata | per-instance log + report.json | results.jsonl row keyed `harness:task:model:trialN`; harness_version, exec_mode | One JSONL row per (harness, model, task, trial): `completed` ≠ `success`, `error`, `wall_ms`, tokens (in/cache/out), `cost_usd` from Gateway `X-Cost`, `turns`, gateway request ids for join-back to request logs. Envelope capture optional, never required |
| **Success verification** | Separate test phase + per-framework parser; FailureMode taxonomy for *why* | assertions incl. llm-rubric with provider override | marker-sliced logs, per-language parsers, SUITE_RAN check, exit-code capture, infra-failure classifier | checker.sh exit 0 (+ optional SCORE: partial); validate checker fails-before/passes-after; null control must score 0 | Tiered: (1) verify script exit code (default), (2) optional SCORE: line for partial credit, (3) optional LLM-rubric audit for "suspicious success" (reward-hacking check à la harbor analyze). Never trust harness self-report of success |
| **Cost capture** | tokens per trial; Harbor cost_usd + per-model breakdown | cost + incurredCost + per-assertion tokens | none | tokens-per-solve; aider $/case + projected; OpenBench basis discipline | aiand's unfair advantage: **Gateway is the meter**. Per-run cost = sum of X-Cost over the run's requests (join via request ids), not agent self-report. Track cached vs uncached separately (harness-bench.ts already parses both dialects). Missing usage ⇒ `null`, never 0 |
| **Comparison UX** | tabulate summary + leaderboard dirs; Harbor evals_key per agent×model×dataset | side-by-side table: rows=tests, cols=[provider] (table.ts generateTable) | leaderboard JSON reports | OpenBench per-harness row with Wilson CI + tok/solve + turns; Sanity weighted score | CLI table: rows=harness×model, cols=success (x/n), Wilson 95% CI, mean cost/run, cost-per-solve, mean wall, turns, retries. One "winner" per column, never a single composite score. Show `*` on proxy-derived numbers |
| **n-guards** | pass@k unbiased estimator; k only when min_attempts ≥ k; 5-run leaderboard rule | repeat + Wilson 95% per group; unstable flag; cacheHits disclosed | denominator preserved; infra vs model failure separated | Wilson CI in report.py; "read intervals not point estimates"; devin excluded as flaky | Minimum 3 trials/cell with Wilson CI always shown; overlapping CIs ⇒ "not distinguishable yet" verdict, not a winner. Pin harness version + model string per run (aider red-flags variant drift); classify infra errors out of the success denominator |

---

## Concrete lessons for a personal harness compare (CLI, gateway-billed logs, optional envelope capture)

1. **Separate `completed` from `success`** (OpenBench): the harness exiting cleanly is not the task passing. Record both; success is only ever your verifier's verdict.
2. **Meter at the Gateway, not the agent** (aiand's structural advantage; Harbor self-report + backfill shows the alternative is painful): per-run cost = Σ X-Cost over the run's request ids; tokens = Gateway `usage` blocks parsed per dialect (prompt_tokens-includes-cache for OpenAI, input_tokens-excludes for Anthropic — already encoded in `src/benchmark/harness-bench.ts`). Agent self-reported tokens, when present, become a *cross-check column*, not the source of truth.
3. **Validate the verifier** (OpenBench's discipline): every personal task's check must fail on the untouched workspace and pass on your recorded golden solution. One-time "watch me solve it" recording doubles as the oracle. Add a null harness (no-op) run; it must score 0 on every task.
4. **Adopt the FailureMode taxonomy** (terminal-bench): classify every non-success as agent_timeout / test_timeout / parse_error / context_exceeded / infra / integrity_violation. Never collapse "failed" into one bit — the behavior comparison lives in *why* and *how often*. Denominator rule: infra failures are reported separately, not silently excluded (SWE-bench #586).
5. **Efficiency beats correctness for pair-picking** (OpenBench headline): on easy personal tasks every harness will pass; the decision-relevant numbers are cost-per-solve, wall-clock, turns, and retries. Always show tokens-per-solve with its basis (`null` when no solves — never divide by zero or treat missing as 0; OpenBench report.py:309).
6. **Statistical honesty in 3 moves**: (a) ≥3 trials per (harness, model, task) cell; (b) Wilson 95% CI on every success rate (promptfoo `getWilsonScoreInterval` / OpenBench `wilson_ci` — ~10 lines); (c) overlapping intervals ⇒ display "tied / not distinguishable", not a winner. Aider's guard: if harness or model drifted within a run dir, flag it red.
7. **Pin everything, record versions** (OpenBench `harness_version`, aider `commit_hash`): a comparison row without harness version and exact model string is uninterpretable six months later. Same-model pinning (Track A) is what makes "harness matters" a valid claim; aiand should run each harness at the *same* model by default and offer model sweeps as a second axis.
8. **Cache accounting is where costs lie** (promptfoo incurredCost, OpenBench token-basis): report cost as incurred (fresh) vs billed separately; an all-cached re-run must be visibly different from a fresh measurement (promptfoo's `cacheHits` disclosure). aiand's harness-bench already computes `hitRatio`/`costIfUncached`/`savedUsd` — keep that split in compare.
9. **Transcripts are opt-in and scrubbed** (OpenBench hard rule): envelopes/logs stay local by default; sharing refuses raw transcripts; a redact pass (emails, home paths, keys) runs before anything leaves the machine.
10. **The killer optional layer is a rubric audit of suspicious successes** (harbor analyze): when a task "passes" with anomalously few tokens/turns, offer one `compare audit` command that feeds the trajectory/envelope to a cheap model with a fixed rubric (reward_hacking: did it edit the tests or the verifier? task_specification: was the instruction sufficient?). Structured PASS/FAIL/N-A per criterion, cost displayed next to it — this is the "missed catch" metric no tracker computes today.

### Data shape recommendation (synthesis)
One append-only JSONL (OpenBench pattern) per run directory, joined to Gateway request logs by request-id list:

```
{run_id: "harness:model:task:trialN", ts, harness, harness_version, model, task,
 success: bool|null, score: 0..1|null, error: string|null, failure_mode: enum|null,
 completed: bool, wall_ms, turns, retries,
 tokens_in, tokens_cached, tokens_out, token_basis: "gateway"|"self"|"proxy",
 cost_usd: number|null, cost_basis: "gateway"|"none",
 request_ids: [...], verify_exit: int|null, verify_stderr_excerpt: string|null}
```

Aggregation = group by (harness, model), emit the table with Wilson CIs and per-column winners; nothing else needed for v1.
