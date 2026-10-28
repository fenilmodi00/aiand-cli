# aiand-cli v2 — PRD

*Supersedes the v0.7 "aiand init" PRD. Branch: `cli-v2` + `feat/harness-observability`. Status date: 2026-10-28.*

## 1. The ask

Developers route multiple coding harnesses (Claude Code, Codex, OpenCode, Pi, Oh My Pi, Copilot CLI, Hermes) through the ai& gateway, but they cannot answer the question that decides their setup: *which harness with which model is cheapest, fastest, and most reliable for the work I actually do?* Vendor dashboards are opaque; local-file scrapers (ccusage and its kin) reconstruct costs from price tables and disagree with the bill. No local scraper can ever be billing-grade. Meanwhile the gateway already computes every number that matters, per request, in its `/logs` rows.

aiand-cli v2 makes the CLI the **observability layer for coding harnesses on ai&**: sync the gateway's per-request logs into a local store, attribute every request to the harness adapter, sessionize, and expose reporting, cross-harness comparison, benchmarks, forecasting, exports, and machine surfaces — billing-grade, local-first, reconciling exactly to the gateway's own numbers.

The second half of v2 is the **shell**. v0.7 was a command list: you invoked a verb, it printed rows, done. v2 turns the same CLI into an interactive product with a brand feel — a terminal-native menu replaces the static home screen, every command's output shares one visual language, and the whole surface is installable side-by-side so v2 can be adopted without touching a production install. Bare `aiand` on a TTY now opens a menu you navigate and search in; the first run plays a splash; every heading, badge, and status color comes from one ai& brand theme instead of raw terminal colors; ephemeral agent sessions (`aiand <agent> --session`) run a harness on ai& for one session with zero persistent config; `aiand update` keeps the install current; and the `aiand-v2` preview install gives the whole thing its own name, checkout, and state. The CLI stops being a bag of commands and becomes the ai& app in your terminal.

The observability surface and the shell are implemented and validated against the live gateway. The open work is server-side: the #80 gateway asks. This PRD describes what exists, states its guarantees, and names the gateway dependency precisely.

## 2. The surface

```text
# The interactive shell — bare `aiand` is now an app, not a command list
aiand                       # interactive menu (TTY): search, grouped rows, re-entrant
aiand welcome|banner        # first-run splash animation
aiand <agent> --session     # one ephemeral session on ai&, zero persistent config
aiand update [--check|--yes|--json]   # self-update (alias: aiand upgrade)

aiand-v2 ...                # side-by-side preview install (separate name/state/wiring)

aiand store sync|reset      # local store: incremental sync, self-heal reset
aiand usage                 # primary report; --verify, --audit
aiand sessions [<id>]       # per-conversation table + request-level drill-down
aiand cache                 # cache hit/miss/savings; --by agent|model|key; --attribute

aiand harness               # synthetic request-shape benchmark; --sweep-models
aiand harness stats         # per-harness real-workload stats
aiand harness compare       # side-by-side harness comparison (winner markers)
aiand harness matrix        # (harness × model) matrix; --synthetic overlay
aiand recommend             # ranked (harness, model) recommendation

aiand forecast              # burn-rate projection (v1)
aiand status --format line --watch    # statusline, watch, machine snapshot, exit codes

aiand dashboard             # interactive TUI (plain text when piped)
aiand heatmap               # 24h×7d cost/request grid
aiand wrapped               # share-friendly period story
aiand report                # self-contained offline HTML report
aiand overview              # ≤80-col pasteable plain-text summary
aiand efficiency            # one-shot/retry, task mix, branch spend (envelope-derived)

```

Entry points and naming: bare `aiand` on a TTY opens the menu; a pipe prints the static home screen; `--json` never opens the menu. All observability commands read the local store (auto-syncing first, `--no-sync`/`AIAND_NO_SYNC` to opt out) and share one flag vocabulary (`--since/--until/--last/--timezone/--agent/--harness/--model/--no-cost/--json/--jq/--format csv`).

The first block above is the transformation itself: the same binary goes from a static command list to an interactive, brand-themed shell. The observability commands below inherit that shell's visual language (`▌` headings, role-based color, piped-text discipline) while staying one-command-one-module scriptable underneath.

## 3. Where this stands

| State | Scope |
| **Built** | The observability surface: local store with incremental watermark sync and self-heal reset, accuracy gate (`usage --verify`), sessionization, attribution + provenance, doctor, usage reporting, sessions drill-down, harness stats/compare, synthetic benchmark pack with a recorded regression gate, statusline, budgets + burn-rate forecast v1, matrix + recommend, MCP server, OTel/Prometheus export (`gen_ai.*`), dashboard/heatmap/wrapped, report/overview, efficiency, adapter envelope capture. Plus the v2 shell: the interactive menu + first-run splash + ai& brand theme that turn the CLI from a command list into the ai& app in the terminal, ephemeral sessions, self-update, side-by-side `aiand-v2` preview installer, Hermes endpoint-restore fix, SIGPIPE handling, Esc/Ctrl-C navigation. |
| **Validation** | Exercised against the live gateway (`api.aiand.com`) with a funded key, including native Windows repro of every confirmed defect. The critical find: gateway `/logs` is newest-first and `after` is an exclusive *floor*, so the first incremental sync paged backward into history forever and the store went silently stale. Fixed: page from top, stop at `watermark − 5min` overlap, dedupe + stuck-cursor guard retained. |
| **Changing** | Nothing pending on the CLI side. |
| **Open** | #80 gateway asks (six server-team items, see §6). Residual low-severity gaps: Prometheus `# HELP` lines absent, `report --out` prints backslash paths on Windows (cosmetic, unfixed). |

