# Plan: Personal Harness Compare — helping the user pick the right harness and model for THEIR workload

Companion to `harness-comparison-implementation-research-2026-10-29.md` (implementation research: ccusage/CodeBurn/siblings, comparison repos, signal feasibility) and its two bench-research addenda: `local://research-harnessbench.md` (how CacheLane's and our own synthetic benchmark work, seam-by-seam; also mirrored at `bench-ecosystem-research-2026-10-29.md` §A) and `bench-ecosystem-research-2026-10-29.md` (terminal-bench/Harbor/promptfoo/SWE-bench/OpenBench/SanityHarness/aider mechanisms — moved from the research session's `local://research-bench-ecosystem.md`). Demand evidence: `harness-observability-research-2026-10-25.md`. Feature-catalog rows referenced below use C1–C7 IDs from `aiand-observability-feature-catalog.md`.

Date: 2026-10-29 · Status: proposal for review, not yet approved for implementation.

---

## 0. Problem and shape of the solution

**Problem.** `aiand harness compare` (C1, shipped) compares *harness averages*: cost/session p50, TTFT p50, cache-hit ratio, error rate, with a `▸` per-metric winner. It cannot answer "which harness + model should *I* use?" because the deciding signals are behavioral — how often the harness's tool calls fail, whether edits stick on the first try, how often the agent misses an obvious catch (a failing test it then re-trips), how many turns a successful task takes, whether sessions end well — and none of those live in gateway `/logs` rows. Research confirms **no tracker or benchmark in the ecosystem computes these** (ccusage reads `isApiErrorMessage` only to scrape a reset timestamp; CodeBurn's closest is a self-correction regex; OpenBench/SanityHarness measure correctness on *their* tasks, not yours).

**Two-lane answer (the core design decision).** The only honest way to compare *behavior* is to measure it on data that actually exists:

| Lane | Data | What it proves | Precedent |
|---|---|---|---|
| **A. Observed (personal history)** | Local store request rows + envelope captures + harness artifact import, over the user's real sessions | How each (harness, model) actually behaved *for you* | CodeBurn `compare` (models A/B on own history), our existing `harness compare` |
| **B. Replay (personal tasks)** | The user's own task definitions re-run across harnesses/models through the gateway, metered by request ids | Controlled apples-to-apples: same task, same model, harness varies; or same harness, model varies | OpenBench Track A (same model, harness varies), promptfoo (own tests × providers), our existing synthetic bench |

Both lanes already have half-built machinery in this repo: lane A is `harness-stats.ts` + `model-efficiency.ts` + envelopes; lane B is `src/benchmark/` (scenarios/layouts/dialects/recorded transport) minus behavioral measurement. **The plan is to finish both lanes and join them at the compare surface.** OpenBench's headline justifies the focus: with frontier harnesses, correctness saturates — *efficiency and friction* (cost spread 4–8×, wall-clock 4×) are what separate them; those are exactly our gateway-metered numbers.

---

## 1. The metric set (what compare shows)

All metrics below are per **(harness, model)** cell — the pair the user actually chooses. Provenance labels are mandatory (`gateway-billed` / `estimated` / `heuristic` / `simulated`), following `src/obs/provenance.ts`.

### Lane A — observed, from your history

| Column | Source today | New capture needed | Provenance |
|---|---|---|---|
| cost/session p50, p90 | ✓ store rows | — | gateway-billed |
| TTFT p50/p95, cache-hit, API error rate, requests, sessions | ✓ | — | gateway-billed / estimated |
| one-shot rate, retry rate | ✓ but envelope-gated (`src/model-efficiency.ts`) | envelopes ON | heuristic |
| task mix (13 categories) | ✓ envelope-gated (`src/obs/classifier.ts`) | envelopes ON | heuristic |
| **tool-error rate** (tool calls that failed / tool calls) | ✗ | envelope per-tool outcome | heuristic |
| **missed-catch rate** (a failing signal — e.g. test/shell error — appears, the agent proceeds without addressing it, and must return to the same file: shell-error → edit-same-file-without-fix-attempt chains; concrete rule below) | ✗ | envelope tool outcome + existing retry walk | heuristic |
| **turns-to-success / session outcome** (ended-clean vs aborted vs errored) | ✗ | envelope turn terminal marker; Codex `TurnComplete.error`/`TurnAborted` via artifact import | heuristic |
| compaction frequency | ✗ | artifact import only (Claude rewrite boundaries, Codex `compacted`, OpenCode compaction parts) | heuristic |

