# Changelog

All notable changes to this project will be documented in this file.

Versioning follows semver, with the caveat that before `1.0` a minor version may include
breaking changes while the command surface settles.

## [Unreleased]

### Added
- Scripted tool outcomes in the recorded benchmark (#128): scenarios can
  pin per-call results (`scriptedOutcomes`, reusing the `call_N` ids), the
  offline replay turns them into per-turn `toolErrors` and `retries`
  (error followed by a repeat) and per-row totals, and a new
  `tool-error-retry` scenario exercises the error → retry → success chain.
  The goldens pin the new fields; every behavioral number is labeled
  `simulated(scripted tool outcomes)` via the new fourth provenance tier
  and never joins observed rankings — the live gateway path is unchanged.
- Harness attribution refinement from the agents' own local usage records:
  a request the key+endpoint rules can only label `shared` (chat-dialect
  agents sharing one key) is refined to omp, pi, or opencode when that
  agent's own session history (omp/pi session JSONL, `opencode.db`) holds
  the unique matching record — same model, same output tokens, input within
  tolerance, within ±2 minutes. Stored per-request in the new
  `requests.attributed_agent` column (store schema v6), applied on sync and
  report reads, and never overriding a specific key/dialect label. Ambiguous
  matches (two agents' records agree equally) and requests whose agent kept
  no readable local record stay `shared`; the caveat surfaces in the
  report/overview notes.
- Claude Code, Codex, and Hermes now send an `x-aiand-agent` attribution
  header (`claude` / `codex` / `hermes`) so the gateway can log each request's
  agent. Claude Code carries it in `env.ANTHROPIC_CUSTOM_HEADERS` (the user's
  own pairs survive `on` and come back whole on `off`); Codex bakes it into
  the profile's `[model_providers.aiand]` as `http_headers`; Hermes adds
  `extra_headers` to the generated `providers.aiand` block, in persistent
  wiring and launcher sessions alike.

### Fixed
- Harness attribution now uses the gateway's per-request `endpoint` (the wire
  dialect: `/v1/messages`, `/v1/responses`, `/v1/chat/completions`), so
  Claude Code and Codex traffic on a key shared with other agents is
  attributed precisely instead of collapsing to `shared`. Same-dialect
  agents sharing one key (e.g. omp and pi) still honestly share, and rows
  synced before this change keep the old label until re-served.

### Removed
- The ccusage JSON import lane (`usage --import-ccusage <file|->`, the
  `--include-imported` combined grand total, the import adapter module, the
  imported-usage report section, and the migration 0003 store tables
  (`ccusage_imports` + `imported_usage`, left in place on existing stores and
  no longer read or written)). It imported a competitor tool's price-table-derived cost
  estimates as a parallel cost lane — the gateway's own logs are the single
  cost source.
- The `aiand mcp` stdio MCP server (#70) with its four tools (`usage_stats`,
  `session_stats`, `harness_compare`, `spend_check`), the `mcp.realProjectNames`
  config key, and the `src/mcp/` server module. The CLI `--json` commands are
  the programmatic surface; agents were the only consumer of the MCP layer,
  and the local store + `--json` output already serve that need directly.
- The vendor list-price comparison (`usage --vs-list`, the bundled vendor
  list-price snapshot module, the list-prices comparison module, the
  `--prices-file` flag, and the `config set prices.<model>.input|output|cacheRead`
  overrides with their sanitizer). It compared spend against third-party list
  prices the user never pays — the gateway catalog is the only pricing source.
- The peak/off-peak cost split (`usage --sections peak` and
  `usage --show-windows`) along with its window-table module and provenance
  entries. The aiand gateway does not bill by peak/off-peak windows, so the
  split was an estimate over a billing model the provider doesn't use.
- `aiand forecast --model v2` and `aiand forecast bench` (the calibrated
  Gamma-process Monte Carlo forecaster and its scoring bench, #77): the v2
  model was built for a quota-window billing shape ai& doesn't have — it is
  prepaid with a monthly budget, and the question "will I hit my budget?" is
  what the v1 linear burn-rate extrapolation already answers. `aiand forecast`
  now runs only the v1 burn-rate model; `overview`, `report`, and `cache`
  are unchanged. Model docs: `docs/observability/forecast-v2.md`
  is removed with it.

### Changed
- Bare interactive `aiand init` now lists every detected agent pre-checked:
  Enter alone wires them all; space still unticks the ones you do not want.
- `aiand restore` with no agent name now opens an interactive picker (mirroring
  `aiand init`): every agent with a snapshot is listed pre-checked, a single
  yes/no confirm replaces the --force flag, and scripts and `--json` runs keep
  the old usage error.
- `aiand recommend` and `aiand harness matrix` attribute mixed-model
  sessions per model instead of excluding them: each (model, slice) of a
  session spanning several models counts as its own session sample for that
  (harness, model) pair. Previously such sessions were silently dropped,
  discarding a large share of real spend (e.g. a 697-request / $18.02
  session interleaving main-agent and subagent models).
- Harness attribution labels traffic on a key several agents share as
  `shared` instead of crediting whichever agent was recorded first (or
  last, depending on the surface). `aiand init` bakes one sign-in key
  into every harness it wires, so the gateway's per-key logs cannot
  tell claude from codex from pi — yet the dashboard's session list said
  `claude` while By harness bucketed the same rows under codex / omp /
  aiand-cli, making Claude Code usage look inflated (observed: top-5
  sessions labeled claude with no claude row in By harness). One
  resolution rule now feeds every surface, and the materialized sessions
  table relabels when the key map changes.
- The interactive menu starts fast and shows feedback instead of a blank
  screen. Agent detection no longer spawns `where`/`which` per adapter —
  one memoized PATH scan (re-probed after wiring or launching an agent)
  took the menu build from ~5.3s to ~0.3s cold and ~0ms warm on Windows.
  Command modules load lazily on first run instead of all 31 at startup
  (the eager import cost ~440ms cold before the menu appeared). Every
  heavy menu action — sign-in, wiring agents, opening an agent, running
  a command — animates a spinner on stderr while it works, except the
  terminal-owning commands (`dashboard`, `chat`, `run-agent`), and
  the spinner always clears before the agent binary inherits the terminal.
- The interactive dashboard paints its first frame immediately from the local
  store and refreshes in place when the background gateway sync lands,
  instead of blocking on the network before anything shows.
- Gateway/API requests now time out after 10 seconds instead of hanging until
  the OS gives up (measured 11s+ on unroutable hosts). Status and other
  networked commands also skip re-importing the agent adapter graph on every
  sync call (~100ms per sync back to the caller).

### Added
- The bundled list-price snapshot (`bundled@2026-10-28`) now prices the
  gateway's first-party models — zai-org/glm-5.3, zai-org/glm-5.3-flash,
  deepseek-ai/deepseek-v4-pro, deepseek-ai/deepseek-v4.1-flash,
  qwen/qwen3.8-27b, qwen/qwen3.6-27b, moonshotai/kimi-k3 — each entry citing
  the vendor pricing page it was read from, so `usage --vs-list` reports
  `priced` rows with non-null savings for real traffic instead of
  `equivalent unpriced` everywhere. google/gemma-4-31b-it is deliberately
  absent: Google publishes no paid per-token price for it (AI Studio serves
  it free-tier only; Vertex AI lists a different Gemma 4 size), so under the
  never-guess policy it stays unpriced. DeepSeek entries list peak rates
  (DeepSeek bills peak vs off-peak, not by input length; peak is exactly 2x
  off-peak, so priced savings are conservative by at most 2x on off-peak
  requests).

### Removed
- The adapter-envelope gateway-echo scaffolding: the `x-aiand-envelope` header
  constant and its serializer from `src/agents/envelope.ts`. Nothing sent the
  header and nothing read it back — the gateway does not forward or echo
  envelopes (gateway ask #2 remains open in ticket #80). Locally captured
  envelopes (the store table, `envelope-capture`, and the `efficiency` reports
  built on them) are the only envelope path and are unchanged.

### Fixed
- Session-launched agents (`aiand <agent> --session`, `aiand run-agent`)
  now record their key→agent mapping at launch, so the gateway's request
  rows land under the agent's harness in `dashboard`, `usage`, and
  `harness stats`. Before, a session launch ran on the CLI's own session
  key without recording a mapping; the sync sweep labeled that key
  `aiand-cli`, and every request the agent made was attributed to
  aiand-cli instead of the agent (observed: an omp session's glm-5.3
  traffic counted under aiand-cli). The persistent `on` path already
  recorded it; the session path now does too. Existing machines repair
  themselves at the next session launch, or once per agent with
  `aiand <agent> on`; past rows re-label instantly because attribution
  is a read-time key lookup, not a stored column.
- Interactive prompts no longer vanish under the menu spinner: when the
  interactive menu runs `login` or `logout` (or any command that asks a
  question) behind its animated spinner, the question was erased within
  80ms by the spinner's line redraw and the screen showed a hung
  "Working..." loader until Enter was pressed blind. The spinner now
  pauses its frames for the whole lifetime of an interactive read —
  `confirm`, pasted-key input, and the org picker — clears its line in
  place, shows the cursor, and resumes animating only after the answer.
- Picking a command in the interactive menu no longer prints its title
  twice — the `▌` heading owns the command title and the spinner below
  it now shows a generic "Working..." instead of repeating the summary
  text.
- bare `aiand key` now says what the command is for and gives a
  copy-pasteable example (`aiand key export`) instead of a bare verb list
- `harness stats`, `harness compare`, and `harness matrix` made the cost of
  mixed-model sessions visible (OBS-LT-4): these sessions are excluded from
  every per-harness/per-pair row by design, but the only trace was a footer
  count, so harness totals didn't visibly reconcile with `usage`. The footer
  now also shows the excluded sessions' gateway-billed spend — session and
  request counts, token sums, and cost with the same provenance as pair
  costs, never folded into any row. `--json` carries it under
  `excludedMixedSpend` (one shared definition in `src/obs/pair-stats.ts` /
  `src/obs/harness-stats.ts`); no line prints when nothing was excluded.
- `harness latency` / `harness duel` flag UX: an unknown layout in
  `--pair harness=...` (the natural first guess `harness=default` included)
  now names every valid layout AND suggests omitting `harness=`
  (`--pair model=<model>`) to use the default layout `omp` — which is now a
  supported shorthand. Both commands' `--help` list every valid layout, and
  `harness duel --help` names `--turns-cap` as the flag that limits replayed
  turns (there is no `--turns`). `harness duel` reports ALL unmet argument
  requirements (shape source conflict, pair count) in one error instead of
  one at a time.
- `aiand run`/`aiand chat` traffic on a machine with no agents wired showed
  as `unknown` everywhere: `agent-keys.json` was empty, so nothing identified
  the CLI's own key. The store sync now self-records the key the CLI
  authenticates with as a first-class `aiand-cli` entry (same local sweep
  seam as the adapter native-key sweep — runs even when the gateway is
  unreachable), so `aiand sessions`, dashboard "By harness", `wrapped`,
  `overview`, harness stats, and `aiand doctor`'s agent-keys check reflect
  CLI-own traffic. Agents wired with the same key keep their label (the self
  entry is a fallback, not a claim); a foreign key the CLI never presented
  still stays `unknown`.
- Live-gateway sandbox testing of every command on this branch surfaced
  defects, now fixed and regression-tested.
  `usage --vs-list` showed `usd 0.000000` billed for models the bundled
  list-price snapshot does not price: the billed accumulator lived inside the
  priced-row branch, so gateway-billed cost was silently dropped for unpriced
  models (the plain `usage` report showed the real total). Billed now
  accumulates for every row; equivalent/savings stay `unpriced`-honest. And
  the note "run any catalog-reading command once to cache it" never came
  true: `aiand models` and `aiand cache` fetched the catalog but never wrote
  the 6h `model-catalog.json` cache the offline readers (report/overview
  savings) price from. Both commands now persist the cache on fetch.
- Harness attribution showed `unknown` for traffic an agent sent with a key
  the CLI never baked — most visibly omp running on its own OMP
  authentication (`aiand harness compare`, dashboard, sessions, usage, and
  OTel export all ride the same key map). Adapters now expose
  `nativeAiandKeys` (omp's `agent.db` `aiand` credentials; OpenCode/Pi
  providers hand-pointed at the gateway; Claude Code settings env blocks
  pointing at the gateway; Codex `config.toml` gateway providers via
  `env_key`/`experimental_bearer_token`/`requires_openai_auth`; Copilot CLI
  `providers.json` gateway rows; Hermes `config.yaml` gateway blocks with
  their `key_env` var), and every store sync sweeps them into
  `agent-keys.json` before anything else — purely local, so it runs even
  when the gateway is unreachable. Never swept, deliberately:
  Claude/Codex OAuth credential stores (OAuth tokens are not ai& keys),
  `apiKeyHelper`/`auth.command` scripts (no arbitrary execution at sync
  time), plain env vars outside the config that names them, and the Copilot
  app's user-made provider rows (their keys live in the OS keychain, and
  the only in-db readable shape is byte-identical to what `on` writes —
  `aiand cache --attribute copilot-app=<masked-key>` labels those by hand).
  A key the agent has since rotated away with no trace left anywhere stays
  `unknown` (never guessed); the materialized `sessions` table
  re-attributes when the key map changes.
- Re-login/key rotation stranded pre-rotation history as `unknown`: rebake
  swapped the new key into agent configs but never recorded it in
  `agent-keys.json`. Rebake now records the swapped-in key, so rows under
  both the old and new keys keep their harness label.
- `aiand dashboard` TUI looked dead on real stores: every period key, arrow,
  `p`, and `r` froze the frame for seconds (only `c` and `q`, which skip the
  data refresh, responded). Root cause: harness attribution re-read
  `agent-keys.json` once per request row (~2.7s for a 2799-row store on
  Windows). The report build now reads the key map once and resolves every
  row from memory, so a refresh is ~350ms and all keys respond.
- `aiand dashboard` TUI left the previous frame's tail rows on screen when a
  keypress produced a shorter frame (`p` scope changes, `c` compare toggle):
  the in-place redraw never cleared below the frame, so the old footer and
  stale panels stayed visible and actions looked like they ran twice. The
  redraw now blanks the orphaned rows, mirroring the prompt renderer.
- `est. saved` showed $0.0000 despite a high cache-hit rate: savings priced
  cached tokens at the cheap cached rate, which is exactly what the gateway
  already bills, so the counterfactual equaled the billed cost. Savings now
  price all input at the full rate (what a cold cache would have cost),
  matching the `aiand cache` formula.

### Changed
- The dashboard TUI now uses the same brand theme as the home screen
  (two-tone ai& wordmark, accent-highlighted active period tab, themed
  section titles and muted meta lines) and its layout spans the full
  terminal width (the pinned-sessions divider no longer caps at 60
  columns).
- Command output now shares the menu's visual language (ticket #76 follow-up
  to the brand theme): the shared style helpers paint red/green/yellow/cyan
  with the ai& palette's danger/success/warning/accent roles instead of raw
  terminal colors, section titles across `usage`, `sessions`, `cache`,
  `efficiency`, `recommend`, and the harness commands render as accent
  focus-bar headings (`▌ Title`) like the menu chrome, and the interactive
  menu frames each run with the command heading so tiled command output
  reads as one continuous surface.

### Removed

- `aiand harness duel` and `aiand harness latency` (ticket #119): both ran
  live billed gateway requests for personal A/B comparisons. The store-backed
  `harness stats` / `compare` / `matrix` answer the same harness×model
  question from real traffic, and the synthetic `harness` benchmark remains
  the offline performance path.
- The `claude_code.*` OTel metric family (`claude_code.session.count`,
  `claude_code.cost.usage`, `claude_code.token.usage` with the
  input-excludes-cache conversion) from `aiand export` — dashboard-
  compatibility cargo named after one vendor's agent on a CLI that ships
  eight. The vendor-neutral `gen_ai.*` family is the sole export surface and
  now carries cost (`gen_ai.client.inference.usage.cost`) and per-model token
  usage itself; the constant-0 `cache_write`/`reasoning`/`cacheCreation`
  series it emitted despite the store having no such data are gone too
  (emit-only-where-data-exists). The gateway has no cache-write split or
  reasoning-token column, so those series were zeros reading as real
  measurements.

## [0.7.0] - 2026-10-26

### Added
- `aiand store reset` (ticket #95, OBS-BF-10) — clears the request/session rows so the next `store sync` is a full re-pull, keeping the schema, migrations, the ccusage import dedupe ledger, and locally captured envelopes (opt-in, not re-pullable) intact; confirms unless `--force`, `--json` reports what was cleared. Self-heal for a stale store without hand-deleting `store.db`.
- `aiand usage` surfaces the error rate (ticket #98): the report's totals
  carry `errors` and `errorRate` (non-2xx statuses excluding 429, over
  requests — the same single #88 definition `harness stats` uses, so text,
  `--json`, and harness stats agree on identical data). The plain report
  prints an `error rate` line with the counts; `usage --audit` lists the
  `estimated(non-2xx excluding 429 / requests)` provenance. An empty window
  yields `errorRate: null` (and no plain line) — never a fabricated 0.0.
- `aiand mcp` — a stdio MCP server for coding agents exposing `usage_stats`, `session_stats`, `harness_compare`, and `spend_check` over the local request store; project names are pseudonymized by default (`project-a1b2`), opt out with `config set mcp.realProjectNames true`.

- `aiand dashboard`, `aiand heatmap`, and `aiand wrapped` (ticket #75),
  all hand-drawn with zero runtime dependencies. The dashboard is an
  interactive TUI with CodeBurn's keyboard model: keys 1–6 and arrows switch
  period (Today/7d/30d/Month/6mo/Lifetime), `p` cycles the harness scope,
  `c` toggles the harness-compare view (the #64 winners), `j`/`k` scroll,
  `r` refreshes, and in-place auto-refresh (60s floor) preserves scroll; the
  five most expensive sessions stay pinned in every view; layout is
  responsive (1 column under 60, 2 from 60, 3 from 100); piped stdout (or
  `--no-tui`) prints the plain-text overview and never hangs. `aiand
  heatmap` renders the 24h×7d cost (or request-count) grid in the display
  timezone with truecolor→256→16→plain glyph degradation; mixed currencies
  never sum (dominant-currency rows only, footer says so). `aiand wrapped`
  prints the share-friendly period story (requests, sessions, tokens,
  biggest session, favorite pairing, busiest day, cache-savings estimate)
  as text or `--format markdown`, with `--no-cost` and `--json`; every
  figure carries its provenance footer.
- Personal A/B replay + latency A/B (ticket #82): `aiand harness duel`
  replays a recorded session's request SHAPE — turn count and per-turn
  prompt-token growth curve from the local store — across repeatable
  `--pair harness=<layout>,model=<model>` configurations (or a synthetic
  `--scenario`), reporting total cost, cost/turn, tokens, cache-hit ratio,
  TTFT p50/p95, wall time and errors side by side with deltas vs a
  `--baseline` pair, provenance labels (cost is `gateway-billed` X-Cost
  billing from the duel run), a shape-source footer ("filler content is
  synthetic — real prompts never left this machine"), `--seed` +
  `--turns-cap`, `--format table|json|markdown`, `--save`, a billed-request
  plan + confirmation prompt (`--yes` to skip), and clean Ctrl-C abort with
  partial results labeled. `aiand harness latency` runs a live TTFT loop
  per pair through the normal gateway path (no proxy needed) and compares
  against historical store `ttft_ms` percentiles for the same (harness,
  model) over `--since/--until/--last` (default 7d); under 5 historical
  samples it prints `insufficient data` instead of a thin percentile. Same
  seed + shape + pairs produce byte-identical cost/token tables offline —
  the D4 golden-fixture prerequisite (pinned in the test suite).

- Calibrated forecast v2 + `aiand forecast bench` (ticket #77): `aiand
  forecast --model v2` runs the claumon MODEL.tex v2.2 model over the local
  store — OLS rate over the trailing 30 minutes conjugated with a prior from
  past completed day-windows (variance corrected for path noise), a
  rectified-Gaussian rate draw per path, Gamma-process increments over
  5-minute steps, and a K=500 seeded Monte Carlo (mulberry32; `--seed` or a
  seed derived from the forecast month, so identical inputs give
  byte-identical output). Output: median month-end projection + 80%
  credible interval (uncapped — overshoot is projected demand), projected
  utilization unclamped above 100%, and ETA-to-budget median + 80% CI that
  is nil when P(never reaching) >= 50%. `aiand forecast bench [--model
  v1|v2]` replays past daily windows offline from the store and scores
  CRPS, pinball loss (q10/q50/q90), 80% coverage, bias, plus the
  [delta, delta^2] calibration regression with a plain-language verdict;
  the deliberately miscalibrated non-rectified-Gaussian variant measurably
  worsens bench coverage. Model docs: `docs/observability/forecast-v2.md`.

- `aiand sessions` (ticket #62): a per-conversation view over the local
  request store. The list shows one row per session — session id, harness
  (masked-key attribution), model mix, turns (one stored request = one turn),
  token sums, gateway-billed cost, TTFT p50/p95 (linear interpolation), error
  count, and start/end — with `--top-cost N` surfacing the most expensive
  sessions (cost descending, ties by the newer session, default 10 when the
  flag is passed bare). `aiand sessions <id>` drills into one session with
  request-level rows (timestamp, model, tokens, cost, latency_ms, ttft_ms,
  status code) and a reconciling totals footer; an unknown id exits non-zero
  with the nearest recent sessions. Filters compose with the report
  conventions (`--since/--until`, `--last`, `--timezone`, `--agent`,
  `--harness`, `--model` globs, `--session-gap`), plus `--no-cost`,
  `--compact`, `--format csv` (fixed header, one row per session+currency),
  `--no-sync`/`AIAND_NO_SYNC`, and `--json` carrying the mandatory #66
  sessionization confidence annotation. Mixed currencies are shown per
  currency, never summed. Auto-syncs before reading and fails open.
- `aiand harness matrix` and `aiand recommend` (ticket #79): the model ×
  harness matrix and recommendation engine over the local store's observed
  workload. `matrix` renders per-(harness, model) rows — sessions,
  cost/session median, tokens/session, TTFT p50/p95 (p90 via `--show p90`),
  cache hit-ratio, error rate (non-2xx excluding 429), and the shared
  `cacheVerdict` verdict — with `--sort cost|ttft|hit|errors`, `--order`,
  `--top`, `--unpriced` (unpriced rows are hidden by default, never guessed),
  `--format table|json|markdown`, `--jq`, and `--synthetic`, which displays
  the saved `aiand harness --sweep-models` sweep (now persisted to
  `bench-sweep.json`) in its own clearly-labeled block that never joins a
  ranking. `recommend` ranks observed pairs only — cheapest cost/session
  median first, tie-break hit-ratio desc then ttft p50 asc, no hidden
  weights — hides pairs under 5 sessions in an "insufficient data" block
  with their sample counts, and prints the de-facto current pair, the
  heuristic expected delta, and a one-line `aiand <agent> on --model X`
  wiring suggestion; it never changes wiring itself. Both commands share one
  aggregation (`src/obs/pair-stats.ts`), exclude mixed-model sessions from
  every pair (counted in a footer, never assigned to a model), and carry
  provenance labels on every JSON row.
- Deterministic benchmark regression gate (ticket #67). `npm run
  benchmark:recorded` replays the whole harness scenario pack offline
  (deterministic prefix-cache transport, no network, no live gateway) and
  costs every scenario x layout from token shapes at a PINNED price table —
  never the live catalog — reporting CacheLane's four metrics
  (`baseline_cost_units`, `effective_cost_units`, `cache_hit_ratio`,
  `savings_ratio`). The replay is diffed against committed goldens in
  `test/golden/benchmark-recorded.json` both in the test suite and as a CI
  step, so pricing-math, reconciler, or aggregation drift fails with a
  readable diff; regenerate goldens locally with `npm run benchmark:recorded
  -- --update-goldens` (refused under CI). Reports land in the gitignored
  `runs/benchmark/`; goldens carry metrics and metadata only, never fixture
  text.
- `aiand harness stats` and `aiand harness compare` (ticket #64): real-workload
  per-harness stats and side-by-side comparison from the local store —
  requests, sessions, token sums (gateway-billed), cost per session p50/p90
  (linear interpolation, documented), TTFT p50/p95 over requests, cache hit
  ratio, error rate, and the shared `cacheVerdict` thresholds as the verdict
  column. `compare` requires at least two harnesses in range (exit 1 with
  guidance otherwise) and marks the per-metric winner (`▸`, works without
  color). Cohorts discipline: mixed-model sessions are excluded from every
  aggregate AND counted explicitly (`excluded: N mixed-model sessions`);
  `--samples` prints the exact sessions behind each median/P90;
  `--include-mixed` shows the excluded table; a cohort predicate seam is
  reserved for task-type narrowing. Filters compose with `aiand usage`
  conventions (`--since/--until/--last/--agent/--model/--timezone/--no-cost`),
  auto-sync is fail-open with `--no-sync` honored, and `--json` carries
  per-harness objects plus provenance (range, timezone, store watermark,
  excludedMixed, sessionization annotation, field labels).
- Adapter envelope (ticket #78). A versioned, compact per-request metadata
  schema (`aiand-envelope/v1`: ordered tool names, hashed edit targets
  `<basename>#<hash16>`, hashed `project_root_id`, `git_branch`; ≤ 2 KiB,
  documented in `docs/observability/adapter-envelope.md`) that adapters can
  capture through `createEnvelopeRecorder` — opt-in and default off
  (`AIAND_ENVELOPE_CAPTURE=1` or `"envelopeCapture": true` in config.json);
  metadata only, no prompts/completions/file contents/full paths, ever.
  Envelopes are stored locally (store migration 0003, `envelopes` table)
  linked to request rows by masked key and timestamp, and travel as the
  `x-aiand-envelope` header the gateway ask (#80) expects. New
  `aiand efficiency` report from locally captured envelopes only: one-shot /
  retry rate per harness and model (retry = same file re-edited after a shell
  command in between), the 13-category deterministic task classification
  (zero LLM calls), and per-project / per-branch spend attribution with a
  named-branch / pre-recording / no-branch coverage split. Every section
  prints its coverage ("N of M requests have envelope data") and a
  "local-capture only" note until the gateway forwards envelopes.
- OTel metrics export (ticket #72). `aiand export` emits usage metrics from
  the local request store in two families from one store read: `claude_code.*`
  (drop-in compatibility with Claude Code dashboards: `session.count`,
  `cost.usage`, `token.usage` with the input-excludes-cache conversion) and
  `gen_ai.*` per the OpenTelemetry GenAI semantic conventions (usage counters,
  token histograms with explicit buckets, request duration and
  time-to-first-token; `error.type` on failures with usage recorded on failed
  operations too). OTLP/HTTP JSON (protobuf-JSON shape) or Prometheus text
  exposition; delta temporality by default, `--temporality cumulative`
  opt-in; output to stdout, `--file`, or a push to `--endpoint` with
  repeatable `--header`. Every cost/token series carries the masked key and
  agent name so concurrent agent exports never collide into one counter
  series (claude-code#56317). Session ids are heuristic (time-gap derived);
  `cacheCreation`/cache-write tokens are 0 until the gateway splits cache
  writes. No prompt or completion content is ever exported.
- ccusage JSON import adapter (ticket #73). `aiand usage --import-ccusage
  <file|->` ingests `ccusage daily|weekly|monthly|session|blocks --json`
  output (file path or stdin, e.g.
  `ccusage daily --json | aiand usage --import-ccusage -`) fully offline —
  no sync, no network. Rows land as EXTERNAL source
  `imported(ccusage@<import-date>)` in their own store tables (migration
  0003, `ccusage_imports` ledger + `imported_usage`), never mixed into the
  gateway-mirrored `requests`; re-importing identical input is a no-op
  (content-hash dedupe) and a newer payload replaces the same report
  periods instead of stacking. In `usage` output imported rows are their
  own clearly-labeled source row, EXCLUDED from gateway totals by default
  (anti-double-count); `--include-imported` adds a combined grand total
  beside — never replacing — the gateway-only totals. ccusage costs are
  price-table-derived USD equivalents, labeled
  `estimated(imported ccusage <date>)`, never gateway-billed, and kept in
  their own currency lane; tokens are normalized to the gateway convention
  (input includes cached) on the way in; unknown schemas are refused
  loudly, never guessed.
- Offline HTML report and plain-text overview (ticket #76). `aiand report`
  writes one self-contained HTML file (inline CSS and SVG charts, no CDN, no
  server, no JS required; `--theme light|dark|auto`, `--out`/`--out-dir`,
  `--open`, `--top`, `--sections timeseries,matrix,sessions,budget`) with
  per-harness daily cost and cumulative-savings time series, a (harness x
  model) comparison matrix, the most expensive sessions, and budget pacing;
  every monetary figure carries a provenance badge and the single store load
  feeds all sections. `aiand overview` prints a copy-pasteable, <=80-column
  period summary (totals, by-harness share bars, top models, busiest days,
  per-day table, budget line) that drops color automatically when piped;
  both read only the local store (`--no-sync` honored, sync failures
  surfaced without blocking) and keep costs per currency, never summed.
  Savings are `estimated` from the cached model catalog and simply absent
  when no cache exists.
- Peak/off-peak split and vendor-list-price equivalent (ticket #81).
  `aiand usage --sections peak` splits each model's gateway-billed cost into
  peak/off-peak shares (percentages of cost that sum to 100, plus per-bucket
  cost and request counts) using a versioned per-family window table — GLM
  peak is Mon-Fri 14:00-18:00 SGT — applied as a pure GROUP BY over stored
  `created_at` rows, evaluated as wall-clock time in each window's own
  timezone; unclassified model families and non-first-party (routed)
  traffic are reported explicitly, never guessed.
  `aiand usage --show-windows` prints the window table with its per-entry
  sources (`--json` for the raw data). `aiand usage --vs-list` recomputes
  stored tokens at vendor list prices and sets the equivalent beside the
  gateway-billed cost, with savings = equivalent − billed shown only where
  both sides are priced (partial rows say so). Exact-only matching through
  a snapshot alias map (never-guess: unknown models are `unpriced`, never
  $0.00), tier ranges validated non-overlapping, and per-field user
  overrides via `aiand config set prices.<model>.input|.output|.cacheRead`
  labeled `estimated(user-override)`. The bundled snapshot ships
  schema-complete but price-empty — an entry lands only through a reviewed
  change citing a vendor pricing page — and `--prices-file <path>` accepts
  an updated snapshot (format 1) without a code change; the snapshot name
  and date are always printed. `--json` includes per-row `{ billed,
  equivalent, savings, priced, status, reason, source, snapshot_date }`;
  `--jq` filters the payload.
- Budgets and burn-rate forecasting (advisory only — the CLI warns, it never
  blocks). `aiand config set budget.monthly <X>`, optional
  `budget.harness.<name>` overrides, `budget.warn-pct` (default 80), plus
  `aiand config get budget` and `aiand config unset budget.<key>`. New
  `aiand forecast` command: burn-rate v1 projection (current month spend +
  spend-per-hour over the trailing 24h, falling back to the trailing 7d)
  against the budget window with an on-pace / exceeding / indeterminate
  pacing verdict, projected month-end figure and exceed date, provenance
  labels on every row, `--harness` / `--since` / `--until` / `--last` /
  `--range` filters, `--json` / `--jq`, and `--suggest-budget` (P90 of
  completed months, minimum two). The pacing verdict also appears in
  `aiand status` and the `aiand usage` footer, and cost-showing commands
  (`usage`, `cache`, `logs`, `forecast`) print a one-line stderr warning at
  warn-pct of the monthly budget, suppressible with `--no-warn` or
  `AIAND_NO_WARN=1`. Mixed-currency stores refuse to be summed with an
  explicit error. `aiand forecast bench` is a reserved stub for the v2
  calibrated forecast.
- Store-backed usage reporting (`aiand usage`, ticket #60): daily/weekly/monthly/session
  blocks (`--by day|week|month|session`, default day) with token and
  gateway-billed cost rollups plus a totals row, from the local request store
  (auto-synced before read, fail-open on sync failure; `--no-sync` /
  `AIAND_NO_SYNC=1` reads the store as-is offline). Filters compose:
  `--since`/`--until` (dates interpreted in the display timezone), `--last
  7d`-style relative windows, `--timezone <tz>` (bucket boundaries follow IANA
  timezones, DST-aware), `--agent`/`--harness` (repeatable, masked-key
  attribution), `--model` globs (repeatable), `--sort <column>` / `--order
  asc|desc`. `--breakdown/-b` appends per-model sub-tables; `--sections
  daily,weekly,monthly,sessions,totals,by-model,by-agent` renders multiple
  sections from ONE store read. `--json` emits a stable `{meta, sections}`
  payload; `--jq <filter>` applies a minimal dot-path filter to it;
  `--format csv` prints the primary section with the fixed header
  `period,requests,input_tokens,output_tokens,cached_tokens,cost,currency`.
  Report UX conventions: `--compact` (also automatic under a 100-column
  terminal; drop order documented in help), `--no-cost`, `--no-totals`,
  `--no-breakdown`, and color auto-drop when stdout is piped. Costs are always
  the gateway-verbatim per-request `cost` in its own currency — mixed-currency
  ranges show per-currency sub-rows and a warning, never a cross-currency sum;
  every derived number carries its #68 provenance label and the report prints
  #68 coverage/sync footnotes.
- Attribution and provenance for every number the CLI reports. Requests that
  cannot be attributed to an agent are surfaced as a structured
  `unattributed` bucket (`{count, share, hint}` in `--json`, a count plus the
  fix-it hint on the human report — `aiand cache --attribute
  <agent>=<masked-key>` maps an unknown key; keys absent from the map stay
  `unknown`, never guessed). Every derived number in observability `--json`
  payloads carries a provenance label — `gateway-billed` (verbatim gateway
  field, e.g. cost and token sums; cost is never recomputed from a price
  table), `estimated(<source>)` (computed by ai& from gateway data, e.g. hit
  ratio), or `heuristic(<name>)` (depends on a heuristic, e.g. time-gap
  sessionization) — via the shared vocabulary in `src/obs/provenance.ts`,
  which `aiand usage --audit` prints as a full provenance table (human) or a
  structured list (`--json`), offline.
- Coverage-gap honesty on reports: the local archive's actual coverage is
  stated, not implied — last successful sync and sync status (a failed or
  `--no-sync`-skipped pre-command sync warns near the top of human output and
  carries `sync: {status, at}` in `--json`; sync failures are recorded in the
  store and survive until the next success), ingestion lag (now minus newest
  stored request), the local archive's extent (so the 30-day gateway window
  vs local archive boundary is explicit), and an enumerated list of UTC days
  inside the requested range with zero local rows — absent from local
  aggregates, never averaged over. `aiand cache` syncs the store before
  reporting (opt out with `--no-sync` / `AIAND_NO_SYNC=1`) and attaches
  `coverage` to its `--json` payload; the coverage engine lives in
  `src/store/coverage.ts` for other reports to reuse.
- Statusline, watch mode, and the machine snapshot contract (`aiand status`,
  feature catalog E3/G5). `--format line` renders the one-line statusline —
  `💰 $2.10 session / $8.40 today | 🔥 $1.85/hr 🟢 | 45%→72% of budget |
  ttft p50 320ms` — from the local store only, never a blocking gateway call
  (block pricing omitted in v1). `--watch [seconds]` (default 10s, min 2s)
  refreshes in place with a stale-while-refresh pattern and a dim
  `stale HH:MM` suffix once data is older than 3× the interval; Ctrl-C exits
  0. `--write-state <path>` atomically writes the versioned machine snapshot
  (`schema_version` 1, `generated_at`, `spend`, `burn`, `budget`,
  `verdict`, `ttft`, `stale`, `provenance`) for tray apps and statusline
  hooks; `--print` also prints the line, `--sync-first` chains one explicit
  sync. Automation exit codes on every observability-surface run: `0` ok /
  `10` near-limit / `11` limit-hit / `20` indeterminate / `30` no-data.
  Plain `aiand status` keeps its documented auth exit codes and now shows
  the statusline line under the auth fields.

### Fixed

- `store`, `efficiency`, and `mcp` no longer fall back to the default profile silently when an explicit unknown `--profile` (or `AIAND_PROFILE`) is set (OBS-BF-17, #103): the same stderr warning `config`/`cache` emit (naming the requested profile and the fallback) now fires, while `--json` stdout stays parseable.
- A gateway cutting a response body mid-stream during `run`/`chat` no longer
  crashes with a raw undici stack and exit 70 (OBS-BF-18, #104): the
  connection loss is now classified as a retryable unreachable-gateway
  failure (human message + retry hint, exit 1); Ctrl-C mid-stream still
  exits 130.
- Budget pacing in `aiand report` / `aiand overview` no longer projects a
  month from a narrow window (ticket #97): when the requested window starts
  after the current month began (e.g. `--last 1d`), the budget section now
  loads month-span rows for its month-to-date math while `meta.range` and
  every other section keep the requested window.
- `aiand usage --verify --since/--until` now honors the requested window on
  the remote side (OBS-BF-11, #96): gateway log rows carry `created_at` in
  the wire format (`2026-10-26 05:02:11.844519+00`), which bare string
  comparison ordered before every ISO bound, so windowed verifies compared
  the local store against remote 0/0/0. Remote rows are now filtered by
  instant, matching the store's #86 normalized window comparisons; the
  exit-code contract (0 match, 1 mismatch with per-metric deltas) is
  unchanged.

### Changed

- Consistent empty-window contract (ticket #100): `harness compare` and
  `recommend` now both follow the honest-empty pattern — a window with no
  requests exits 0 with an explicit empty/insufficient result instead of
  `compare` erroring while `recommend` exited 0, so automation can key on
  exit codes; "no data" is an answer, not a failure. A `--profile <unknown>`
  override no longer silently serves the default profile: the fallback stays
  but a warning naming the requested profile and the built-in-default
  fallback prints once per requested name on stderr (stdout `--json` stays
  parseable and unchanged).

- Benchmark scenario pack expansion for `aiand harness`: three new scenario
  families — `multi-turn-refactor-long` (a six-turn refactor over a large
  stable file body), `long-file-read` (one very large read dominating the
  tokens), and `tool-heavy` (nine turns interleaving eight short tool
  exchanges after the initial read). All fixtures are fixed strings, so
  generation is fully deterministic; every new scenario is expressible in
  both wire dialects and runs against every harness layout. Scenario
  results in `--json` output now name their scenario, and a new
  `aiand harness --list-scenarios` flag (with `--json` support) prints
  every scenario id with its description.
- Sessionization: stored requests are grouped into sessions per `api_key`
  (masked) by time gap — a gap of the threshold or more between consecutive
  requests starts a new session (default 10 minutes, configurable via the
  `sessionGapMinutes` key in config.json and a `--session-gap <minutes>`
  flag on the commands that surface sessions). Sessions carry deterministic
  ids, the key→agent mapping (`unknown` when unmapped — never guessed),
  start/end, turn counts, and token/cost totals that follow the gateway
  convention (input includes cached); a materialized `sessions` table in the
  local store is rebuilt idempotently from the verbatim request rows. Because
  the gateway provides no server-side session ids, boundaries are explicitly
  heuristic: machine payloads include a `sessionization` confidence
  annotation ({method: "time-gap", gapMinutes, confidence: "heuristic"})
  and human output gets a one-line note. `--session <id>` scoping and
  `--since`/`--until` window filters are provided for the stats/session
  commands.
- `aiand usage --verify` — a reconciliation accuracy gate comparing the
  local store's totals (request count, token totals, cost totals) against
  the gateway's own numbers: `/logs` for windows up to 30 days and
  `/analytics/summary` for the 3-month window (which reports no cost, so its
  cost row is reported UNVERIFIABLE, never dropped). Windows the gateway
  cannot see (past 3 months, or arbitrary slices wider than 30 days) are
  reported UNVERIFIABLE with a reason. Per-window deltas are printed in both
  human and `--json` output ({source, window, metric, local, remote, delta,
  status}); every number is a gateway-verbatim sum (tokens follow the
  gateway convention where input includes cached; nothing is recomputed from
  price tables). The command syncs the store first (fail-open, `--no-sync`
  respected; a failed sync is surfaced, never folded away) and exits 1 when
  any metric mismatches, 0 when everything reconciles. A mismatch is
  reported with its exact delta — no rounding tolerance beyond a
  floating-point epsilon on parsed cost strings.
- A local, metadata-only request store. Every gateway `/logs` row is mirrored
  into a SQLite database at `<config dir>/store.db` (`node:sqlite`, no new
  dependencies), giving long-term request history the gateway itself cannot
  serve beyond its 30-day window. `aiand store` shows the store's status;
  `aiand store sync` pulls the newest rows incrementally (watermark-based,
  idempotent re-sync, WAL + cross-process file lock, page-by-page watermarks
  so an interrupted sync resumes where it stopped). A corrupt store is
  quarantined and recreated automatically — the CLI keeps working, with a
  loud warning. Observability commands parse `--no-sync` (and honor
  `AIAND_NO_SYNC=1`) to read local data without touching the network. No
  prompt or completion content is ever stored.
- `aiand doctor` — observability health checks, one line per source: gateway
  reachability (one minimal `/logs` probe), auth validity, agent adapter
  wiring, the key→agent map, local store health, and log-ingestion lag.
  Verdicts use the `OK (n)` / `NOTHING FOUND` / `ERRORS` vocabulary (plus
  `SKIPPED` when a dependency is absent); `--json` emits per-check results
  with stable ids (`gateway`, `auth`, `adapters`, `agent-keys`, `store`,
  `lag`). Exit code 1 when any check reports `ERRORS`, 0 otherwise.
- A side-by-side preview install. This branch's `install.sh` installs as
  `aiand-v2` next to a production `aiand` instead of over it: the checkout
  lives in `~/.aiand/cli-v2`, runtime state (credentials, locks, agent
  snapshots) goes to `~/.config/aiand-v2`, and the source is this fork's
  `cli-v2` branch — never the published npm release. The launcher bakes the
  install's identity (source, branch, dirs, command name), so `aiand-v2`
  update re-fetches the preview branch and its uninstall removes exactly the
  preview files. Agent wiring (codex profiles, opencode/omp/pi/copilot
  provider ids and `managedBy` markers) follows `AIAND_COMMAND_NAME`, so both
  installs can wire the same agents without clobbering each other's entries.
  `AIAND_V2_SIDEBYSIDE=0` restores the production defaults (the test
  harnesses pin it); the block is deleted when the branch merges back.

- `AIAND_BRANCH` names the branch to clone when `AIAND_SOURCE` is a git URL.

- `install.sh` re-runs fetch remote changes when the script being run is the
  checkout being installed (`aiand update`'s rerun of the launcher's own
  `install.sh` on the source path) instead of rebuilding the old tree in
  place; running `install.sh` from inside any other checkout still installs
  that local source.

- Hermes Agent is now wired like the rest: `aiand hermes on` ships a
  dedicated `aiand` model-provider plugin under
  `~/.hermes/plugins/model-providers/aiand`, adds a `providers.aiand` block
  to `~/.hermes/config.yaml` (`base_url` carries `/v1`, because Hermes posts
  to `${base_url}/chat/completions`), and writes the session key to
  `~/.hermes/.env` (mode 0600) as `AIAND_HERMES_API_KEY`. The plugin carries
  each model's published reasoning levels, so a user's picked level is clamped
  to a set the model accepts and a level left unset sends no
  `reasoning_effort`, leaving the model's own engine default
  (`reasoning_effort_default`) to apply; reasoning switched off omits the
  field entirely instead of sending a level the model does not publish (models
  that do accept it still receive `none`). The model pin
  comes from the live catalog; `--model <id>` switches it, and
  `--model native` leaves the model section as it is. `off` removes exactly
  what `on` added, puts a set-aside model and any set-aside `ANTHROPIC_*`
  lines back, and leaves a provider block you repointed (`base_url` or
  `key_env`) in place with a note. A `providers:` or `model:` key holding an
  inline flow map or an anchor is no longer rewritten: those shapes refuse with
  a by-hand hint instead of dropping the providers the value carried (or
  leaving a duplicate block behind), and a wired home whose `providers:`
  carries an anchor reads as on again, so a second `on` cannot splice a second
  block. A multi-line quoted `.env` value is stripped whole by `off`, so no
  part of it is left behind in your file and the key reads back in full. A
  foreign `providers.aiand` block or a
  legacy `custom_providers` entry named aiand is refused instead of
  overwritten. `aiand hermes` with no verb opens that wiring: the install
  hint is printed rather than run (it is not an npm install), and inherited
  `ANTHROPIC_*` and `OPENAI_*` values are dropped so they cannot outrank
  the files `on` wrote. `status`, `init --all`, logout, and rebake cover it
  (#17, thanks @fenilmodi00).
- `aiand run-agent hermes` launches Hermes on ai& for one session with
  nothing written under the real `~/.hermes`. A throwaway `HERMES_HOME`
  holds the same `aiand` provider plugin, a routing-only `config.yaml`, and
  the key in the overlay `.env`. The child is started with
  `--provider aiand --model <id>` (a launch always names a model, so
  `--model native` is the usual catalog error). Your plugins, sessions, and
  skills are linked back in; inherited `ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN`,
  `OPENAI_API_KEY`, and `OPENAI_BASE_URL` are removed from the child;
  `--provider`, `--model`, and `-m` after `--` are stripped. The overlay is
  deleted when Hermes exits, and store shims that pointed at it are put back.
  On Windows the state links back through junctions (a directory symlink
  there needs Developer Mode), so a session's writes survive cleanup, and
  the Hermes install hint names the PowerShell form of the same pinned
  installer instead of a `curl | bash` line a Windows shell cannot run
  (#17, thanks @fenilmodi00).
- The ai& CLI landing page now lives in `site/` and is published to
  GitHub Pages by `.github/workflows/pages.yml`. It shows four steps:
  create an account in the console, redeem a promo code on the console's
  billing page, install the CLI with npm, and run `aiand code`, with a switch
  that swaps in `aiand codex` or `aiand claude`.


- `aiand cache` reports the prompt-cache hit rate, the miss rate, what was
  spent, and what the cache saved — grouped by agent, by model, or by key
  (`--by agent|model|key`). Every number comes from the gateway's own
  per-request reporting, priced per model from the live catalog, because the
  cache-read rate is model-specific (GLM 0.30 against a 1.00 input rate,
  Kimi 0.50 against 3.00, DeepSeek 0.02 against 0.30). Requests are
  attributed to an agent by the API key the CLI baked into that agent's
  config; a key the CLI cannot place is reported as `unknown` rather than
  guessed, and `--attribute <agent>=<masked-key>` labels one by hand.

- `aiand harness` compares agent request *shapes* on cache behavior. A
  harness here is a request shape, not a prompt, and each harness speaks its
  own wire dialect: Claude Code posts to `/v1/messages` (Anthropic), Oh My Pi
  posts to `/v1/chat/completions` (OpenAI). The benchmark replays a use case
  through each shape and reports what the gateway actually charged. The
  shapes are measured, not asserted: a stable system block with an
  append-only transcript hits (73.3% over four turns), and so does a
  reordering that never changes — but a rebuilt system block, a compaction,
  or a reordering that *moves* as the conversation grows all miss at 0%.
  `--sweep-models` runs every shape against every model in the catalog; the
  shapes run in parallel, each with its own cache salt.

- The CLI now remembers which key each wired agent uses, so `aiand cache`
  can attribute the gateway's per-request rows to it. The map is written
  when an agent is wired and dropped when it is unwired.

### Changed

- `aiand update` upgrades this install in place. The update check is always a
  live registry read (`--check` reports and exits 1 when a newer version
  exists, `--json` prints `{current, latest, installKind, upToDate}`), an
  upgrade asks before running unless `--yes` is given, and the installer runs
  with inherited stdio and `AIAND_NO_MODIFY_PATH=1` so it never edits shell rc
  files. A launcher install re-runs `~/.aiand/cli/install.sh`, an npm global
  install runs `npm install -g @aiand/cli@<latest>`, and a source checkout is
  refused with the command to run by hand. After the install child exits the
  version is re-verified through the launched entry, so a PATH shadow is
  reported instead of passing silently. `aiand upgrade` is an alias.
  `AIAND_AUTO_UPDATE=0` silences the background update notice only.

- `aiand <agent> --session` and `aiand <agent> on --session` run the agent on
  ai& for one session without writing any persistent config: the adapter's own
  `sessionLaunch` wiring (the one `aiand run-agent <agent>` uses) layers a
  throwaway file or overlay over the user's config, the agent runs, and the
  launcher removes it after the child exits. `--session --json` reports
  `{agent, mode:"session", model, files:[]}`. Adapters that cannot launch a
  session (`copilot-app`, the desktop app) refuse with a clear error.

- A terminal-native interactive surface. `aiand` with no command now prints
  a home screen — brand header and version, then titled sections of
  `command  description` rows aligned on one column — in place of the old
  text block, and `aiand welcome` plays a first-run splash
  on an alternate screen: a block runner travels in from the left while the
  three-color mark travels in from the right, they collide into a `✦` burst,
  and the wordmark lands as a two-tone title — `AI` in white, `AND` in ai&
  red — with the version beneath. It plays once per fresh install
  (a counter in `welcome.json`, never in CI, never on a pipe, skipped by any
  keypress) and `aiand welcome` replays it. Prompt lists are restyled the same
  way: the focused row is a filled chip carrying a `▌` accent bar with the
  label in bold and the trailing hint right-aligned. Colors come from a
  two-palette brand theme (dark by default, light when `AIAND_THEME=light` or
  the terminal reports a light background), drawn as truecolor with an
  xterm-256 fallback and plain text under `NO_COLOR`.

- Recolored the interactive surface to the ai& brand: the palette is the ai&
  red gradient `#EF2635` / `#E2091A` / `#C70007` over warm neutrals.
  Menu chrome (focus bars, search highlights, section titles) now uses the
  gradient's bright stop, the wordmark and splash title keep the deep red,
  and the focused-row fill is ai& graphite `#303037` (light: `#EEE9E9`).
  Unused palette roles and the unused six-color chart ramp were removed.

- `aiand welcome` renders the animated wordmark; `aiand banner` stays as an
  alias for it.

- The installer's two install paths are now named by what they install rather
  than by a speed ranking: the published path installs the npm release
  tarball with its already-built `dist/`, and the source path installs your own
  source, cloned or copied and built. `AIAND_PUBLISHED_RELEASE` (1 requires the
  published release, 0 requires source, unset tries published then source)
  replaces `AIAND_FAST_INSTALL`, which is still honoured as a deprecated alias
  printing `AIAND_FAST_INSTALL is deprecated; use AIAND_PUBLISHED_RELEASE.` —
  keep using it if you must, but move to the new name. Only vocabulary and the
  path names change: every staging, ownership, and launcher guard is unchanged.

- `aiand` with no command on a terminal now opens an interactive menu instead
  of printing the static home screen: a search bar that filters agents and
  commands as you type, grouped rows each showing its command and a state
  badge, the focused row's description under a rule, a scrolling window with
  `↑ n more` markers, and a footer of key hints (`↑↓ move`, `enter open`,
  `type to search` and `esc quit`, swapping to `esc clear` once a query is
  entered). Enter runs the chosen agent or command and the menu comes back, so
  one `aiand` session covers several tasks, and a number jumps straight to that
  row. The header prints the wordmark in the ai& brand red with the accent
  orange, the version flush right, and the tagline under two logo dots; the
  orange carries menu chrome while the red stays for errors. A pipe still
  prints the static home screen, so scripts and `aiand | less` keep working,
  and `--json` never opens the menu.
- A signed-out `aiand` now shows a two-row sign-in menu first — browser
  approval or a pasted API key — and only shows the full command menu once a
  credential exists, so a first-time user is never dropped into a menu where
  every row fails.
- The menu now opens with **Set up every agent I have** (`aiand init --all`),
  wiring every installed agent in one go, and splits agents into *Agents* and
  *More agents*. An agent under *More agents* is one ai& supports that this
  machine is missing; Enter offers its install and then wires it, the same as
  the bare command.
- The menu header prints the `AI&` wordmark in place of the two status dots,
  and the tagline drops the brand name the wordmark already carries.
- The menu row builders moved to `src/cli/menu-items.ts`, so the row shape is
  testable without a terminal.


- `aiand claude on` picks DeepSeek V4.1 Flash for Claude Code's fast slot,
  then Gemma 4. ai& retires DeepSeek V4 Flash, Kimi K2.7 Code and GLM 5.2 on
  2026-10-27 0:00 JST; Kimi K2.7 Code also leaves the main-slot preference.
  A setup written before that date still names DeepSeek V4 Flash: run
  `aiand claude on` again.
- `--base-url` and `aiand config set api-url|auth-url` refuse `/v1`-suffixed
  URLs (adapters append `/v1` themselves, so a suffixed URL would double to
  `/v1/v1`) and base URLs carrying a query or fragment, at set time. An
  unreachable gateway no longer echoes credentials embedded in the base URL.
  (#34, thanks @fenilmodi00)
- The installers now run the installed `aiand --version` for you and print
  the version, instead of asking you to run it.
- At the end of an install, the installers ask "Log in to ai& now?" and run
  `aiand login` on yes. They skip the question when you are already signed
  in, when `AIAND_API_KEY` is set, in CI, or without a terminal. With
  `AIAND_API_KEY` set they say the key is in use instead of suggesting
  `aiand login`. A failed or cancelled login never undoes the install:
  Ctrl+C at the question counts as no, and Ctrl+C during the login stops
  only the login (`install.sh` still exits 0).

- The adapter contract gained an optional `bakedKey()`, implemented by the
  Claude Code, OpenCode, Pi, Oh My Pi, GitHub Copilot CLI and GitHub Copilot
  app adapters. It reads the key from the agent's own config — the same
  file `on` writes — so agents wired before this change are still
  attributed. An adapter that bakes no key of its own (Codex asks
  `aiand key export`) does not implement it.

- `--harness` is now repeatable, so two shapes can be compared directly:
  `aiand harness --harness claude-code --harness omp`.

### Fixed

- Incremental store sync (OBS-BF-9, #94): the gateway's `/logs` is newest-first
  and `after` is an exclusive floor, so an incremental sync that started at
  `watermark − 5min` could never page forward to rows newer than the watermark —
  every sync after the first inserted 0 rows and the store went silently stale
  (`usage --verify` MISMATCH). The sync now pages from the top on every run and
  stops as soon as a page's oldest row reaches the overlap floor
  (watermark − 5min): new traffic is picked up in full, the watermark advances,
  PK dedupe (`INSERT OR IGNORE`) and the stuck-cursor guard are unchanged, and a
  quiescent no-op sync stops after one page instead of walking the full 30-day
  range. A gateway 400 "after and after_id must be sent together" surfaces as a
  clean failed sync (warning + `last_sync_error`, exit 0) — never a raw stack.
- `aiand report` and `aiand overview` honor the exact requested window
  (#97). A `--last 1d` window that started inside the current calendar
  month was silently widened to month-start (including explicit `--since`
  dates), so the report covered the whole month while `usage` honored the
  same flags exactly — and the rendered range label and `--json` range
  metadata lied about it. The three surfaces now agree: the range label
  and metadata equal the requested window.
- Observability JSON surfaces honored `--json` incompletely (ticket #99):
  `heatmap --json` now emits machine-readable per-cell data (day, hour, and
  spend or count per cell, plus metric/currency/peak metadata) instead of
  silently printing the text render; `forecast bench --json` and
  `forecast --suggest-budget --json` emit `{ "status": "insufficient-history", ... }`
  on the degraded path instead of prose (happy paths unchanged); `report
  --json` includes a `totals` block (requests, tokens, per-currency costs,
  savings) matching the HTML's numbers for the same window. Money
  formatting never renders a fabricated `$-0.0000` / `-0.0` for an
  epsilon-negative accumulation (overview, wrapped, report, heatmap
  legends) — negatives that round to zero render as plain zero at the
  formatting boundary.

- Store sync cursor: the outer sync loop advanced by `created_at` alone,
  so any timestamp owning more rows than one page re-served the identical
  page forever — a live sync captured 103 of 832 rows and never finished
  (#85). The loop now threads the `(created_at, id)` pair from each page's
  last row, a stuck-cursor guard stops instead of spinning (reporting
  `ok: false` with `last_sync_error` recorded), and every observability
  command surfaces the stuck cursor as a failed sync (`ok: false`) with a
  visible yellow warning and `last_sync_error` metadata instead of silently
  serving incomplete history.
- Same-day `--since`/`--until` windows matched zero rows on every
  observability surface (`usage`, `sessions`, `heatmap`, `dashboard`,
  `export`, `forecast`, `statusline`, `efficiency`, `report`, coverage
  scan). Window filters compared the gateway's wire-format `created_at`
  (`2026-10-26 05:02:11.844519+00`, space separator, stored verbatim)
  against ISO `T` strings in SQL text comparisons, and `' ' < 'T'` dropped
  every same-day row. All date-window filters now compare through one
  normalized `datetime()` expression shared from the store (#86).
- CLI error hardening (#87): impossible `--since`/`--until` values (month 13,
  hour 25) and nonexistent calendar dates (2025-02-29, which used to roll over
  to March 1) now fail with a `CliError` naming the flag and value instead of a
  raw stack trace or a silently shifted window. `AIAND_CONFIG_DIR` pointing at
  a regular file fails with `config dir is not a directory` instead of a raw
  `ENOTDIR`/`EEXIST` stack on reads and writes alike. `--profile` values are
  validated on every report path — including `--no-sync` and sync-failure
  fallbacks, which used to render a report for an unsafe name. Inverted
  windows (`--since` after `--until`) are rejected on every window-filtered
  command instead of quietly reporting nothing.

- `usage --include-imported` no longer splits one currency into two lanes in
  the grand total (`usd` + `USD`): gateway rows carry lowercase currency
  codes while the ccusage import stored `USD`. Currency keys are now
  casefolded where rows accumulate into cost maps (gateway rows, imported
  rows, session rows), so mixed-case spellings of the same currency merge
  into one summed lane across `--format json`, `csv`, and text renders;
  genuinely different currencies (`usd` + `eur`) stay separate. (#89)
- Harness help tells the truth (#90): `harness compare --samples` now renders
  the contributing session list (previously documented but stats-only);
  `--last` help on `harness stats`/`compare`, `matrix`, and `duel`/`latency`
  states the real default (all stored history, not 7d); and the dead
  unit-mixing verdict-group `misses` metric (`requests - cachedTokens`) is
  gone from the harness stats, pair stats, and matrix row builders.
- Help and docs state the truth (#101): `forecast --model v2` now honors the
  same insufficient-span rule as v1 — fewer than 2 hours of data in the
  trailing 24h window (with no 7d fallback) reports indeterminate instead of
  projecting a month from 59 minutes of one afternoon (Changed); the
  forecast help and `docs/observability/forecast-v2.md` say that byte-
  identical default-seed runs require pinning `--until`/`--since`, since the
  trailing 30-minute OLS window follows the current time; the `harness
  stats`/`compare`/`matrix` synopses no longer show a `--last 7d` default
  the options text says does not exist; and the `harness recommend` alias
  route now accepts the documented flags (`--last`, `--range`, `--sort`,
  `--top`, `--harness`, `--json`) instead of rejecting them as unknown.
- Battle-probe regression tests (#92): the burst-pagination fixture now also
  asserts id-uniqueness of the 250 ingested rows, a CLI-level test pins the
  stuck-cursor `store sync --json` exit path (`result.ok: false` with
  `error`, visible warning, exit 0), window-boundary coverage extends to
  mid-day instants and exactly-on-boundary upper edges per read surface
  (`usage`, `sessions`, `export`), and the battle report's critical repros
  are pinned deterministically: `--since <today>` matches wire-format rows
  stored by a real sync, and `usage --verify` reports MISMATCH with exit 1
  when rows are deleted from the local store behind the gateway.
- Branch-coverage push to the 85% gate (#91): targeted tests for the branches
  the #85–#89 fixes introduced — the #87 date guard's remaining arms
  (impossible wall-time components, ISO-datetime date-part validation for
  both flags, the sessions window-order check), the fail-open sync warning
  on `harness stats`, the `--include-mixed` excluded-sessions render with
  and without cost columns, and the shared `--last`/`--since`/`--until`
  window parse's edge combination on the harness surfaces.
- Escape and Ctrl-C now navigate instead of killing the CLI from the menu.  Inside an action opened from the main menu — the init agent picker, the
  sign-in org picker, any prompt — Esc or Ctrl-C cancels that action, prints
  the cancel as a dim line, and redraws the main menu; only at the menu
  itself do they leave (Esc quits with a visible `Bye.`, Ctrl-C exits 130).
  Enter with a search filter that matches nothing is a no-op instead of
  quitting. The first-run splash now reads keys in raw mode (any single
  keypress skips it, including Ctrl-C) and always restores the terminal, so
  an interrupt during the splash no longer leaves the alternate-screen buffer
  applied — the stale-frame, blank-screen state that made Esc and Ctrl-C look
  dead on Windows.
- Piping into a consumer that exits early (`aiand models | head`) crashed the
  CLI with an unhandled `EPIPE` stack trace when the downstream closed the
  pipe. The CLI now exits quietly with its resolved exit code, matching Unix
  `SIGPIPE` semantics; a regression test spawns the built CLI, destroys the
  pipe's read end immediately, and asserts a clean exit with no `EPIPE` on
  stderr.

- The first-run splash's version label no longer renders as two separate color
  runs on a colored terminal: `paint()` coalesced only the cells after a run's
  first character, so `v0.6.0` was emitted as `ESC[38;5;246mv ESC[39m0.6.0 ESC[39m`
  and the literal `v0.6.0` never appeared contiguously in the byte stream. Any
  consumer matching the styled output (tests, log capture, screen diff) read a
  split label; a contiguous same-color run is now one opening sequence, the
  run's characters, then one reset.

- `aiand update --yes` is accepted again. The flag was documented in the help
  and read by the command, but never declared in the argument parser, so
  `aiand update --yes` failed with "Unknown option '--yes'" before reaching the
  confirmation or the install child.

- `aiand --json <agent> --session` now reports the session instead of printing
  nothing. The bare open path parsed the global flags from the wrong position,
  so `--json` was dropped and no machine-readable output was produced, while
  the equivalent `<agent> on --session --json` always worked.

- The prebuilt-release install path no longer requires `curl`. It fetched the
  release manifest and tarball with `curl -fsSL`, so on systems without curl
  (Alpine and other minimal images ship busybox `wget`) the install silently
  built from source instead, costing ~30 seconds. It now fetches with
  `node`, which the installer already requires.

- The test suite now runs on Windows. Stub agent binaries were written as
  extensionless `#!/bin/sh` files, which Windows `spawn` cannot execute, so
  every stub-driven test failed with `127` instead of the stub's exit code;
  the stubs are now mirrored as `.cmd` on Windows the way the installer and
  e2e harnesses already did. Permission assertions (`0600`) are POSIX-only and
  now guarded, since NTFS cannot express owner-only bits, and the theme tests
  no longer inherit a host's `COLORTERM` when they assert the xterm-256
  fallback.

- Claude Code sessions no longer silently run on the user's own Anthropic
  subscription when a `CLAUDE_CODE_OAUTH_TOKEN` is exported in the shell: the
  token is now blanked in the wiring `on` writes and deleted from the child
  env of every launcher path, so an aiand session cannot bill a plan the
  command did not route.

- Selecting `key` in the menu no longer fails with "No verb given. Verbs:
  export" — `key` takes a verb, so the menu now runs `aiand key export`.


- `aiand pi on` writes each model's `maxTokens` from the catalog's
  `max_output_tokens` instead of its context window. Pi sends at most
  `min(maxTokens, contextWindow - estimated prompt - 4096)` as
  `max_completion_tokens`. On `deepseek-ai/deepseek-v4.1-flash`, copying
  the window into `maxTokens` made that reservation exceed the window. A
  null cap leaves `maxTokens` out. Run `aiand pi on` again to pick it up.
  (#43, thanks @nekomario28)
- `aiand hermes off` hands a set-aside `model.base_url` back exactly where
  it sat: a line the only field in `model:` no longer leaves the section
  empty, the restored line returns to its own place instead of drifting to
  the section's end above the next top-level key, a dropped line's trailing
  comment comes back once instead of twice, and CRLF files and files
  without a trailing newline round-trip byte-identically. A stale
  `model.base_url` is dropped even when `model.provider` already routes
  through ai&, so a user's own endpoint can no longer ride a second `on`,
  and the line is only recorded (and noted on `off`) when a drop actually
  happened. `yaml-probes.ts` moved out of routing.ts without behavior
  change.

- OpenCode Launcher sessions and Pi pass each model's published reasoning
  levels. Pi's own default is medium, and an unsupported level moves up to
  the next published one. On GLM-5.3 that level is high. The 0.6.0 Pi note
  called an omitted level a gateway default. That name was wrong.
- `aiand <agent> on` proves the session key with one authenticated request
  before writing anything, so a gateway-rejected key refuses with the
  rejected-key advice instead of being baked into agent configs (a blank
  `AIAND_API_KEY` still reads as signed out). A padded `AIAND_API_KEY` or
  stored key now wires trimmed, so the header no longer serializes as
  `"Bearer  sk-…  "`. (#34, thanks @fenilmodi00)
- `aiand <agent> --help` no longer prints an empty "Config files" line for
  adapters that own no config files, and unusable config paths (a file where
  a directory belongs, a directory where a file belongs, unreadable files)
  refuse exit 1 with a hint instead of a raw stack. (#34, thanks @fenilmodi00)
- `aiand harness stats` now counts errors the way `harness matrix` and
  `compare` already do — non-2xx statuses excluding 429 (a rate limit is the
  gateway's pressure, not the pair's quality); null statuses count as
  unknown, not errors. Both surfaces share one error-count helper, so the
  same rows yield the same errorRate everywhere; the stats label says
  `non-2xx excluding 429 / requests`. (#88)

## [0.6.0] - 2026-10-06

### Added

- `aiand pi on` wires the Pi coding agent to ai& through
  `~/.pi/agent/`: an `aiand` provider in `models.json` speaking the gateway's
  OpenAI-compatible dialect with every model from the live catalog, the
  session key in `auth.json` (locked to 0600, marked `managedBy: "aiand"`),
  and `defaultProvider`/`defaultModel` in `settings.json`. `off` removes
  exactly what `on` added — including from the files `on` recorded when the
  Pi config dir was relocated in between, instead of orphaning the key there
  — and restores a `defaultModel` it had to set aside because the gateway
  cannot serve it; one it can serve is kept. Pass `--model native` to leave
  Pi's own default model, scoped to the `aiand` provider so the session
  cannot fall back to another provider's key. Reasoning models run at their
  gateway default effort: Pi's client would otherwise send an effort level
  (`medium`) the catalog does not publish for every model, and the gateway
  rejects it.
  `aiand run-agent pi` launches Pi on ai& for one session with no Pi config
  written under `~/.pi/`: a throwaway overlay becomes `PI_CODING_AGENT_DIR`
  holding the generated provider and the session key (never the child env),
  while session history lands in the same session directory plain `pi` uses
  (the settings.json `sessionDir`, project-level files included, else Pi's
  per-cwd default), so `pi -c`/`-r` see launcher sessions.
  User-supplied `--provider`/`--model`/`--models`/`--api-key` passthrough
  flags are stripped so the routing cannot be overridden; the overlay is
  removed after the session ends.

- `aiand omp on` wires Oh My Pi to ai& through `~/.omp/agent/`: an
  override-only `aiand` provider block in `models.yml` — baseUrl, the
  session key locked to 0600, and the `managedBy: "aiand"` marker; omp
  already bundles the aiand provider, so nothing else is written — and a
  `modelRoles.default` pin in `config.yml`. `off` removes exactly what `on`
  added, stripping the files `on` recorded when the agent dir was relocated
  in between, and reports `stripped: false` when a relocated file is
  unreadable and nothing was stripped yet; a `modelRoles.default` ai&
  cannot serve is set aside and put back on `off`, one it can serve is kept.
  `on`/`off` survive what omp's own writer emits: empty flow containers,
  quoted scalars containing `": "`, YAML-only double-quote escapes, comments,
  and flow-sequence values with quoted commas (`modes: ["a,b", c]`). Pass
  `--model native` to leave omp's own default. `aiand run-agent omp` launches
  Oh My Pi on ai& for one session with no omp config written under `~/.omp/`,
  session history kept in omp's own session dir including its XDG location
  (`$XDG_DATA_HOME/omp/sessions`) after `omp config init-xdg`.
  User-supplied `--model`/`--provider`/`--api-key`/`--models` passthrough
  flags are stripped so the routing cannot be overridden; the overlay is
  removed after the session ends. The install hint downloads the pinned
  v18.4.4 release asset for your platform into `~/.local/bin`, checks it
  against the pinned sha256 digest, and marks it executable, so nothing
  unverified reaches your PATH.

- `aiand copilot on` wires the GitHub Copilot CLI to ai& by BYOK: an `aiand`
  provider row speaking the gateway's OpenAI-compatible dialect, plus one
  model row per catalog model, in `~/.copilot/providers.json` (or
  `$COPILOT_HOME`), and the `aiand/<id>` pin in `~/.copilot/settings.json`
  that a bare `copilot` launch needs. `off` removes exactly those rows and
  hands back the `model` selection it replaced — from the files `on`
  recorded when the Copilot config dir was relocated in between, instead of
  orphaning the key there — and leaves a value you changed in between. A
  servable `aiand/<id>` you picked in the model menu is kept when `--model`
  is not passed, and another model is only set aside with a warning. The
  provider row holds the session key literal and no GitHub sign-in is
  involved. `aiand run-agent copilot` launches the CLI on ai& for one
  session with nothing written under `~/.copilot`: a throwaway dir becomes
  `COPILOT_HOME` holding the generated provider rows and the session model,
  with `COPILOT_OFFLINE=true` so the session never phones GitHub; your
  `--model` passthrough flag is stripped so the pin cannot be overridden,
  and the overlay is removed after the session ends (session history lives
  in the overlay, not in your real `~/.copilot`).

- `aiand copilot-app on` wires the GitHub Copilot desktop app to ai&.
  Config-only: it writes an `aiand-`-prefixed provider row and one model row
  per catalog model into the app's own provider database,
  `~/.copilot/data.db`, which must exist first - open the app once. On
  Linux the hint points at the app's download page with an "open it once"
  note instead of the macOS `brew install --cask` command, which never
  works there. The app keeps GitHub sign-in even for BYOK providers, and you
  pick the ai& model in its model menu. Quit the app before `on` or `off`,
  since it rewrites the database as it exits; `--force` escapes the refusal.
  Only a due write refuses, so an open app never fails a key rotation or
  `aiand login` for people who never ran `copilot-app on`. The app is a GUI,
  so there is no `run-agent copilot-app`. `aiand pi`, `aiand omp` and
  `aiand copilot` open their agent the way `aiand code` does, wiring it
  first when needed; the install offer runs only npm install commands, so pi
  and copilot offer it while omp prints its verified install command.
  Bare `aiand copilot-app` wires the desktop app and says how to open it,
  since aiand cannot launch a GUI app.

### Fixed

- Opening an agent no longer hands an exported AIAND_API_KEY to the agent's
  process tree, matching `run-agent`; Codex still gets the one its
  `aiand key export` child needs.
- `aiand <agent> off` lists several notes separated with `; ` instead of
  spaces, so a run-on line like "...config dir moved stripped the..." reads
  as distinct notes; the `--json` note stays a single string.

## [0.5.0] - 2026-10-05

### Added

- `aiand code` opens OpenCode on ai&, and `aiand opencode`, `aiand claude`
  and `aiand codex` open their agent the same way. Signed out, you are
  offered a sign-in. If the agent is missing, aiand offers to install it with
  its npm install command. An agent not wired yet is turned `on`. The agent
  then runs with your arguments exactly as typed. Codex starts on its ai&
  profile, except for management commands such as `login`, which refuse a
  profile. OpenCode starts on an ai& model even when `opencode.json` names a
  model of your own, which stays in the file; `on --model native` and an
  `OPENCODE_CONFIG_CONTENT` of your own are respected. Without a terminal, a
  missing agent still prints the install command and exits `127`.

### Changed

- `aiand <agent>` with no verb now opens the agent instead of only wiring
  it; `aiand <agent> on` still wires without opening. aiand's own flags go
  before the agent name (`aiand --profile work claude`), everything after it
  goes to the agent, and `--` passes a verb through (`aiand opencode -- status`).
  A leading `--profile` or `--base-url` wires the agent again to that target.

### Fixed

- An agent started after a sign-in prompt, by `aiand <agent>` or
  `aiand run-agent`, gets every keystroke, and aiand exits when the agent
  does. Before, aiand kept reading the terminal and took some of the input.
- Ctrl-C at a yes/no prompt cancels with exit `130` instead of reporting an
  unexpected error.
- README logo: the red stroke of the prompt no longer sticks out past the
  dark stroke where the two meet.

## [0.4.0] - 2026-09-29

### Added

- `aiand claude on` lists every ai& model in Claude Code's `/model` picker,
  through its `modelPicker` setting: Claude Code only discovers gateway models
  whose id contains "claude", so ai&'s never appeared there. The built-in
  Opus, Sonnet and Haiku rows are replaced, since they would run ai&'s models
  under Anthropic names. A `modelPicker` of your own is kept, and `off`
  removes only the one `on` wrote. `aiand run-agent claude` lists them too.
- `aiand codex on` writes an ai& profile for Codex, `~/.codex/aiand.config.toml`
  (or `$CODEX_HOME`), and leaves `config.toml` alone: start Codex on ai& with
  `codex --profile aiand`. The profile holds no key; Codex runs
  `aiand key export` for your active aiand profile, so a rotation or
  `aiand config use` needs no rewrite. It pins a reasoning level the model publishes, for Plan Mode too,
  and turns off Codex's hosted tools. Only ai&'s own keys are written and
  removed, so settings you add to the profile survive. `aiand run-agent codex`
  launches Codex on ai& with nothing written.

## [0.3.0] - 2026-09-28

### Added

- `aiand claude on` wires Claude Code to ai& through `~/.claude/settings.json`
  (or `$CLAUDE_CONFIG_DIR`); `off` removes exactly what `on` added, and
  `aiand run-agent claude` launches Claude Code on ai& with nothing written.
  Every model slot is filled from the live catalog: a vision model for the
  main slots unless your profile names one, and a fast model for background
  work. `--model` switches the main slots. A `model` setting or
  `env.ANTHROPIC_MODEL` ai& cannot serve is set aside and put back on `off`;
  one it can serve is kept. The Bedrock, Vertex and Foundry switches are
  written as `0`, so one left on elsewhere cannot route Claude Code away from
  ai&. Claude Code's context budget is capped at 200k tokens, so long sessions
  compact before open models start to degrade, including for a model id
  tagged `[1m]`.
  Claude Code's attribution header is turned off, since ai& would otherwise
  pass it to the model as prompt text. WebSearch is denied, since it relies on
  Anthropic's servers; WebFetch keeps working.
- README logo (`docs/assets/aiand-cli-logo.svg`).

### Changed

- README opening rewritten: it leads with "Less setup. More building." and
  three reasons to use the CLI (browser sign-in, OpenCode setup that keeps
  your providers and model, models with prices in your billing currency).
- README quick start moved to the top and now ends in a working agent:
  `aiand login`, `aiand opencode on`, `opencode`. A one-line
  `git diff | aiand run` example follows for quick prompts.
- README install section is shorter, and now says exactly what
  `AIAND_NO_MODIFY_PATH=1` does: it skips permanent PATH changes but still
  puts `aiand` on the installer's own PATH.

## [0.2.0] - 2026-09-24

### Added

- `aiand opencode on` wires OpenCode to ai& permanently; `off` removes exactly
  what `on` added.
- `aiand run-agent opencode` runs OpenCode on ai& for one session, with
  nothing written to your config.
- `aiand login` signs in through your browser; `--paste` and `--with-token`
  accept a key from the console.
- `aiand status` shows sign-in, key storage, and every agent's wiring at once.
- Agent setup details: `on` adds an `aiand` provider to
  `~/.config/opencode/opencode.json` with model entries from the live catalog.
  Your other providers, your own edits, and a model you already set are left
  alone; pass `--model` to switch, or `--model native` to keep the agent's own
  default. `aiand opencode status` reports routing from the real config
  files. JSONC configs (comments, trailing commas) and symlinked dotfiles are
  supported.
- `aiand restore <agent> --force`: break-glass, byte-for-byte restore of the
  config snapshot taken before aiand's first write, under
  `~/.config/aiand/snapshots/`. Plain `off` never replays it.
- `run-agent` passes the agent's exit status through and takes
  `--model <id>` and `-- <args…>`.
- `aiand init` detects installed agents and wires the ones you pick
  (`--all`, `--off`, `--profile`, or an arrow-key checkbox). It never installs
  an agent; missing ones get their official install command.
- `aiand status` exits 0 when signed in or when the gateway is unreachable
  (`reachable: false` in `--json`), and 1 only when signed out, so scripts
  gating on it do not fail during an outage.
- Browser sign-in uses authorization code + PKCE with the redirect caught on
  a loopback port. It falls back to device login when the gateway has no
  browser flow or the browser flow fails, and an interactive device login
  that cannot reach the service offers key paste. Multi-org accounts pick
  their organization with an arrow-key prompt, and minted keys are labeled
  `aiand@<hostname>`.
- A pasted key is validated before it is stored and never revoked by
  `aiand logout`, since this CLI did not mint it.
- `aiand key export` prints the active session key raw, for piping into other
  tools.
- Tiered secret storage: the OS keychain when usable, otherwise an AES-256-GCM
  encrypted file under the config directory, and a plaintext file only with
  `AIAND_KEY_STORAGE=plaintext`. `credentials.json` now holds metadata only;
  existing credentials migrate automatically.
- Signing in again, switching with `aiand config use`, or the automatic
  30-day key rotation swaps the new key into the agent configs aiand wired,
  so nothing needs a re-run of `on`.
- Model defaults resolve from the live catalog, so a retired model id is never
  written into agent config. `aiand models` gains a vision column.
- A once-a-day update notice on interactive terminals when npm has a newer
  release, and a few "what's new" lines after an upgrade. Disable with
  `AIAND_UPDATE_CHECK=0` or `NO_UPDATE_CHECK=1`; it never runs under `CI`.
- `AIAND_NO_BROWSER=1` never opens a browser; sign-in prints the URL instead.
- A mistyped flag suggests the nearest one (`Did you mean --profile?`).
- One-line installers: `install.sh` (macOS, Linux) and `install.ps1`
  (Windows, including a Git Bash shim). Re-run to update. `uninstall` turns
  every aiand-routed agent off first, aborts without deleting anything if that
  fails, and keeps profiles, credentials, and snapshots.

### Changed

- `aiand login` opens the browser by default instead of starting with a
  device code.
- `aiand logout` asks before revoking a device-minted key on a terminal
  (`--revoke` / `--keep-remote` skip the question), and strips the key from
  agent configs aiand wired.
- `aiand whoami` reports where the key came from (device login, pasted key,
  or `AIAND_API_KEY`) and which storage tier holds it.
- `aiand login` with `AIAND_API_KEY` set notes that the env key wins and exits
  without storing anything.
- Exit code `127` also covers a missing agent binary, printed with its install
  command.
- The banner is the `ai&` wordmark.

### Removed

- `aiand login --no-browser`, along with SSH/WSL browser detection. The CLI
  tries the platform opener and prints the URL when there is none; set
  `AIAND_NO_BROWSER=1` to skip the browser entirely.

### Fixed

- Device login requests sent an empty body.
- Piped stdin from sockets (Node child processes) and Windows pipes was
  silently ignored, dropping `run` context.
- A `200` HTML response from the gateway on `run` or `chat` is reported as a
  gateway error instead of a parse failure.
- `aiand logs` against a gateway without request logs says so and points at
  `aiand usage`, instead of a bare HTTP 404.
- Profile names such as `__proto__` are rejected instead of silently dropping
  credential metadata.

## [0.1.2] - 2026-09-07

### Fixed

- Table columns no longer go ragged when a cell contains a wide character.
  Column padding measured JavaScript string length, but a CJK glyph occupies two
  terminal columns and an emoji ZWJ sequence is several code points in one glyph,
  so an organization or model name outside ASCII shifted every column after it.
  Width is now measured in terminal columns over grapheme clusters.
- `aiand --version` reads the version from the package manifest instead of a
  constant that could drift from what was published.

### Added

- A test suite on the built output, using the Node test runner. Covers column
  alignment across scripts, the Server-Sent Events reader (split frames, CRLF,
  keep-alives, malformed frames), the answerless-response diagnosis,
  configuration precedence, and credential file permissions.

## [0.1.1] - 2026-09-07

Initial public release of the ai& command line interface.

### Added

- `aiand login` / `logout` — browser-approved sign-in over the OAuth 2.0 device
  authorization grant (RFC 8628). Approval mints an organization-scoped API key for the
  machine, stored at `~/.config/aiand/credentials.json` with mode `0600`, rotated
  automatically before it lapses and revoked server-side on logout.
- `aiand whoami` — signed-in identity, organization, and key expiry.
- `aiand run` — one prompt, streamed to stdout, with piped stdin appended as context.
  Reports the resolved model, token counts, cost, and request ID from the response
  headers rather than the body.
- `aiand chat` — interactive conversation with an in-session transcript, `/model`,
  `/system`, `/clear`, and `/tokens`.
- `aiand models` — the model catalog priced in the organization's billing currency,
  filterable by capability and sortable by price or context window.
- `aiand logs` — recent inference requests with keyset pagination, an `--errors` filter,
  and `--follow` to tail new traffic.
- `aiand usage` — requests and tokens for a window against the one before it, plus the
  full metric breakdown under `--metrics`.
- `aiand orgs` — organizations the signed-in user belongs to.
- `aiand config` — profiles and defaults. Separate profiles hold separate credentials, so
  more than one organization can be signed in at once.
- `--json` on every command, plus `--profile` and `--base-url` globally.
- `AIAND_API_KEY` support for CI, which bypasses the device login and writes nothing to
  disk.
- An explanation whenever a `200` carries no answer, on both the streaming and
  non-streaming paths, so a reasoning model that exhausts `max_tokens` before writing
  anything says so instead of printing a blank line.

### Implementation Notes

- No runtime dependencies. Argument parsing uses `node:util` `parseArgs` and requests use
  the built-in `fetch`.
- Requires Node 22 or newer.
- Answers go to stdout and everything else to stderr, so `aiand run … > out.md` captures
  only the model's output.
- Streaming reads Server-Sent Events directly; the API includes usage in the final chunk.
- Cost and timing headers are requested with `X-Aiand-Metrics: true` and are returned on
  non-streaming responses only.
- Apache License 2.0, matching the ai& SDKs.