## 4. What you can build on

| Existing capability | What it means for v2 |
|---|---|
| Gateway `GET /logs` (`src/api/logs.ts`: cursor, ≤100/page, 15m–30d) with per-request `id, model, api_key(masked), status_code, ttft_ms, latency_ms, input_tokens, output_tokens, cached_tokens, cost, currency, created_at` | Billing-grade data source; `cost` is gateway-computed, never recomputed locally. |
| Gateway `/analytics/summary|metrics` (≤3mo) | Reconciliation target for windows beyond the 30-day log range (`usage --verify`). |
| Agent adapters + key attribution (`src/agents/registry.ts`, `bakedKey()`, `nativeAiandKeys()`, `agent-keys.json` masked-key→agent map) | Harness attribution layer; adapters now sweep their own credential stores (Claude Code settings env, Codex `config.toml`, OpenCode/Pi hand-points, Copilot `providers.json`, Hermes `config.yaml`); unknown stays `unknown`, never guessed; sessions re-attribute when the map changes. |
| `node:sqlite` store precedent (`src/store/`: WAL, busy timeout, numbered migrations 0001–0004, corrupt-DB quarantine + fail-open recovery; the removed 0003 import migration leaves legacy tables in place, no longer read or written) | Zero runtime deps holds across the whole observability surface — even the OTel exporter and the TUI hand-roll their wire format and ANSI. |
| Recorded benchmark infrastructure (`src/benchmark/harness-bench.ts`, layouts, scenarios + `npm run benchmark:recorded` golden gate) | Deterministic offline regression (D4): 54-row golden fixture, pinned price table, byte-identical replay, `--update-goldens` refused under CI. |
| Brand theme (`src/cli/ui/theme.ts`: red gradient, dark/light via `COLORFGBG`, truecolor→256→plain) + exit codes 0/10/11/20/30 + `--json` conventions | Menu visual language extends to command output (`▌ Title` headings, accent roles) and every automation surface has a stable contract. |

## 5. Requirements

Requirements describe end state, not implementation.