**Missed-catch v1 rule (deterministic, no LLM, extends `oneShotRetry`'s walk):** walking envelope turns in order, a **catch miss** = a shell tool ran and *errored*, the next edit turn re-edits a file it already edited before that shell run, and a subsequent shell run *errors again on the same file's test/check* — i.e. the agent returned to the file without a between-turn signal that the failure was addressed. One rule, fixtures-pinned like `model-efficiency.ts`'s CodeBurn rule; refine later. [definition draft — needs fixtures before ship]

### Lane B — replayed, on your tasks

Per (harness, model, task, trial) run row (OpenBench's JSONL shape, adapted):

```
{run_id: "harness:model:task:trialN", ts, harness, harness_version, model,
 success: bool|null,          // verify script exit 0 (never the harness's own claim)
 score: number|null,          // optional "SCORE: 0.x" partial credit from the verify script
 failure_mode: enum|null,     // agent_timeout | verify_timeout | parse_error | context_exceeded | infra | integrity_violation
 completed: bool,             // harness exited cleanly — recorded separately, never = success
 wall_ms, turns, retries,     // turns/retries from envelope walk of the run itself
 tokens_in, tokens_cached, tokens_out, cost_usd,   // gateway-metered via request-id join
 token_basis: "gateway", cost_basis: "gateway",
 request_ids: [...], verify_exit: int|null}
```

Aggregated per (harness, model): **solve rate with Wilson 95% CI** (≥3 trials/cell; overlapping CIs ⇒ "tied — not distinguishable yet", never a forced winner), **cost per solve** (total cost ÷ solves, `null` when 0 solves — never 0), mean wall-clock, turns per solve, retry rate per solve, failure-mode histogram.

### Why no composite score

Every surveyed framework refuses one composite number; we keep per-column winners (`WINNER_MARKER`) plus AA's upper-bound phrasing for penalties ("a 4% tool-error rate cost at most 4% of solves").

---

## 2. Data capture — the three enablers

### 2.1 Envelope enrichment (unlocks lane A's behavioral columns; ticket #78 follow-up)

Extend `EnvelopeV1` and `EnvelopeRecorder` (`src/agents/envelope-capture.ts`), keeping every existing privacy rule (names only, hashed paths, opt-in default OFF):

- `tool(name, outcome?: "ok" | "error")` — one boolean per tool call; error text NEVER captured.
- `turnEnd(terminal: "clean" | "aborted" | "errored")` — flushes with the terminal marker.
- Compaction is *not* capturable adapter-side for all harnesses — comes from artifact import (2.3).

New fields on `EnvelopeV1`: `tool_outcomes: Array<{name, ok}>` (or a parallel array), `terminal: string|null`. Store migration 0007. The efficiency/classifier modules stay pure functions over the enriched turn shape — `EfficiencyTurn` gains `toolOutcomes` and the missed-catch walk layers onto the existing `oneShotRetry` pass (one walk, two verdicts — not a second parser).

### 2.2 Task packs for lane B (`aiand compare task` — new, small)

Personal task = directory (OpenBench shape, simplified to zero-config):

```
.openbench-style: tasks/<id>/{instruction.md, workspace/ (copied fresh per run), verify.sh}
```

`aiand compare task add <id> --verify "npm test"` scaffolds it. **Verifier discipline (OpenBench):** `aiand compare validate` runs every task's verify on the untouched workspace (must FAIL) and after `--golden` replay of a recorded solution (must PASS); a built-in null harness (no-op adapter) must score 0. Checkers can emit `SCORE: 0.6` for partial credit. Instructions never reference the verify script.

**Drivers:** reuse the adapter registry (`src/agents/registry.ts`) — each wired harness already knows how to run headless with a baked key; the bench already encodes both dialects (`harness-bench.ts:103-201`). The run is *not* the synthetic bench: it drives the real harness CLI on the task workspace, gateway keys already in place. Model is pinned per run (`--model`), defaulting to the same model across harnesses (Track-A pinning; aider red-flags drift).

### 2.3 Harness artifact import (retroactive lane A coverage; pattern exists in `src/store/local-usage.ts`)

Optional, opt-in per harness: read the harness's own session files (Claude `~/.claude/projects/*.jsonl`, Codex `~/.codex/sessions/**`, OpenCode SQLite) to backfill tool outcomes, terminal states, compaction boundaries for sessions *before* envelope capture was enabled. Fields verified in research: Claude `tool_result.is_error` / `toolUseResult` / `stop_reason`; Codex `TurnComplete.error` / `TurnAborted` / `compacted`; OpenCode `ToolStateError` / compaction parts. **No prompt text is ever read into the store** — outcomes and markers only. Dedup by structural keys (ccusage's `message_id+request_id+session_id+timestamp` discipline).

---

## 3. CLI surface (all inside the existing `harness`/`compare` family)

```
aiand harness compare [--last 30d] [--cohort <category>] [--json]      # lane A table, enriched (ships first)
  columns: harness×model rows; cost/sess p50 (n=…) | ttft p50 | hit | api-err
           | tool-err | one-shot | retry | missed-catch | turns/success* | outcome
  * turns-to-success and outcome columns appear only when envelope/import data covers ≥1 harness,
    with a coverage line: "behavioral columns: envelopes N%, imported M%, uncovered → —"

aiand harness compare --cohort debugging        # C6 cohort seam (HarnessStatsOptions.cohort) now fed by classifier
aiand harness compare recommend                 # unchanged recommend, now also ranking on one-shot + tool-err

aiand compare tasks                              # lane B: list personal tasks + validation status
aiand compare run  --task <id> [--harness a,b] [--model m] [--trials 3]
aiand compare table [--task <id>]               # per-(harness,model): solve x/n + Wilson CI, cost/solve,
                                                 #   wall, turns/solve, retry rate, failure modes; ▸ per column
aiand compare validate                          # fail-before/pass-after + null-harness control
```

Presentation rules (from bench research): per-column deterministic winners; every rate carries `n=`; CIs on solve rates; failure modes shown as a histogram row, never collapsed into "failed"; synthetic sweep block stays separate and never joins rankings (harness-matrix precedent); verdicts explain themselves (adopt CacheLane's `reasons[]` — `cacheVerdict` gains reason strings, one shared function, thresholds as law).

---

## 4. What deliberately does NOT ship

- **No arena/voting** (n=1 human picks — Harness Arena pattern — suits public judging, not personal decisions).
- **No trajectory replay across models** — no precedent anywhere surveyed; validity dubious; lane B re-executes from the instruction instead.
- **No LLM in the metric path.** Classification, retry, missed-catch are deterministic rules with fixtures. One opt-in exception: `compare audit` (P3) — a rubric audit (Harbor `analyze` pattern) that flags *suspicious successes* (passed with anomalously few turns) by checking the trajectory for integrity violations (edited the verify script? touched tests?). Off by default, per-run cost shown.
- **No composite score**; no winner when CIs overlap.
- **No prompt/completion content** in any store row, ever (envelope privacy contract, `envelope-capture.ts:18-20`).

---

## 5. Phasing

**P1 — Lane A behavioral columns (envelope → compare).**
Envelope v2 (`tool_outcomes`, `terminal`), migration 0007; missed-catch walk in `model-efficiency.ts`; `harness-stats.ts` rows gain tool-err/one-shot/retry/missed-catch/turns-success/outcome with coverage gating; compare renders them; `recommend` sorts on them. Fixtures pin every rule (recorded.ts golden discipline). *Exit: with envelopes on, `harness compare` shows tool-err and one-shot per harness on my real history.*

**P2 — Lane B: personal task replay.**
`compare tasks/run/validate/table`; task scaffold; drivers for the 3 adapters with headless modes; gateway request-id join for cost; Wilson CI + n-guards; failure-mode enum. Recorded behavioral fixtures for the *simulated* variant (scripted tool outcomes through the recorded transport — the seam research identified: `fetchImpl` + `scenario.toolResults` + layout policies) keep a zero-cost CI lane. *Exit: same task, same model, claude vs codex vs opencode — solve rate, cost/solve, wall, turns, retries, one table.*

**P3 — Depth.**
Artifact import (retroactive coverage + compaction frequency); `compare audit` rubric check; cohort comparisons per task category end-to-end; optional export of the compare table.

Sequencing rationale: lane A is pure aggregation over data we can start capturing today — it converts the existing compare from averages into behavior without any new runtime. Lane B needs harness drivers, which is heavier; OpenBench proves the format, our bench proves the dialect/verification plumbing.

---

## 6. Risks / open questions

1. **Envelope opt-in friction** — behavioral columns are empty until capture is on. Mitigation: compare prints the coverage line + the one-line opt-in; P3 artifact import backfills. Decide: promote envelope capture to ON-by-default with the privacy contract spelled out? (needs a product call — default stays OFF in this plan.)
2. **Missed-catch rule validity** — the v1 rule is a draft; it must be fixture-driven from real transcripts before shipping, and labeled `heuristic` with the rule string in the output.
3. **Headless harness drivers** differ per adapter (claude `-p --output-format stream-json`, codex `exec`, opencode run); some may lack clean headless+key modes — P2 spike per adapter, degrade to the recorded simulated lane if an adapter can't be driven.
4. **Same-model pinning cost** — replay trials on a user's paid gateway spend real money; `--trials` defaults to 3, `--dry-run` (recorded simulation) exists, per-run cost is printed before the run starts.
5. **Wilson CI on tiny n** — with 3 trials the CI is wide; the table says "tied" often. That is honest and the point.
6. **Store growth** — envelope v2 adds two fields per row, task runs add one JSONL per run; negligible vs request rows.

---

## 7. Acceptance (user-visible, end to end)

1. With envelope capture on and two harnesses used for a week: `aiand harness compare` shows per-harness tool-error rate, one-shot rate, retry rate, missed-catch rate, turns-to-success, outcome split — each with n and provenance, winner per column.
2. `aiand compare run --task fix-the-bug --harness claude,codex --model X --trials 3` then `aiand compare table` shows solve x/n + CI, cost/solve, wall, turns/solve, retries, failure modes; `compare validate` fails an unvalidated task loudly.
3. `recommend` ranks pairs using behavioral columns when coverage exists and says so when it doesn't.
4. Nothing about the existing `harness` synthetic bench changes except new fixture-pinned fields; all gates (`npm run lint && npm test && npm run check:dist && npm run check:public`) stay green; changelog entries per the repo contract.