> **Descope (post-#114).** Features that compute numbers over billing models the provider doesn't use are cut: the vendor list-price comparison (`usage --vs-list`), the ccusage JSON import, `harness duel`/`harness latency`, the calibrated `forecast --model v2` and its bench, the peak/off-peak split, and the `claude_code.*` OTel family. The gateway's model catalog and its `/logs` rows (`cost`, gateway-computed) are the only pricing and cost sources in the CLI; every number the CLI reports is either gateway-billed or derived from gateway data.

Provenance vocabulary is shared (`src/obs/provenance.ts`) and appears everywhere below: **`gateway-billed`** (verbatim gateway field — cost is never recomputed from a price table), **`estimated(<source>)`** (computed from gateway data: `estimated(user-override)`, `estimated(non-2xx excluding 429 / requests)`), **`heuristic(<name>)`** (depends on a heuristic, e.g. `heuristic(time-gap sessionization)`), **`unknown`**, **`unpriced`**, **`unattributed`**, **`insufficient data`**, **`UNVERIFIABLE`**. Derived numbers are never fabricated: empty windows report `null` errorRate, never `0.0`; impossible values clamp to `$0.0000` rather than printing `$-0.0000`.

### Foundation

**R1 — Local request store with incremental watermark sync.** The store mirrors gateway `/logs` rows verbatim, one row per request keyed by log `id` (`INSERT OR IGNORE` idempotency), with `sync_meta` watermark, numbered migrations, WAL + busy timeout + file lock for cross-process safety, and corrupt-DB quarantine + fail-open. Gateway conventions are pinned: `input_tokens` **includes** `cached_tokens`; `cost` stored as string, parsed numeric. Incremental sync pages from the top (no cursor params — `/logs` is newest-first and `after` is an exclusive floor) and stops when a page's oldest row reaches `watermark − 5min`; a quiescent no-op sync stops after one page; a gateway 400 ("after and after_id must be sent together") surfaces as a clean `CliError` recorded in `last_sync_error`, exit 0 with warning, never a stack or exit 70. Sync is fail-open: every read surface warns near the top of output and carries `sync: {status, at}` + `coverage` in `--json`.

**Done when:** re-sync of unchanged data inserts 0 rows; post-watermark rows are picked up on the next sync; repeated burst syncs never duplicate; `--no-sync` touches no network; corrupt DB is quarantined and rebuilt without losing locally captured envelopes.

**R2 — Sessionization.** Requests are grouped into sessions per masked key by time gap (default 10 min; `sessionGapMinutes` config, `--session-gap` flag wins over config over default), sorted by `created_at, id`, deterministic ids (SHA-256 key+start, 16 hex), rebuilt idempotently from verbatim rows. Mixed-model sessions are excluded from every model-level aggregate **and counted explicitly**. Every machine payload carries `sessionization: {method: "time-gap", gapMinutes, confidence: "heuristic"}`; human output gets a one-line note. There is no manual session-id override — the `--session` flag selects, it does not assign.

**Done when:** a 9m59s gap stays one session and 10m00s splits; different keys never merge; identical rows rebuild byte-identically; unknown session id exits non-zero listing nearest recent sessions.

**R3 — Attribution and provenance.** Every request is attributed via the masked-key→agent map; unattributed requests land in a structured `unattributed` bucket (`{count, share, hint}` in `--json`; count + `aiand cache --attribute <agent>=<masked-key>` hint in human output). Unknown keys stay `unknown` — attribution never guesses. Every derived number in `--json` carries a provenance label; `aiand usage --audit` prints the full provenance table (human + structured). Coverage gaps are surfaced, never folded: last sync, ingestion lag, missing UTC days (absent from aggregates, never averaged over), and local extent vs the 30-day gateway window stated explicitly.

**Done when:** every observability `--json` payload has provenance structure; a test asserts no code path recomputes cost from a price table; `--audit` renders the full table; sync failures visible until next success.

**R4 — Accuracy gate.** `aiand usage --verify` reconciles local sums against the gateway: ≤30d windows against `/logs`, ≤3mo against `/analytics/summary`, beyond that `UNVERIFIABLE` with reason (the 3-month analytics summary carries no cost → cost row `UNVERIFIABLE`, never dropped). Compares request count, tokens (input-includes-cached convention), and cost; tolerance is 1e-9 epsilon only, no rounding. `--verify --since/--until` filters the remote side by the requested window (wire-format `created_at` normalized via `datetime()` — `' ' < 'T'` string comparison once returned 0/0/0 for same-day windows). `--json` rows: `{source, window, metric, local, remote, delta, status}`. Exit 1 on any mismatch with exact deltas and "do not trust local reports" guidance; fixture tests in CI flip red on mutated fixtures.

**Done when:** consistent fixtures → all deltas 0, exit 0; deleted rows → MISMATCH + exit 1; >3mo → `UNVERIFIABLE`, not a guess.

### Reporting

**R5 — Usage reporting.** `aiand usage` is the primary surface: `--by day|week|month|session` (default day), `--sections daily,weekly,monthly,sessions,totals,by-model,by-agent` rendered from ONE store load, `--breakdown/-b`, `--since/--until/--last/--timezone/--agent/--harness/--model glob/--sort/--order`, `--no-cost/--no-totals/--no-breakdown`, `--compact` (auto <100 cols), `--jq`, `--format csv` (fixed header `period,requests,input_tokens,output_tokens,cached_tokens,cost,currency`), zero ANSI when piped. Currency honesty: costs are gateway-verbatim per currency; mixed currencies get per-currency rows + warning, never summed (case-folded keys so `USD`/`usd` merge, genuinely different currencies stay separate). Error rate: `errors` + `errorRate` = non-2xx excluding 429 over requests; empty window → `errorRate: null`.

**Done when:** golden tests cover DST-crossing and timezone bucketing; `--sections` triggers exactly one store read; CSV header is a locked snapshot; the same window agrees with `logs --errors`.

**R6 — Sessions surface.** `aiand sessions` lists sessions (id, harness attribution, model mix, turns = one stored request each, token sums, gateway-billed cost, TTFT p50/p95 via linear interpolation, errors, start/end) with `--top-cost N` (default 10, ties → newer session); `aiand sessions <id>` drills to request-level rows with a reconciling totals footer. Filters compose with R5 conventions and apply **before** sessionization; `--model` filters requests first. 0 measurable TTFT → `n/a`.

**Done when:** drill-down totals reconcile against the store; `--json` shapes stable for list + drill-down; CSV header locked.

**R7 — Harness comparison with cohort discipline.** `aiand harness stats` and `aiand harness compare` report real workload per harness: requests, sessions, token sums (gateway-billed), cost/session p50/p90 (linear interpolation, documented), TTFT p50/p95, cache hit ratio, error rate (non-2xx excl 429), shared `cacheVerdict` verdict column. `compare` requires ≥2 harnesses in range (exit 1 + guidance otherwise), marks per-metric winners with a color-independent `▸`, prints exact sessions behind each median via `--samples`, and excludes mixed-model sessions from every aggregate while counting them (`excluded: N mixed-model sessions`; `--include-mixed` escape hatch). Cohort predicate seam reserved for task-type narrowing. `--json` carries provenance (range, timezone, watermark, excludedMixed, sessionization annotation, field labels).

**Done when:** winner markers render without color; `--samples` reconciles with the medians; single-harness range errors with guidance; empty window is honest-empty (exit 0, explicit empty result).

**R8 — Model × harness matrix and recommendation.** `aiand harness matrix`: one row per (harness, model) — sessions, cost/session median, tokens/session, TTFT p50/p95 (`--show p90`), cache hit ratio, error rate, verdict; `--top/--sort cost|ttft|hit|errors/--order/--unpriced/--format table|json|markdown/--jq`; `--synthetic` shows the saved `--sweep-models` result in its own labeled block ("NOT your workload"), never joined into the ranking. `aiand recommend` ranks observed pairs only — cost/session median asc, tie-break hit-ratio desc then ttft p50 asc, no hidden weights; pairs <5 sessions go to an "insufficient data" block with sample counts; output includes the de-facto current pair, a heuristic expected delta, and a one-line wiring suggestion (`aiand <agent> on --model X`) — it never changes wiring. Both share one aggregation (`src/obs/pair-stats.ts`); unpriced rows hidden by default, surfaced via `--unpriced` as `unpriced`, never $0.00.

**Done when:** mixed-model sessions are excluded everywhere and counted; recommend never ranks synthetic data; `--unpriced` rows carry `unpriced` provenance, not zeros.

### Forecasting

**R9 — Budgets + burn-rate forecast v1.** Config: `budget.monthly`, per-harness `budget.harness.<name>`, `budget.warn-pct` (default 80); `aiand config get/unset budget`. Burn-rate v1: trailing-24h spend-per-hour (7d fallback) × hours remaining in the month; <2h of data → `indeterminate`, never fabricated; proportional-overlap attribution for boundary-spanning requests. Pacing verdicts `on-pace | exceeding | indeterminate | no-data | no-budget`; the verdict appears in `status` and the `usage` footer. Cost-showing commands print a one-line stderr warning at warn-pct, suppressible via `--no-warn`/`AIAND_NO_WARN=1`. **Budgets are advisory — the CLI warns, never blocks.** Mixed-currency stores refuse to sum with an explicit error. `--suggest-budget` proposes the P90 of ≥2 completed months (refuses with copy below that).

**Done when:** projection matches the formula in tests; overlap attribution correct; 80% warning fires and suppresses; empty/corrupt data yields `indeterminate`, not a number.

**R10 — Forecast scope.** `aiand forecast` runs the v1 linear burn-rate extrapolation only. There is no calibrated v2 model or scoring bench: v2 was built for a quota-window billing shape ai& doesn't have — the gateway is prepaid with a monthly budget, and "will I hit my budget?" is exactly what v1 answers. The synthetic benchmark (R11) is the only place unit-style price math appears, against a pinned offline table.

**Done when:** `forecast --help` documents only the v1 model; budget pacing surfaces (status, usage footer, overview, report) are unchanged.

**R11 — Bench infrastructure.** `aiand harness` replays request **shapes** (never prompts) across wire dialects (`anthropic-messages`, `openai-chat`) — scenario pack includes `multi-turn-refactor-long` (6 turns over a large stable file), `long-file-read`, `tool-heavy` (9 turns, 8 short tool exchanges), all deterministic fixtures; `--list-scenarios --json`, `--sweep-models` (parallel shapes, per-shape cache salt, saved to `bench-sweep.json`). `npm run benchmark:recorded` replays the whole pack offline from token shapes against a **pinned** price table (never the live catalog), reporting CacheLane 4 metrics (`baseline_cost_units`, `effective_cost_units`, `cache_hit_ratio`, `savings_ratio`), diffed against `test/golden/benchmark-recorded.json` in CI; `--update-goldens` refused under CI; reports gitignored under `runs/benchmark/`; goldens carry metrics + metadata only, never fixture text.

**Done when:** a deliberate price bump flips CI red with per-field diffs; two runs are byte-identical; no network in the recorded path.

### Insight surfaces

**R12 — Dashboard, heatmap, wrapped.** `aiand dashboard`: hand-drawn zero-dep TUI, CodeBurn keyboard model (1–6/arrows period, `p` harness, `c` compare, `j/k` scroll, `r` refresh), top-5 most expensive sessions pinned in every view, responsive 1/2/3 columns (breakpoints 60/100), 60s-floor in-place auto-refresh preserving scroll, non-TTY/`--no-tui` → plain-text overview (never hangs). `aiand heatmap`: 24h×7d grid in display timezone, `--metric cost|requests`, color ladder truecolor→256→16→ASCII, mixed currencies never summed (dominant-currency rows only, footer says so), `--json` per-cell. `aiand wrapped`: share-friendly story (requests, sessions, tokens, biggest session, favorite pairing, busiest day, cache-savings estimate), `--format markdown`, `--no-cost`, `--json`, provenance footer, honest empty states. All three read only from the local store and reuse the report engine's aggregations — no second aggregation implementation.

**Done when:** scripted-TTY keyboard test passes; orphaned rows below the frame blank on redraw (stale-footer fix); piped output is pure ASCII with zero escape codes.

**R13 — Offline report + overview.** `aiand report` writes ONE self-contained HTML file (inline CSS + SVG charts, no CDN, no server, no JS needed for core; `--theme light|dark|auto`, `--out/--out-dir/--open/--top/--sections timeseries,matrix,sessions,budget`) with provenance badges on every monetary figure and a coverage/sync footer; one store load feeds all sections (asserted). `report --json` includes a `totals` block matching the HTML numbers. `aiand overview` prints a ≤80-col copy-paste-safe summary (no box-drawing that breaks Slack/PRs): totals, by-harness share bars, top models, busiest days, per-day table, budget line; zero ANSI when piped; `--no-cost`; per-currency honesty; savings labeled `estimated`, absent when no cache. Budget pacing loads month-span rows for MTD math while `meta.range` keeps the requested window.

**Done when:** a test asserts no external URLs in the HTML; overview fits 80 columns and pastes cleanly; `--last 1d` covers exactly trailing 24h without widening to month-start.

### Programmatic surfaces

**R15 — OTel/Prometheus export.** `aiand export --format otel|prometheus` emits `gen_ai.*` (the GenAI semconv family) from ONE store read, no OTel SDK (hand-rolled OTLP/HTTP JSON and Prometheus text). Usage counters carry the input verbatim gateway sum — includes cache, the billing convention — plus cost itself (`gen_ai.client.inference.usage.cost`, USD, emitted only where cost exists). Token/duration/TTFT histograms with explicit buckets; `error.type` series for non-2xx with tokens on failed ops still exported. Every series carries `aiand.key.masked` + `agent.name` so counters never collide across processes. `gen_ai.provider.name` mapping by first match (claude→anthropic; gpt/codex/o1/o3/o4→openai; deepseek→deepseek; kimi/moonshot→moonshot_ai; grok→x_ai; glm/zai→zai; else family segment before `/` — never a per-name guess). Flags: `--range {15m|1h|6h|24h|7days|30days}`, `--since/--until`, `--temporality delta|cumulative` (delta default), `--endpoint` (POST instead of stdout), repeatable `--header`, `--file`. Prometheus is push-only (stdout/file/endpoint), not a pull server — the CLI is short-lived; documented deviation. No prompt/completion content in any attribute, ever.

**Done when:** an OTel collector consumes the payload; no series collision; Prometheus parses; same store + flags → identical output modulo timestamps.

**R16 — Single cost lane.** The CLI has no import adapter: ccusage-style JSON (a competitor tool's price-table-derived estimates) is never ingested into the store. The gateway's `/logs` rows are the single cost source; migration 0003's retired import tables are left in place on existing stores but no longer read or written.

**Done when:** no code path reads or writes the retired import tables; a test asserts `usage` totals come from gateway `requests` rows alone.

### v2 shell

**R17 — From command list to interactive CLI.** v0.7 answered bare `aiand` with a static home screen; v2 answers with a terminal-native menu on any TTY. The menu renders the ai& wordmark header (two-tone, version flush right, tagline under two dots), a search bar (`› Type to search agents and apps`) that filters rows as you type across label, group, hint, and keywords and shows an `N of M` match count, grouped rows (*Get started*, *Agents*, *More agents*, *Commands*, *Menu*) carrying per-row shortcut hints and state badges (`not installed` ⚠️, `signed in` ✅), a focused-row accent chip (`▌`) with bold label and description under a rule, a scroll window (`↑ N more`), and footer hints. Navigation: ↑/↓ or j/k, `1`–`9` jump, Enter opens, Esc → `Bye.`, Ctrl-C → exit 130. Enter runs the action and the menu redraws (re-entrant) so one `aiand` session covers several tasks; opening an agent hands over the terminal and exits the loop. Signed-out users get a two-row sign-in menu first (browser sign-in or pasted key) — the full menu appears only once a credential exists — with *Set up every agent I have* (`aiand init --all`) as the first row. First run plays the 4-phase splash (runner + gradient logo travel → ✦ burst → two-tone wordmark with version), gated by `welcome.json` (play-once, never in CI), skippable by any keypress, degrading to a single still frame on non-TTY/`NO_COLOR`/pipes so nothing ever hangs or throws; the splash reads keys in raw mode and always restores the terminal. Esc/Ctrl-C during an action cancel the action (dim line + menu redraw) and only leave at the menu itself; a no-match search Enter is a no-op.

**Done when:** bare `aiand` on a TTY opens the menu and a pipe still gets the static home screen; `--json` never opens the menu; the splash plays exactly once and never leaves a stale alternate screen; Esc/Ctrl-C never kill the CLI mid-action.

**R17a — One brand system across the shell.** All visual output comes from a single ai& theme (`src/cli/ui/theme.ts`): the ai& red gradient (`#EF2635` → `#E2091A` → `#C70007`) over warm neutrals, with roles — `brand` (wordmark, splash title), `accent` (menu chrome, focus bars, search highlights, command headings), `fill` (focused-row chip), `success`/`warning`/`danger`, `title`, `dagger`, `hint` — instead of raw terminal colors. Command output shares the menu's visual language: the shared style helpers paint red/green/yellow/cyan via the theme's danger/success/warning/accent roles, section titles render as accent `▌ Title` headings like the menu chrome, and the interactive menu frames each run with its command heading so tiled command output reads as one continuous surface. Terminal reality is respected: a truecolor → xterm-256 (nearest-cube) → plain-text ladder, dark/light palettes auto-detected from `COLORFGBG` with `AIAND_THEME=light|dark` override, `NO_COLOR` honored, version labels rendered as one contiguous color run, and theme tests independent of the host's `COLORTERM`. The brand applies to every surface added in this PRD — the dashboard TUI uses the same theme, and every observability command's headings/badges come from the same roles.

**Done when:** every color in the CLI routes through the theme roles (no raw terminal-color calls in command output); `NO_COLOR` and a 256-color terminal both render correctly; dark and light palettes both pass; the menu, command output, and dashboard TUI share one visual language.

**R18 — Ephemeral sessions.** `aiand <agent> --session` (and `aiand <agent> on --session`) runs one session on ai& through the adapter's `sessionLaunch` wiring with **zero persistent config**: a throwaway file/overlay is created and removed after exit, `--json` reports `{agent, mode:"session", model, files:[]}`, and stderr notes "This session ran on ai&; your config was not changed." `--session` lives before the first `--` and is stripped from passthrough. `copilot-app` (desktop GUI) refuses with a clear message. The child env is scrubbed (`AIAND_API_KEY` deleted, adapter `shadowEnv` names deleted — including exported `CLAUDE_CODE_OAUTH_TOKEN`, which is blanked in wiring and deleted from every launcher path so Claude Code sessions never ride the user's Anthropic subscription).

**Done when:** no config file differs after a session; `--session -- --my-flag` passes the flag through; every launcher path strips shadow env vars.

**R19 — Self-update and side-by-side preview install.** `aiand update` (alias `upgrade`) upgrades the running install kind: launcher installs re-run `install.sh` with `AIAND_NO_MODIFY_PATH=1` (never edits shell rc), npm installs run `npm install -g @aiand/cli@<latest>`, source checkouts are refused with a copy-naming the manual command. `--check` exits 1 when a newer version exists; `--yes` skips confirmation (properly declared in the parser — it was documented but rejected as "Unknown option"); `--json` prints `{current, latest, installKind, upToDate}`. The check is always a live registry read; post-update re-verification probes the version through the launched entry point so PATH shadows are reported instead of passing silently; `AIAND_API_KEY` is scrubbed from the installer child's env. The side-by-side installer installs this branch as **`aiand-v2`** next to production: separate command name, checkout (`~/.aiand/cli-v2`), state (`~/.config/aiand-v2`), and fork source (allowlisted only for the preview); `AIAND_COMMAND_NAME` (baked into the launcher) namespaces agent-wiring artifacts (profile names, provider IDs, `managedBy` markers) so both installs wire the same agents without clobbering each other; `aiand-v2 update` and `aiand-v2 uninstall` address exactly this install; `AIAND_V2_SIDEBYSIDE=0` restores production defaults. Staged installs verify `--version` + `--help` before swapping in, restoring the previous install on failure. The installer fetches published releases with `node` (no `curl` dependency on Alpine/busybox); `install.ps1` is unchanged — Windows preview runs from Git Bash.

**Done when:** `aiand update --yes` runs end-to-end; a PATH shadow is detected and reported; `aiand` and `aiand-v2` coexist wiring the same agent configs; staged install rollback works.

**R20 — Harness shell fixes.** Hermes `on`/`off` no longer let a pre-existing `model.base_url` hijack ai& routing: `on` drops the line, records its spot, and `off` restores it exactly (trailing comment once, own position; empty-section guard recreates the `model:` header; CRLF and no-trailing-newline files round-trip byte-identically; multi-line block scalars refuse with a hint instead of stranding the body). Piping into an early-exiting consumer (`aiand models | head`) exits quietly with the resolved exit code under SIGPIPE semantics — no EPIPE stack (regression test destroys the pipe read end and asserts clean exit). `aiand update --yes`, menu key-selection (`aiand key export`), `aiand --json <agent> --session`, `aiand pi on` `maxTokens` from `max_output_tokens`, trimmed keys, and reasoning-level clamping (Pi default medium, GLM-5.3 → high) are all pinned by tests.

**Done when:** `hermes off` restores the user's endpoint byte-for-byte; no EPIPE stderr under early pipe close.

### Automation and failure-mode guarantees

**R21 — Automation contracts.** Every observability surface honors the exit-code contract: `0` ok, `10` near-limit (≥80% of budget), `11` limit-hit (≥100%), `20` indeterminate, `30` no-data; plain `aiand status` keeps its documented auth exit codes (0 signed-in or gateway-unreachable, 1 signed-out). Empty-window commands are honest-empty (exit 0 + explicit empty/insufficient result — `harness compare` once exited 1 while `recommend` exited 0; now uniform). `--json` stdout stays parseable even when warnings hit stderr (`--profile <unknown>` warns once per name naming both requested profile and fallback — including the `AIAND_PROFILE` env form — across `config`, `cache`, `store`, `efficiency`). CLI input hardening: impossible dates (`--month 13`), nonexistent calendar dates (2025-02-29), inverted windows, non-directory `AIAND_CONFIG_DIR` all exit 1 naming the flag + value. No fabricated zeros anywhere: `errorRate: null` on empty windows, `$-0.0000`/`-0.0` clamped at the formatting boundary, `heatmap --json` / `forecast bench --json` / `--suggest-budget --json` all emit structured payloads on degraded paths.

**Done when:** automation can key on exit codes alone for pacing state; every `--json` surface parses under every degraded path; a regression test sweeps every command's profile-fallback path.

**R22 — Mid-stream abort classification.** A gateway mid-stream cut during `run`/`chat` no longer crashes with an undici stack + exit 70: the shared client classifies `TypeError: terminated`/`fetch failed` with network errnos (ECONNRESET/ECONNREFUSED/ETIMEDOUT/EAI_AGAIN/EPIPE) as a retryable unreachable-gateway `CliError` with a retry hint, exit 1; `AbortError` → exit 130 (Ctrl-C) stays first; non-network errors still rethrow with exit 70. Unusable agent config paths (file where dir belongs, unreadable) exit 1 with a hint; a 200-HTML gateway response surfaces as a gateway error, not a parse failure.

**Done when:** a mocked mid-stream reset exits 1 with the classified message; Ctrl-C mid-stream exits 130; genuine non-network bugs still crash loudly with 70.

**R23 — Store self-heal.** `aiand store reset` clears request/session rows for a full re-pull while keeping schema, migrations, and locally captured envelopes; confirms on TTY unless `--force`; `--json` reports what was cleared. This exists because sync itself is append-only (`INSERT OR IGNORE`): rows already synced keep NULLs forever if the gateway later adds columns — the reset re-pull plus the #80 `since`/forward-cursor ask are the recovery paths.

**Done when:** a stale store resets and the next sync re-pulls everything; locally captured envelopes survive a reset.

## 6. The gateway asks (#80) — the open dependency

#80 is OPEN, parent #59, label `observability, gateway-ask`. It is not a CLI implementation ticket: it tracks six server-team asks, with corrections where the issue's proposed API didn't match the client's reality. Suggested triage order is given at the end.

**Ask 1+2 (merged) — `x-aiand-envelope` header echo (#80 tracker).** `/logs` rows carry no project identity, and the adapter envelope (tool names per turn, hashed edit targets, branch) exists client-side but can't reach the server — so B4 project attribution, C3 task classification, and C5 one-shot/retry stay local-capture-only with honest coverage notes. **Correction:** the issue's proposed payload `{project_root_id, harness, agent_name}` does not match the real `EnvelopeV1` (`{schema_version, tools[], edit_targets[], project_root_id, git_branch}` — harness/agent_name are recorder options, never header fields). **Refinement:** merge asks 1+2 into ONE `x-aiand-envelope` header with a 4 KiB bound (not 2+2 KiB), echoed verbatim into a single opaque `/logs` column plus a materialized `project_root_id` for filtering — one header removes a class of proxy/431 failures and halves parsing surface. **Client status:** no header scaffolding ships in the CLI; the only envelope path today is local capture (opt-in, default OFF) feeding `efficiency` and the report surfaces. **Caveat recorded in #80 acceptance:** aiand-cli is not in the harness request path — only `aiand chat` and copilot-app's `headersJson` could forward headers today; landing this server-side alone unlocks nothing beyond `aiand chat` until per-adapter header follow-ups land.

**Ask 3 — Cache-write token split.** Only `cached_tokens` (= cache READS) is visible; cache-WRITE tokens (5-min-TTL writes, priced differently) are folded into input, so tier attribution and cost reconciliation are incomplete. **Critical underspecification correction:** the store contract pins `input_tokens` **includes** `cached_tokens`; adding `cache_creation_input_tokens` without a written convention **double-counts** every existing sum. The contract must state: **`cache_creation_input_tokens` is a subset of `input_tokens`, same convention as `cached_tokens`** (input = non-cached + cache_read + cache_write). Re-splitting `input_tokens` to exclude both is rejected — it breaks every stored row and the reconcile trust rule. This is the cheapest gateway win: self-contained, no client work, immediately improves tier attribution.

**Ask 4 — Native session ids.** Sessionization is a heuristic gap-based (default 10 min) with confidence annotations; a server-issued session id removes the guesswork. **Correction:** there is no manual session-id override in the client — sessions are gap-derived only. **Proposed shape:** accept `x-aiand-session-id` (regex `^[A-Za-z0-9._-]{8,128}$`), echo verbatim into a `/logs` column, NULL when absent, never synthesized server-side, no server session logic. Client adds a third confidence value `"gateway"` alongside `"gap" | "single-request"`. Echo-only; unlocks exact session boundaries, session stats, and an exact gateway session id on exported `gen_ai.*` series.

**Ask 5 — Per-key budget caps, self-scoped.** The CLI can only warn (budgets are advisory); a runaway agent needs a server-side stop. **Critical correction:** the issue's "CLI sets/clears via admin endpoint" assumes credentials that don't exist — `aiand key` is export-only and there is no admin role or second credential anywhere in the client. **Refinement:** self-scoped only — the key being capped authenticates via its own bearer token: `GET|PUT|DELETE /keys/self/cap` → `{cap: {amount, currency, window: "month"} | null, spent, remaining, resets_at}`. This is the only shape fitting the existing auth model. Needs an error-hint path so the CLI renders the gateway's refusal instead of inventing one. Per-project caps depend on ask 1.

**Ask 6 — User / billing-mode filters.** Org views (G6) need `user_id` and `billing_mode` (subscription vs API-equivalent) on `/logs` rows plus filters on `/logs` **and** `/analytics/*` (long-window rollups silently lose dimensions otherwise). **Correction:** both dimensions must be server-derived from the key owner — masked keys collide and the client cannot know the billing relationship, so client-supplied identity would be wrong. Never client-echoed.

**Cross-cutting:** (1) Sync is append-only — already-synced rows keep NULLs for new columns forever; the gateway needs a `since`/`updated_since` param on `/logs` or must accept a documented "applies from date X" policy surfaced via `src/store/coverage.ts`. (2) `/analytics/*` needs the new filters too, and its totals under new filters must still reconcile with filtered `/logs` sums (the accuracy gate is the referee). (3) Value-semantics are part of the API — ask 3 double-counts without the subset contract written down. (4) Transport is not the blocker; header merging already works per call.

**Suggested triage order:** 3 (cache-write split) → 4 (session ids, echo-only) → 1+2 merged (envelope echo) → 6 (user/billing-mode) → 5 (self-scoped caps). Efficiency's one-shot/retry and task-mix surfaces (R8's cohort seam, `aiand efficiency` coverage notes) wait on 1+2; until then they are local-capture-only and labeled as such.

## 7. Sequencing

The implementation is complete, so sequencing is merge-and-ship order plus the gateway dependency.

**First — foundation and accuracy (ship as the v2 merge).** The local store with incremental watermark sync and self-heal reset, the accuracy gate reconciling local sums against the gateway, sessionization, attribution + provenance, and doctor. The sync pipeline respects the gateway's newest-first paging semantics and its watermark-overlap stop rule, and every read surface stays honest about sync/coverage state.

**Then — reporting, forecasting, insight, programmatic surfaces, and the shell (rides the same merge).** Usage reporting, sessions drill-down, and harness stats/compare form the reporting layer; the synthetic benchmark pack with its recorded golden gate (`benchmark:recorded`) and the burn-rate forecast add forward-looking surfaces; matrix + recommend, efficiency, dashboard/heatmap/wrapped, and the offline report/overview complete the insight surfaces; the MCP server and the `gen_ai.*` OTel/Prometheus export expose everything programmatically. The v2 shell wraps all of it: the interactive menu + splash + brand theme make the CLI an app in the terminal, and ephemeral sessions, self-update, the side-by-side `aiand-v2` preview, and the harness shell fixes (Hermes endpoint restore, SIGPIPE, Esc/Ctrl-C) land with it. All of it is validated against the live gateway; its acceptance criteria are pinned by regression tests.

**Later (open — the real dependency).** The #80 gateway asks in the triage order above; #80 is the single tracker — the PRD makes no per-feature promises against it. Each ask lists the CLI surfaces it unblocks (cache-write split → tier attribution; session ids → exact session boundaries; envelope echo → server-side C3/C5/B4; user/billing-mode → G6/B8; caps → budget enforcement). Adapter-side header follow-ups are opened only after asks 1/2/4 land server-side.

## 8. Not in this version

- **CacheLane proxy** — request rewriting, cache-control breakpoints, pruning, compression, keepalive are cost-optimization, not observability. We port the *patterns* (per-turn records, CLI surface, golden benchmarks, MCP tools), not the proxy.
- **Vendor-quota scraping** — ai& is prepaid; we forecast budget, not Anthropic quota.
- **Hosted team backends** — the gateway is the backend; org views (G6) wait on ask 6 filters, not a new server.
- **Transcript parsers as primary source** — local-file scraping can never be billing-grade; the gateway sees everything the harness sends. There is no import adapter: ccusage and its kin are not ingested, period.
- **Client-side cost estimates as the source of truth** — the gateway bills; the client never re-prices gateway traffic. A price table appears only inside the synthetic benchmark, against a pinned offline table (see the Descope note in §5).
- **Cross-user/telemetry aggregation** — metadata-only, local-first; no content (prompts/completions) is ever stored or exported.

## 9. Where we need your read

1. **Gateway triage order.** We proposed 3 → 4 → 1+2 → 6 → 5 in #80. Gateway team: does the cache-write split ship fastest from your side, or does the echo column (1+2) unlock more value per engineering hour?
2. **OTel semantics.** `gen_ai.*` is now the sole export family (the vendor-named `claude_code.*` family is cut). When ask 3 lands, should we add `cache_write` series, or leave token counters as-is until users ask?
3. **Budget enforcement vs advisory.** E4 is advisory by design (warns, never blocks). When ask 5 lands, should the CLI offer an enforcement mode that surfaces the gateway's 429 as a stop, or stay advisory and let users set caps server-side?
4. **Dashboard scope.** The TUI already grew a compare view and pinned sessions. Anything more (mouse support, saved layouts) is creep against one-command-one-module simplicity — confirm the current keyboard model is the ceiling for v2.
5. **Prometheus `# HELP`.** Known gap (# TYPE/# UNIT emitted, no # HELP); tests only assert `# TYPE`. Small fix, but it changes golden fixtures — bundle with the next export change or ship standalone?

## 10. House conventions

- **Runtime:** Node 22+, TypeScript compiled with `tsc`, **zero runtime dependencies** — `node:sqlite` (WAL + busy timeout + file lock) for the store, hand-rolled OTLP/Prometheus serialization, hand-drawn ANSI TUI, hand-rolled seeded PRNG (mulberry32/Box-Muller/Marsaglia-Tsang).
- **Store:** numbered migrations with a `schema_migrations` ledger (0001 init → 0002 sessions → 0004 envelopes; the removed 0003 import migration's legacy tables stay in place on existing stores — next is 0005+); corrupt-DB quarantine + fail-open recovery; metadata only, no content columns (asserted by test).
- **One module per command:** commands register in `src/commands/index.ts` (`COMMANDS[]`); shared logic lives in `src/obs/` (`provenance.ts`, `pair-stats.ts`, `statusline.ts`, `otel.ts`), not in sibling commands.
- **`--json` everywhere** with stable shapes and `--jq` dot-path filtering where documented; mixed-currency values are never summed; derived numbers always carry provenance labels from the shared vocabulary.
- **Exit codes:** `0` ok, `10` near-limit, `11` limit-hit, `20` indeterminate, `30` no-data; `1` for mismatch/guided errors; `130` Ctrl-C; SIGPIPE-quiet on early pipe close.
- **Honesty discipline as law:** empty windows are `null`/explicit-empty, never fabricated `0.0`; unknown attribution stays `unknown`; unknown pricing stays `unpriced`; unpriced rows hidden by default; cost is never recomputed from a price table; impossible values clamp at the formatting boundary; sync failures are visible until they resolve.
- **Test isolation:** `AIAND_HOME`/`AIAND_CONFIG_DIR` redirect state; a net-guard forbids real network in unit tests; the recorded benchmark replays offline against a pinned price table; the suite runs on Windows (`.cmd` stub mirrors, NTFS-safe permission assertions, no inherited `COLORTERM`).
- **Changelog discipline:** every user-visible change lands under a versioned heading; help text and docs agree with behavior — a help-only gate or a synopsis showing a default that doesn't exist is treated as a bug, not a nit.
