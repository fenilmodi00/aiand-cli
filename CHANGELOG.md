# Changelog

All notable changes to this project will be documented in this file.

Versioning follows semver, with the caveat that before `1.0` a minor version may include
breaking changes while the command surface settles.

## [Unreleased]

### Added

- `aiand overview --share`: renders the overview as a Mac-terminal-style
  SVG/PNG (inline ai& logo in the terminal body), rasterizes it at 2x via
  OS-native tools, and copies the PNG to the clipboard — with save-and-print
  fallback when no rasterizer/clipboard tool is available. Zero new
  dependencies.
- Cache and leaderboards now show throughput next to hit rate and cost, so
  the 98% vs 85% gap pairs with how fast each harness+model is. All three
  reuse the same throughput-weighted avg TPS
  (`sum(output_tokens)/sum(latency_ms − ttft_ms)*1000`, eligible rows only;
  ineligible stays `—` / `null`, never 0).
  - `aiand cache`: `avg tok/s` in the totals header and a `tok/s` column in
    the By agent/model/key table, plus `avgTps` per group in `--json`
    (`estimated(sum(output_tokens)/sum(latency_ms − ttft_ms)*1000 over eligible rows)`).
  - `aiand harness stats` / `aiand harness compare`: `avg tok/s` column
    (informational, never a verdict input), and the value now ships in
    `--json` and the markdown/csv `--out` export.
  - `aiand compare table`: `tok/s` column (`CompareRunRow.tps` → `CellStats.avgTps`,
    mean over eligible trials; `—` when none), preserved in `compare table --out`
    markdown/csv and in `--json` (`cells[].avgTps`).
- Throughput (tokens/s) is now surfaced across the observability commands,
  derived at render time from the store's existing `ttft_ms`/`latency_ms`/
  `output_tokens` columns — no migration, no new dependency. Two labelled
  definitions: per-request TPS (`output_tokens / ((latency_ms − ttft_ms)/1000)`,
  `-` when unavailable) and avg TPS (system throughput:
  `sum(output_tokens) / sum(latency_ms − ttft_ms) * 1000`).
  - `aiand logs`: `tok/s` column and `tps` in `--json`.
  - `aiand sessions`: `tps` (median per-request) and `avgTps` columns,
    session JSON, and the drill-down per-request view.
  - `aiand dashboard`: `tps` line in the Totals panel and a per-harness
    `tps` column in the compare view (informational only — it never feeds
    the harness scorecard verdicts).
  - `aiand usage`: `avgOutputTokensPerSecond` in the `--json` summary and an
    `avg tok/s` footer line.
  - `aiand export`: OTel histogram `gen_ai.server.output_tokens_per_second`
    (unit `{token}/s`, explicit bucket family mirroring `time_to_first_token`'s
    shape), in Prometheus and OTLP JSON, emitted only where TPS samples exist.
  - `aiand overview`: Top models gains labeled `avg tok/s` and `p95 tok/s`
    columns (throughput-weighted system rate and the 95th-percentile
    per-request rate), computed only over decode windows ≥200 ms so
    millisecond timer noise can't fabricate six-figure rates; ineligible
    models render `-` and `null`, never 0.
- `aiand compare` (lane B, #129/#131/#132/#134): replay your own tasks across
  harnesses and models. `compare add` scaffolds a task pack
  (`instruction.md` + `workspace/` + `verify.sh`) with verifier discipline —
  verify must FAIL on the untouched workspace (the built-in null-harness
  control, scoring 0) and PASS after a `--golden` solution replay; `compare
  validate` enforces both loudly — a task is validated only when the golden
  replay passed too (without `--golden` the verdict is golden-missing, never
  valid, and `compare run` refuses it). `compare run` drives each harness
  headless (claude/codex/opencode; adapters that cannot run headless fail
  loudly), pins one model across harnesses, meters cost+tokens from gateway
  rows (masked-key + time-window join; missing usage is `null`, never 0),
  and classifies failures (agent/verify timeout, parse_error,
  context_exceeded, integrity_violation via verify-script hashing, infra —
  reported separately, never folded into solve rate). `--dry-run` replays
  the recorded simulated lane with zero gateway spend; its rows go to
  `compare-runs/<task>.recorded.jsonl`, kept apart from live rows.
  `compare table` aggregates per (harness,
  model): solve x/n with Wilson 95% CI, cost/solve, wall, turns/solve,
  retry rate, and the failure histogram; recorded (simulated) rows are
  excluded and reported on a separate line, never ranked with your workload;
  overlapping CIs say "tied — not
  distinguishable yet" instead of crowning a winner, cells under 3 trials
  are flagged, and every rate carries `n=`. `compare audit` applies a fixed
  deterministic rubric (integrity — the verify-hash verdict `compare run`
  recorded per row, suspicious-success median
  heuristic, instruction sufficiency) — advisory only, never part of solve
  rate or rankings.
- Envelope capture v2 (#126): envelopes now record per-tool-call outcomes
  (`toolOutcomes`, names + ok only — error text is never captured) and the
  turn's terminal state (`terminal: clean|aborted|errored`). Store schema v7
  carries both columns; old v1 rows still parse and read back with the
  fields absent (unknown, never counted as ok or error).
- Efficiency walk v2 (#127): tool-error rate, missed-catch rate (a shell
  error → re-edit of a previously edited file → the same check failing
  again — deterministic rule, layered onto the one-shot/retry walk),
  turns-to-success, and the clean/aborted/errored session split, all labeled
  `heuristic(...)` with coverage notes; turns without outcome data yield
  `null`, never zeros.
- `aiand harness import` (#133): opt-in backfill of behavioral markers from
  the harnesses' own session files (Claude Code JSONL `is_error`/`stop_reason`,
  Codex turn/compaction markers, OpenCode SQLite tool-state + compaction
  parts) for sessions predating envelope capture — markers only, never
  content; re-imports are idempotent by structural dedup key (store
  schema v8), and derived rates stay `heuristic`-labeled.
- `harness compare --out <file>` table export (#135): writes the compare
  table to a file as markdown, csv, or json (`--format`, default inferred
  from the extension). Exports preserve everything the terminal table
  carries — per-column winners (`▸`), `n=` counts, uncovered-cell em-dashes,
  the coverage line, and the cohort/provenance footers; the synthetic sweep
  block stays display-only and never joins an export.
- Cohort seam end-to-end (C6, #135): `--cohort <category>` now also narrows
  `harness matrix` and `recommend` through the same classifier predicate as
  `harness stats|compare` — one shared flag parser, identical
  excluded-not-folded semantics and error text on every surface.
- `compare cohorts` (lane B, #135): per-category task breakdown. Task packs
  gain optional `tags:` (classifier categories, via `compare add --tags` or
  a hand-edited `task.json`); when `compare run` rows exist
  (`compare-runs/<task>.jsonl`) the breakdown rolls up solves (infra rows
  excluded), cost, and mean wall-clock per task; without run rows it
  degrades honestly (tags only, stated in text and `--json`).
- Scripted tool outcomes in the recorded benchmark (#128): scenarios can
  pin per-call results (`scriptedOutcomes`, reusing the `call_N` ids), the
  offline replay turns them into per-turn `toolErrors` and `retries`
  (error followed by a repeat) and per-row totals, and a new
  `tool-error-retry` scenario exercises the error → retry → success chain.
  The goldens pin the new fields; every behavioral number is labeled
  `simulated(scripted tool outcomes)` via the new fourth provenance tier
  and never joins observed rankings — the live gateway path is unchanged.
- `harness compare` behavioral columns (#130): per-harness tool-error rate,
  one-shot/retry rate, missed-catch rate, turns-to-success, and the clean/
  aborted/errored outcome split — sourced from locally captured adapter
  envelopes (v2 outcome fields) via the same walk as `aiand efficiency`.
  Every rate carries `n=`; envelope-derived numbers are labeled
  `heuristic(one-shot/retry envelope rule)`. Columns render only when
  envelope data covers a harness; uncovered cells show `—` (never zeros) and
  the table prints an honest coverage line (`behavioral columns: envelopes
  N% of turns, uncovered → —`). Per-column winners (`▸`) extend to the
  behavioral metrics — only covered cells compete.
- `recommend` ranks on the behavioral columns when coverage exists
  (`--sort tool-err|one-shot`; uncovered pairs sink, as unpriced rows do)
  and states its basis — `ranking basis: behavioral+request` or
  `request-only` — in text and `--json` (`provenance.rankedOn`).
- `harness stats|compare --cohort <category>` (C6): narrows the rows to one
  deterministic classifier category (Coding, Debugging, …) before
  sessionization; non-matching requests are excluded AND counted
  ("excluded, not folded"), never silently dropped.
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
  profile's `[model_providers.aiand]` as `http_headers`; Hermes adds
  `extra_headers` to the generated `providers.aiand` block, in persistent
  wiring and launcher sessions alike.
- Imported session files now power reporting: `harness import` markers fill
  `harness stats`, `harness compare`, and `efficiency` behavioral cells when
  captured envelopes are absent or below the 5-turn gate. The source is
  labeled per harness (`envelope` / `imported`), coverage is printed next to
  every rate, and the two sources are never summed.
- `harness compare` and the dashboard show 95% intervals — Wilson for rates,
  seeded percentile bootstrap for cost and latency — and mark `▸` only when
  the leader's interval is disjoint from every rival; `recommend` gates its
  wiring hint the same way (no wiring line when tied) and prints projected
  monthly savings (`--sessions-per-month`, default 200) only when the
  interval is decisive and excludes zero.
- `harness compare --baseline <previous|30m|12h|1d|7d|30d|4w>` screens the
  preceding window of the same length against the current one (no saved
  state); the `doctor` line reports regressions over the last 7 days.
- `aiand export` emits per-harness scorecard gauges (cost/session, TTFT p95,
  cache hit, error/clean/tool-error rates, behavioral coverage), store sync
  lag, and Prometheus `# HELP` lines for every metric; uncovered gauges are
  omitted rather than fabricated as zero.
- Claude Code and Codex local usage readers refine `shared` gateway rows to
  their harness when the model and usage match uniquely, without changing
  the ambiguity rules.
- `aiand compare table --k <n>` reports task-clustered bootstrap intervals
  and pass@k and pass^k for runs of the same task.
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
- `--fast-model <id>` for `aiand claude on`, `aiand claude` and
  `aiand run-agent claude`: a separate model for Claude Code's background
  calls and auto mode's safety checks. Without it, they use `--model`.
- `aiand claude status` lists every model Claude Code can send requests to
  (each slot and the auto-mode safety checks) and warns about any slot that
  holds a model other than the one you chose.
- Both installers finish with an agent summary: which coding-agent binaries
  are on `PATH`, the install hint for each one that is missing, and a nudge
  to run `aiand init`. The hint is that adapter's own install command for
  this machine (Jouzu included). The Copilot desktop app is left out; it is
  not a PATH binary. The installer still never wires agents itself.

### Changed

- `aiand overview`: the per-day table separates requests, tokens, cost, and
  savings with explicit spaces, so large counts cannot merge into one number.
- Terminal output shows the bare model name (`glm-5.3`) instead of the
  org-qualified id (`zai-org/glm-5.3`), so model columns no longer inflate
  every table. Applies to `models`, `logs`, `sessions`, `status`, `agent`,
  `chat`/`run`, `dashboard`, `overview`, `wrapped`, `usage`, `harness`,
  `compare`, `efficiency`, and the Claude picker. Full ids are unchanged in
  `--json`, config writes, filters, and the `recommend` apply command.
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
- After an upgrade, aiand prints one link to the release notes instead of four full changelog bullets.
- `/model` rows in Claude Code show each model's published context window
  (`ai& · 1M context`) instead of the 200K cap.
- The CLI now sends its requests through `HTTPS_PROXY`/`HTTP_PROXY` and trusts
  the system certificate store. It requires Node 22.21 or later.
- Signing in again revokes the key the old sign-in created. `aiand login
  --force`, or yes to "Sign in again and replace it?", used to leave that key
  valid with nothing on the machine able to revoke it. The revoke runs after
  the new sign-in is stored and goes to where the old key was issued, so a
  failed or cancelled sign-in keeps the old one. `--keep-remote` keeps the old
  key valid. A pasted key is never revoked.
- `aiand claude` and `aiand claude on` point Claude Code's auto-mode safety
  checks at the fast model (`CLAUDE_CODE_AUTO_MODE_MODEL`) instead of the main
  one. Each check sends about 30,000 input tokens, and on the main model the
  checks cost 1.9 to 7 times the coding work in our tests. They also set
  `CLAUDE_CODE_AUTO_MODE_SERVER=0`, so Claude Code runs the checks itself
  rather than asking ai& for server-side checks it cannot provide; this keeps
  auto mode working when Claude Code removes its fallback for them.
- The README and the npm page link the CLI guide at
  [docs.aiand.com/cli](https://docs.aiand.com/cli/), not the docs home page.
- A source-build `npm ci` passes `--prefer-offline`, so a re-run reuses the
  npm cache and still downloads anything the cache does not have.
- `install.sh` reads the first `"version"` key in package.json without
  spawning node, so a later `"version"` on the same line cannot win.
- `install.ps1` runs the `aiand` launcher, and `aiand.cmd` only when
  `OS` is `Windows_NT`, so the version check and the login offer work under
  PowerShell on Linux.

- Comparisons at small n no longer crown a point-estimate winner: when 95%
  intervals overlap the footer says `tied — not distinguishable yet (…)`,
  and `recommend` withholds the monthly-savings claim.
- The interactive menu no longer flattens all 31 commands into one
  undifferentiated section: rows are grouped by activity — Ask & run, Spend &
  reports, Harness & compare, Setup & health, Account — between the agent
  sections and Quit, with search still matching group names, command names,
  and aliases. Pure metadata: no command module loads at menu draw.
- Flag-only commands (the whole read-only report/diagnostics surface:
  `usage`, `sessions`, `overview`, `report`, `wrapped`, `efficiency`,
  `cache`, `logs`, `heatmap`, `dashboard`, `forecast`, `recommend`,
  `status`, `doctor`, `whoami`, `orgs`, `models`, `login`, `logout`,
  `update`, and the harness stats/compare/matrix/import subcommands) now
  reject a stray positional word as a usage error instead of silently
  ignoring it. `aiand harness bogus` used to swallow the word and start a
  multi-minute benchmark.
- A typo in `aiand harness --scenario <id>` or `--harness <id>` now reports
  as a usage error with the known ids and a "Did you mean …?" suggestion,
  instead of the "please report this bug" banner with a stack trace and exit
  code 70. Same for a non-positive `report --top`.
- An unknown help topic now gets the same nearest-match suggestion as an
  unknown command: `aiand help usgae` points at `aiand help usage`.
- Pressing Enter on an empty required prompt (the pasted-key sign-in flow)
  is now a usage error naming the `AIAND_API_KEY` alternative, instead of
  exiting with the not-signed-in code — a CI script can no longer mistake
  "you typed nothing" for "logged out". The non-TTY end-of-input message
  names the env key too.
- The `compare` summary no longer advertises verbs the dispatcher rejects:
  it now reads "add tasks, list, validate".

### Fixed

- Jouzu requests now carry `x-aiand-agent: jouzu` and attribute to Jouzu
  instead of pi; restoring an agent also drops its key attribution map.
- A successful OS-keychain write removes a superseded encrypted-file copy, so
  `aiand key export` can never fall back to an older key; `logout` reports a
  keychain delete that provably left the secret in place.
- A provider-qualified model in an agent's own args now resolves under a
  renamed side-by-side install (`aiand-v2/<id>`), not only `aiand/<id>`.
- Table output keeps its palette on cli-v2's status and verdict cells
  (`usage --verify`, `cache`, `forecast`, `harness`, `harness stats`,
  `harness matrix`, `status`) instead of stripping their color.
- Device sign-in and token refresh now reject incomplete token responses instead of saving
  unusable or irrevocable credentials.
- The file-based key store refuses to create its key inside a git work tree, including
  when the first access is a read, unless `AIAND_ALLOW_GIT_TRACKED=1` is set.
- `--json` output escapes DEL, C1, Unicode line separators, bidi controls, and tag
  characters, so a value from the store cannot drive the terminal.
- Claude Code's generated settings deny reading the routed settings file and running
  `aiand key export`, so a prompt or hook cannot print the key.
- Sign-out waits for an in-flight token refresh before revoking or clearing the
  credential, so a rotation cannot overwrite the sign-out.
- Bare `aiand copilot --model <id>` and `--model=<id>` launches now validate the
  requested id against the catalog and refuse to spawn when GitHub Copilot is
  already configured for a different model, instead of overriding that model
  unchecked. The error points to `aiand copilot on --model <id>`; a matching
  model still opens with the original arguments.
- `--model <id>` now puts every model slot of Claude Code on that model:
  Opus, Sonnet, Fable, subagent, and the fast `haiku` slot that session
  titles and other background calls use. Before, `aiand claude on --model`
  left the fast slot on `deepseek-ai/deepseek-v4.1-flash-1017`, and
  `aiand claude --model <id>` (one session) left every slot but the startup
  model on `moonshotai/kimi-k3`, so auto mode's safety checks went there.
  A model set with `aiand config set model` counts as a choice too, and a
  later `on` follows a new one. `aiand claude` sessions keep a model given
  to `on --model`. `on` also writes `CLAUDE_CODE_AUTO_MODE_MODEL` (the
  safety checks' model, Claude Code 2.1.302+) to the chosen model, so one
  exported in the shell cannot send the checks elsewhere. A re-run of
  `aiand claude on` moves a fast slot that 0.8.0 left behind.
- `aiand claude --model <id>` and `aiand run-agent <agent> -- --model <id>`
  run the session on that model. Before, Copilot, Pi, omp and Hermes dropped
  a `--model` given after `--` and started on the default model, and Claude
  Code got the flag while its other slots stayed on the default. A model ai&
  does not serve is now refused instead of replaced.
- `aiand <agent> --model <id>` on an agent that is not set up yet sets it up
  on that model, not on the default, so a later plain launch stays on it.
- OpenCode: `aiand opencode on` and one-session launches set `small_model`
  to the chosen model, so titles and summaries stay on it instead of a model
  OpenCode picks; `off` hands back a `small_model` of your own. A `--model`
  or `-m` in `aiand opencode`'s arguments is no longer overridden.
- Claude Code sessions started through aiand get the startup model's full
  `context_window` from the ai& catalog, including 1M and larger windows,
  instead of a shared 200K cap, so they no longer compact at 200K on a model
  that holds more. The budget follows the model the session starts on: the
  `--model` choice that every slot now uses, a kept `model` setting, or an
  alias such as `aiand claude --model haiku`. A `--fast-model` does not
  shrink it. Claude Code keeps one budget per process, so a `/model` switch
  inside a session keeps the startup model's; start a new session with
  `aiand claude --model <id>` to change it. `off` puts back a value of your
  own.
- The installer's post-install check and login offer address the launcher by
  its install name: a side-by-side preview install (`aiand-v2`) exited 1 after
  successfully installing because `install.sh` verified a hardcoded `aiand`
  launcher that did not exist.
- `aiand dashboard` no longer hangs for seconds at launch and on every
  period/scope keypress: the local-usage correlation pass re-parsed every
  omp/pi session file (hundreds of MB on a real history) synchronously on
  each refresh whenever any gateway row was still unresolved. The TUI now
  paints immediately, runs that pass once in the background (batched, so
  keys stay live), and folds the refined harness labels in when it lands;
  unchanged session files are cached by mtime and never re-parsed.
- `aiand dashboard`/`overview` no longer render shared harness rows as 100%
  when the store has already refined them: the correlation pass returns
  refinement labels only, so a persisted `attributed_agent` is never
  overwritten with the weaker base label while other rows stay pending.
- Subagent traffic now correlates: pi-mono session `model_usage` side-lines
  (provider/model/usage/timestamp at the top level, no `message` key) are
  parsed as local usage records for aiand, refining the gateway rows that
  previously stayed NULL forever.
- `aiand omp` no longer reports `off` and can no longer re-bake a stale key
  when the user's `models.yml` contains the flow mappings omp itself writes
  (e.g. a provider's `cost: {input: 0, output: 0, …}` map): the omp YAML
  reader rejected flow mappings, so `aiand omp status`/`probe`/`bakedKey`
  silently failed and `aiand omp on` / key rotation could not swap a
  deactivated key into the wired provider block. Flow mappings now parse; run
  `aiand omp on --force` (or `aiand login` to trigger a rotation) to refresh a
  stale `api_key has been deactivated` key into the active session key.
- Dashboard attribution no longer seals a stale key-map label: a unique
  local-usage match now overrides the key holders ∩ wire-dialect label on
  specific-base rows, so traffic misattributed when a harness's data lived
  outside the swept homes (e.g. omp in WSL, invisible to the key sweep, left
  the map with no `omp` entry) heals on the next correlation pass instead of
  staying wrong until `store reset`. Rows with no matching local record
  still settle to their base label, and `correlationsPending` still reaches
  false (materialized sessions re-bake once, rules version 3 → 4).
- `aiand dashboard`/`overview`/`sessions` no longer label an omp-only session
  `shared` because an auxiliary request in it never reached the harness's
  local usage log: omp's auto-title generation (gateway-logged as a 499 when
  the client tears the stream down) and idle recap turn are ephemeral turns
  that write no session JSONL, so those gateway rows had no local record to
  match. A row with no local evidence now inherits its time-gap session's sole
  evidence-backed harness when a same-dialect sibling carries one; the request
  row itself keeps its honest NULL, so late local evidence still heals it.
  Sessions with two genuinely different harnesses still report `shared`
  (sessionization rules version 4 → 5).
- Harness attribution now uses the gateway's per-request `endpoint` (the wire
  dialect: `/v1/messages`, `/v1/responses`, `/v1/chat/completions`), so
  Claude Code and Codex traffic on a key shared with other agents is
  attributed precisely instead of collapsing to `shared`. Same-dialect
  agents sharing one key (e.g. omp and pi) still honestly share, and rows
  synced before this change keep the old label until re-served.
- Harness attribution heals late local evidence: the correlation pass used to
  attempt each request row exactly once, and the attempt cursor then sealed
  any row it could not resolve. Agents buffer their session files, so a
  request whose local usage record landed on disk seconds after the pass ran
  (a live store showed 1,174 such rows attributed to `shared` while every
  one had a matching omp record) stayed wrong forever — re-syncing or
  resetting the store did not help, the same race re-sealed new rows.
  Unresolved rows are now re-attempted on every pass and healed as soon as
  their record appears; the cursor bounds per-pass work, not a row's
  lifetime.
- `correlationsPending` can actually reach false now: it counted every row
  with a NULL `attributed_agent`, but rows resolved to a specific base
  label (claude, codex, …) never get a local record and so kept the gate
  open forever — every report build re-parsed all agent session files for
  no new information. A row now settles into the column the moment it
  resolves (unique local match or specific base label); only genuinely
  unresolved rows keep counting, so the heal-on-late-evidence path is
  unchanged and the sessions fingerprint re-bakes on settle.
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

### Removed

- The adapter-side envelope capture API (`src/agents/envelope-capture.ts`,
  `createEnvelopeRecorder`, `ENVELOPE_CAPTURE_CONFIG_KEY`, the
  `envelopeCapture` config.json flag, and the `AIAND_ENVELOPE_CAPTURE` env
  toggle). It was never wired into any adapter, so no behavior changes; the
  envelope schema (`aiand-envelope/v1`), the `envelopes` store table, and the
  efficiency reports built on them are unchanged.
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
- The adapter-envelope gateway-echo scaffolding: the `x-aiand-envelope` header
  constant and its serializer from `src/agents/envelope.ts`. Nothing sent the
  header and nothing read it back — the gateway does not forward or echo
  envelopes (gateway ask #2 remains open in ticket #80). Locally captured
  envelopes (the store table and the `efficiency` reports
  built on them) are the only envelope path and are unchanged.
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

## [0.8.0] - 2026-11-20

### Added

- Windows now keeps your key in an OS-backed store: Windows DPAPI, through
  the Windows PowerShell that ships with Windows. The key is encrypted for
  your Windows account, so another account on the machine, or a copy of the
  file taken elsewhere, cannot decrypt it. `aiand status` shows
  `storage  Windows DPAPI`. A key you signed in with before moves into DPAPI
  the next time the CLI reads it, and the encrypted-file copy is removed.
  Where PowerShell cannot reach DPAPI (Constrained Language Mode on a
  locked-down machine, or PowerShell missing), the key stays in the
  encrypted file as before, and `aiand status` says why in one line.
  `AIAND_KEY_STORAGE=dpapi` pins it; `AIAND_KEY_STORAGE=file` keeps the old
  behaviour.
- `aiand logout --all` hands a shared or loaner machine back. It revokes every
  key `login` created (best-effort, one profile at a time), removes ai& from
  every coding agent whichever profile wired it and checks no key is left in
  their configs, deletes session files a crashed `aiand run-agent` left in the
  temp directory, deletes every stored key (OS keychain included) and
  `~/.config/aiand` with its snapshots. It asks first, or takes `--force` off
  a terminal; `--keep-remote` skips revoking; `--json` reports each step.
  A profile whose key it could not revoke keeps its sign-in (its refresh
  token is the only thing that can revoke the key), and so does the config
  directory; run it again later, or add `--keep-remote` to forget the key
  here and revoke it in the console. Pasted keys, which the CLI cannot
  revoke, are listed with the console page that can. It exits 1 after listing anything it could not remove, and only
  deletes a config directory inside your home directory unless
  `AIAND_WIPE_OUTSIDE_HOME=1`. It also refuses a directory that does not
  prove it is aiand's: aiand writes a `.aiand-config` marker file into its
  config directory on its first write there, only while the directory is new,
  empty or holds nothing but aiand's own files, and the marker carries a
  random id that `config.json` records too (an older install passes while its
  `config.json` has aiand's `profile` and `profiles`). An empty marker, or one
  copied from another install, vouches for nothing, so an `AIAND_CONFIG_DIR`
  pointed at `~/.docker` or a project folder is left whole, even after a cache
  write into it. Sign-in files (`credentials.json`, `secret-store.*`) need
  that `config.json` beside them: the marker alone vouches only for caches,
  so a directory holding another tool's `credentials.json` and no
  `config.json` is refused, and says so. If those files are aiand's (a
  sign-in interrupted before `config.json` was written), it says to run
  `aiand logout --profile <name>` there first, which revokes each key where
  it was issued, since a new `aiand login` would replace the sign-in without
  revoking it. Where there is no such `config.json`, or one whose id does not
  match the marker's, a sign-in that records no issuer is sent nowhere:
  `aiand logout` keeps it and points to the console and `--keep-remote`, and
  its first use, `aiand config set` and `aiand config use` neither pin nor
  bake it. aiand never rewrites a marker that names an id, so a later command
  cannot make a mismatched pair agree; the refusal says to delete the marker
  before signing in again. A `locks` or `snapshots` folder
  keeps whatever aiand did not put in it. The directory is checked again
  right before anything is deleted from it, so one swapped for a link while a
  slow revoke ran is refused. Session folders it could not delete, a temp
  directory it could not read, and `aiand-*` folders from an older aiand that
  still hold a key (no marker, so it deletes nothing on a guess) are reported
  and make the run incomplete, and so is a session folder kept because a
  Hermes shim still points into it (the report says to reinstall Hermes
  rather than delete it by hand), as is a revoke the server answered with an HTTP
  status, which `--json` gives as `http_status`. An agent it could not clean up (its
  `off` failed, or its config still holds a key) keeps its snapshot and the
  record `on` left, so running `aiand <agent> off` once the file is fixed
  still strips exactly what was added. See "Shared and loaner computers" in
  the README.
- `aiand run-agent` marks each throwaway session dir it creates, and deletes
  day-old ones whose session is gone before starting a new one; `logout` and
  `logout --all` delete them regardless of age. A session killed before its
  cleanup no longer leaves its key in the temp directory indefinitely.
- `install.sh uninstall --purge` and `install.ps1 uninstall --purge` wipe a
  shared or loaner machine. Before deleting anything, they run
  `aiand logout --all --force --json`, or `aiand logout --profile <name>
  --json` for each profile on a CLI without `--all`. That revokes the keys
  this CLI minted and strips every agent. They then delete the config
  directory along with the CLI. They go on only when every key the CLI minted
  reports revoked (a pasted key is not theirs to revoke); an older CLI exits 0
  after a failed revoke, so the installer reads the JSON, not the exit code.
  Otherwise nothing is deleted by the installer, and `--force --purge` skips
  sign-out and says the keys were not revoked. The config directory must sit strictly
  inside HOME, be named `aiand`, and on Windows have no link or junction
  between it and HOME.
- Jouzu, Shisa AI's terminal coding harness built on Pi, is supported:
  `aiand jouzu` (or `aiand jz`), `aiand jouzu on|off|status`,
  `aiand restore jouzu --force`, and key rotation. `on` writes Pi's
  provider, credential and defaults into Jouzu's own config dir
  (`$JOUZU_HOME/agent`, or Jouzu's per-platform default), never into Pi's.
  `aiand jouzu` opens Jouzu on the ai& model it wired, because Jouzu's
  last-used model would otherwise decide, unless the arguments pick a
  model or session (`--model`, `--continue`, `--fork` and the like) or run
  a Jouzu or Pi command (`doctor`, `list`, `install` and the like). There is
  no `run-agent jouzu`.

### Changed

- The README is reorganised around a three-step quick start, a short Claude Code
  section, a table of supported agents, per-OS key storage, troubleshooting,
  and a "Shared and loaner computers" section; per-agent detail moved to
  `docs/agents.md`. A Japanese README, `README.ja.md`, ships alongside it.
- `aiand status` now calls the fallback tier `file (owner-only, not encrypted at
  rest)` instead of `encrypted file`: its decryption key sits beside the
  ciphertext, so it is worth no more than an owner-only file. `aiand status
  --json` keeps the label in `storage` and adds `storage_tier` with the stable
  tier id (`keychain`, `dpapi`, `file` or `plaintext`). The README documents
  `AIAND_SECRET_STORE_MASTER_KEY`, which supplies that key from elsewhere.
  The label follows the facts: with `AIAND_SECRET_STORE_MASTER_KEY` set it
  reads `file (encrypted; key held outside the config folder)`, and on
  Windows, where `icacls` could not restrict the files to you, it says
  `not owner-only`. `storage_tier` does not change.
- `aiand hermes on` sets your own `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`
  and `ANTHROPIC_TOKEN` entries aside by commenting them out where they sit
  in `~/.hermes/.env` (`# aiand set aside: …`), instead of copying them in
  plaintext into `~/.config/aiand/snapshots/hermes`. `off` uncomments them.
  A multi-line quoted value now comes back whole; before, only its first line
  was handed back. Entries an earlier version recorded are still handed back
  by `off`, which then deletes the record. A `#` comment containing an
  apostrophe no longer hides the next `.env` entry from that check, and a
  launcher session's throwaway home never carries a set-aside entry.
- `install.sh` and `install.ps1` install the latest release instead of
  building the main branch. They download the `@aiand/cli` tarball from npm
  and install it only when it matches both npm's sha512 and the
  `SHA256SUMS` attached to the GitHub release. With no release reachable,
  or with GitHub rate-limiting the download, they stop and change nothing,
  with no fallback to `main`. `AIAND_VERSION=x.y.z` installs that release,
  including one older than the installed version: without it, they refuse a
  latest release that is older than what is installed, and they refuse
  anything older than 0.8.0, the first release published with a
  `SHA256SUMS`, even when pinned. `AIAND_SOURCE` still builds a checkout or
  clone, labelled as an unverified development build. A release install
  needs only Node.js, not git or npm. Releases before this one have no
  `SHA256SUMS`, so the installers cannot install them. These checks cover
  the tarball, not the installer script: a fresh install runs the script as
  fetched from GitHub alone, before anything is verified, so that first
  step is trusted on first use. Later `update` runs run the copy of the
  script that shipped in an earlier verified release.
- The README one-liners fetch `install.sh` and `install.ps1` from the latest
  GitHub release's assets
  (`https://github.com/aiandlabs/aiand-cli/releases/latest/download/`)
  instead of the main branch, so a push to main no longer changes what a new
  install runs. Until a release carries them they answer 404: run
  `npm install -g @aiand/cli` meanwhile.
- Running `aiand claude` on its own (no `on`, `off` or `status`) starts one
  Claude Code session on ai& and leaves Claude Code's settings alone, the
  same launch as `aiand run-agent claude`. It used to run
  `aiand claude on` first, which moved every Claude Code session already
  open, including other terminals and editor sessions, onto ai&, where
  Anthropic's models fail. `aiand claude on` and `off` still route every
  `claude` through ai& and back. Other agents keep opening through `on`.
- `aiand claude on` warns that Claude Code sessions already running switch
  to ai& at once. `aiand claude off` now moves them back as well: Claude
  Code applies settings changes to running sessions but keeps a value that
  disappears, so `off` first writes what it removes as empty (which Claude
  Code reads as unset), waits three seconds for running sessions to reload,
  then deletes it. `off` therefore takes about three seconds.
- `/model` rows in Claude Code show the context Claude Code actually gets
  under the 200K cap (`ai& · 200K context`) instead of the model's full
  window, and label only text-only models (`· text only`) instead of
  printing `vision` on most rows.
- Publishing: the job runs in a GitHub environment named `release`, so that
  approval and `v*`-only deployment can be required for it. A first run packs
  from the tagged checkout and stops if the draft release already holds a
  different tarball of the same name; only a resumed run reuses an uploaded one.
  CONTRIBUTING.md lists the repository and npm settings this relies on. The
  draft release is published only when it holds exactly the tarball,
  `SHA256SUMS`, `install.sh` and `install.ps1`; an asset anyone else attached
  to it stops the run, naming what to remove, before anything is published.

### Fixed

- `aiand logout` when the server does not revoke the key now says what it
  answered (`https://… answered HTTP 404 to the sign-out request`) instead of
  always telling you to check your connection. The sign-in is still kept.
- `aiand run --no-stream "…" > out.txt` ends the answer with the platform's
  line ending again (`\r\n` on Windows), as it did before the output was
  cleaned.
- Two `aiand` processes waiting on the same dead lock could still both take it:
  one that had judged the lock stale could delete the fresh lock a faster one had
  just created. Takeovers now go one at a time, and each re-checks the lock first.
  A lock that disappears mid-check is retried instead of judged by a missing
  timestamp.
- `aiand claude` could skip the "Your default Claude Code model is ... again" note
  when Claude Code saved a default of its own just before the session ended.
- `aiand models` now uses your stored login when `AIAND_API_KEY` is set to only whitespace, matching every other command.
- Pasting a key that has a stray space or control character inside it at the masked prompt now counts as one of the three attempts instead of ending the login on the spot; leading and trailing whitespace is trimmed.
- `aiand status` no longer fails with exit 2 and no output when the stored sign-in belongs to another endpoint (`--base-url B` while signed in on A): it reports not signed in with the reason (`reason` in `--json`) and the agent table. `whoami` still refuses.
- `aiand login --base-url X` now saves X on the profile, so later commands no longer exit 2 asking you to drop an override you never set. The refusal hint names `aiand config set api-url` / `auth-url`, and only says to drop an override when one is set.
- On Windows, the GitHub Copilot app wiring no longer picks a `sqlite3.cmd` or
  `sqlite3.bat` from PATH, which cannot be launched; it looks for `sqlite3.exe`.
- Coding agents now start with a PATH of absolute entries only, on every platform.
  A `.`, empty or relative entry let `#!/usr/bin/env node` (or an npm shim's
  `node`) run a program planted in a cloned repository.
- On Windows, an `aiand_api_key` or other differently-cased spelling of the
  secret variables is now removed from the environment of agents and npm installs,
  as the exact-case name already was.
- `AIAND_SECRET_STORE_MASTER_KEY` no longer reaches the coding agents you launch
  with `aiand <agent>`, the processes they start, or the `npm install -g` that
  fetches one. Only Codex still gets it, because its `aiand key export` command
  needs it to read the encrypted file store.
- A token refresh that finds its profile signed out by another process now stops
  with "not signed in" instead of rotating the old refresh token, which signed
  the profile back in.
- On Windows, saving a key no longer holds the store lock while it starts `whoami`
  and `icacls`, so a second `aiand` waiting on a cold machine no longer takes the
  lock over mid-write.
- A second `aiand key export` (Codex starts one per session) no longer steals the
  token-refresh lock from a refresh that is merely slow, which could rotate one
  refresh token twice and get the whole sign-in revoked as stolen. A lock is
  now taken over only when its holder has exited; a live holder keeps it alive
  while it works, and the rotation request itself times out after 30 seconds.
  A lock also names its holder by process ID and a random value, and a live
  holder is called hung only after the waiting process has watched the lock
  stay untouched for a minute on its own clock. A process ID that Windows gave
  to something else after a killed `aiand key export` no longer holds everyone
  up for five minutes, and a clock change or a laptop going to sleep no longer
  makes a waiter take a lock whose holder is alive.
- On Windows, `aiand.cmd` finds Node through PATH again when its baked-in
  Node is gone and Node lives under the current directory (a profile-local
  fnm or scoop Node from `%USERPROFILE%`, anything from `C:\`). A hit is
  refused only when it came through an empty, `.`, relative or
  drive-relative PATH entry.
- On Windows, `install.ps1 uninstall` now refuses, before turning anything off,
  a checkout that is a link or junction or holds one, as it already did for
  the config directory, instead of letting PowerShell follow it into the target.
- `uninstall --purge` now stops, deleting nothing, when `logout --all` could
  not read the credentials it was meant to revoke (`complete: false` with
  `problems`, or no profiles while `credentials.json` names some), in
  `install.sh` and `install.ps1`.
- `uninstall --purge` no longer deletes what `logout --all` kept. When
  `logout --all` exits non-zero it lists the keys still on disk and what it
  kept in the config directory, leaves that directory unless it is empty, and
  exits 1.
- On Windows, `install.ps1 uninstall --purge` no longer stops with a PowerShell
  error and exit 1 after it has signed you out: `aiand logout --all` already
  deletes the config directory, which the purge then tried to delete again.
- On Windows, launching an agent through an npm `.cmd` shim now runs it with a
  `PATH` of absolute entries only. `NoDefaultCurrentDirectoryInExePath` stops
  cmd.exe searching the current directory by itself, but not a `.` or relative
  entry you put in `PATH`, so the shim's bare `node` could run a `node.exe`
  planted in a repo you were standing in.
- On Windows, the throwaway folder that holds a key for a launched agent is now
  refused, and removed, when it could not be made owner-only, instead of the
  key being written under the folder's inherited permissions.
- A file where ai& needs a directory (a config path blocked by a file) is a
  clear error with a hint on Windows too, instead of `Unexpected error: EEXIST`.
- A stored sign-in is now bound to the endpoints that issued it, recorded as
  `bound_to` in `credentials.json`. When `--base-url`, `AIAND_BASE_URL`,
  `AIAND_AUTH_URL` or `aiand config set` point elsewhere, the CLI refuses to
  send the stored key (exit 2, with a hint to sign in on a separate profile)
  instead of sending it to that host, and never sends the refresh token
  anywhere but its issuer, so a pasted "faster endpoint" command can no longer
  take over the account. `logout` revokes at the issuer too. Sign-ins saved by
  earlier versions are bound on first use to the profile's stored endpoints
  (the production default unless `config set` changed them), never to a
  one-off override; if you signed in under `AIAND_BASE_URL` before, sign in
  again. `AIAND_API_KEY` is unaffected.
- Codex no longer pulls the stored key to an endpoint it was not issued for.
  `aiand codex on` now writes `aiand key export --for <origin>` into the
  profile (the origin Codex sends to), and `key export --for` refuses, with
  exit 2, unless the stored sign-in was issued for that origin. Before, the
  check used the profile as resolved in Codex's environment, so a profile
  wired by `AIAND_API_KEY=k AIAND_BASE_URL=B aiand codex on` later handed the
  stored key to B. `codex on` also warns when the environment key's endpoint
  differs from the stored sign-in's. A Codex profile written before this
  (no `--for`) is checked against its own `base_url` when it belongs to the
  profile being exported, so `aiand key export` run by hand can now be
  refused for the same reason; run `aiand codex on` again to rewrite it.
  `--for` takes an origin only: a URL with a username or password is refused
  without being printed, and an endpoint quoted in a refusal, a hint or a
  rewire note never carries a username, password, query or fragment.
- `aiand config set api-url` / `auth-url` can no longer redirect an old
  sign-in that has not been used since the upgrade. A credential saved before
  0.8 is pinned to the profile's stored endpoints when it is first used, so
  setting both URLs to a new host first, then running `whoami` or `logout`,
  sent the key and refresh token there and bound the credential to it. The
  pin is now written before the new URL is. `config set api-url` also names
  any agent wired for the old API endpoint, which keeps sending there.
- A stored sign-in with no recorded endpoint is now refused instead of sent
  anywhere. The request gate used to let it through, a token refresh fell
  back to the profile as resolved with this run's overrides, and saving a
  credential without a binding recorded those overrides. The first now fails
  closed, and the others take the profile's stored endpoints, as the first
  use of an older sign-in already did. `status --local` and `whoami --local`
  still read the cached identity without a binding.
- `aiand models --base-url <url>` while signed in for a different endpoint
  now lists that endpoint's public catalog, priced in USD, with a note that
  the stored key was not sent, instead of failing with the endpoint-binding
  refusal. The same applies after `aiand config set api-url`.
- If you keep `AIAND_BASE_URL` (or `AIAND_AUTH_URL`) exported to reach staging
  while signed in on the `default` profile, that sign-in is now refused
  there: it was issued for production, and the override no longer moves it.
  Sign in once on a profile of its own, for example `aiand login --profile
  staging --base-url https://staging.example.com`, then select it with
  `--profile staging`, `AIAND_PROFILE=staging`, or `aiand config use staging`
  and drop the exported URLs. Keeping the `default` profile for production
  leaves it working unchanged.
- Requests that carry a key, refresh token, device code or PKCE verifier no
  longer follow redirects. A 307/308 resent the body to the `Location`, even
  cross-origin; the CLI now stops with an error naming the redirect.
- A key containing a line break, space or other unprintable character (for
  example `AIAND_API_KEY="$(grep sk- .env)"` matching two lines) is refused
  with "API key contains invalid characters (check for a line break or
  space)" when it is read from `AIAND_API_KEY`, pasted, or saved, instead of
  being printed in full in a "Could not reach" error. Error messages and
  crash stacks now redact `Bearer …` values and `sk-…` keys, and a request
  the CLI could not build is no longer reported as a network failure.
- Switching profiles (`aiand config use`) or signing in to another one no
  longer bakes that profile's key into an agent wired for a different API
  endpoint, which sent it to that endpoint. `aiand <agent> on` now records
  the endpoint it wired (`wired.json` in the config directory); an agent
  wired for another one keeps its key and is named in a note with the
  `aiand --profile <name> <agent> on` command that moves it. An agent wired
  by an earlier version has no record, so its own config is read for the base
  URL it holds and compared with the credential's; one that cannot be read
  is left alone with the same note.
- Automatic key rotation now holds to the same rule. It used to swap the new
  key into every agent config that held the previous one, including an agent
  wired for another API endpoint before 0.8 (no record, an override
  pointing elsewhere), which kept getting each rotated key. It now swaps
  only agents wired for the credential's own endpoint, still only where the
  config holds exactly the key it replaced, and names any other in a note
  with the `aiand --profile <name> <agent> on` command that moves it.
- Reads from the gateway are bounded: a server-sent event line over 1 MiB
  ends the stream with an error, error bodies are read up to 64 KiB and
  shown as at most 500 characters (a non-JSON body as its status text plus
  first line), and `aiand logs` stops paging when a page adds no rows or the
  cursor repeats, instead of looping forever.
- On Windows, aiand no longer finds an agent, npm, or itself in the current
  directory. It used `where`, which searches the current directory before
  PATH, so a `claude.cmd`, `npm.cmd` or `aiand.cmd` in a cloned repo would run
  in place of the real one, and `aiand codex on` could bake that `aiand.cmd`
  into Codex's auth command. aiand now walks PATH itself, skipping empty,
  relative and `.` entries, and spawns what it finds by absolute path. A
  directory you put on PATH by its absolute path still counts, even while you
  are in it. Run `aiand codex on` again if you set Codex up from inside a repo
  you did not write.
- On macOS and Linux, an agent or npm that resolves only through an empty,
  `.` or relative PATH entry in the current directory is treated as not
  installed, and aiand spawns the agent by the absolute path it detected
  rather than by name. A directory you put on PATH by its absolute path still
  counts, even while you are in it.
- On Windows, aiand starts `cmd.exe`, `rundll32.exe` and `tasklist.exe` from
  `%SystemRoot%\System32` and `sqlite3` from PATH by absolute path, so a
  same-named file in the current directory never runs in their place. Batch
  shims now always go through System32's `cmd.exe`, not `%ComSpec%`.
- On Windows, batch shims run under `cmd.exe /v:off`, so delayed expansion
  turned on in the registry cannot expand `!name!` in an argument.
- The installed launchers no longer fall back to a `node` in the current
  directory when the Node.js found at install time is gone. `aiand.cmd`
  searched with `where node`, which tries the current directory first; it now
  searches PATH only and refuses a `node.exe` that came through a relative
  PATH entry (an empty or `.` entry, `bin`, a drive-relative one), so a cloned
  repo cannot supply it; a drive-rooted or UNC PATH entry is trusted even when
  it lies under the current directory. It also runs under `setlocal
  DisableDelayedExpansion`, so it no longer leaks variables into your shell
  or expands `!name!` in an argument. The bash launchers (`install.sh`, and
  `install.ps1`'s Git Bash shim) refuse the relative path an empty or `.`
  PATH entry yields. Re-run the installer to get the new launchers.
- On Windows, the files and folders that hold your key are now readable by
  you alone. Windows ignores the owner-only modes the CLI sets elsewhere, so
  the config folder, the key stores, `credentials.json`, agent configs
  carrying the key, snapshots, and the throwaway folders `run-agent` writes
  the key into now get an owner-only ACL (`icacls`, your account's SID with
  full control, inherited entries removed). Before, a session folder under a
  shared `TEMP` could be readable by every user on the machine. If `icacls`
  fails the write still goes ahead; `AIAND_DEBUG=1` prints why.
- `aiand login --paste` no longer shows your key on Windows. The prompt now
  masks it with `*` as it does on macOS and Linux, in Windows Terminal and
  the classic console alike: a Ctrl+V or right-click paste is masked, and
  Backspace and Ctrl+C (exit 130) work as usual. Input is visible only on a
  terminal that offers no raw mode, and the prompt says so first.
- `aiand run` and `aiand chat` no longer pass escape and control sequences
  from a model's answer or reasoning to your terminal. A reply (for example,
  one steered by a prompt-injected page you asked it to summarise) could
  previously write your clipboard (OSC 52), plant a link whose target differs
  from its text (OSC 8), retitle the window, or move the cursor and erase
  lines to fake a prompt. Escape sequences, C0/C1 controls, DEL, and bidi
  override and isolate characters are now removed, including a sequence split
  across streamed chunks; a bare carriage return prints as a new line, so it
  can no longer overwrite what came before it. Japanese, emoji, combining
  marks, tabs, and CRLF are untouched. Only terminal output is filtered:
  piped or redirected output (`aiand run … > out.md`) is still the model's
  raw text, byte for byte.
- Text from the server is now cleaned before it is printed, piped or not:
  organization names, emails, model ids and descriptions, log rows, usage
  labels, response headers in the `run` footer and `chat`, and API error
  messages (cleaned when they are received). Escape and control sequences
  and bidi overrides are removed, and a line break inside a table cell or
  field becomes a space, so it can no longer add a fake row. Cell text is
  cleaned in full and only then coloured, so no escape sequence, a server's
  colour codes included, reaches a pipe, a file, or a `NO_COLOR` terminal
  from a cell. Notes, warnings, hints and error text that quote the gateway
  are cleaned wherever they are printed: `aiand init`, `aiand <agent> on` and
  `off`, the chat banner, the key-refresh notes after sign-in and `aiand
  config use`, and `aiand logs --follow`. A model whose id has control or
  bidi characters is dropped from the catalog, a token count or latency that
  is not a number prints as `-`, and an update notice shows only a
  version-shaped string. `--json` output is unchanged. The installers clean
  the text they print about a release (a tarball entry name, an npm manifest
  field) the same way.
- Sweeping a crashed Hermes session's overlay (the next `aiand run-agent`
  after a day, or `logout`) puts the store shims back first. A session that
  died before its cleanup left your own `hermes` binary pointing into the
  overlay, and deleting the overlay broke it. The overlay now carries a copy
  of the shim snapshot, and is kept while any shim still points inside.
- Hermes's `.env` handling treats a quote as opening a multi-line value only
  straight after the `=`, as python-dotenv does. A stray quote inside an
  unquoted value (`GREETING=it's fine`, `URL=http://x?a="b`) used to hide every
  following line, so `aiand hermes on` left your own `ANTHROPIC_API_KEY` active
  and `off` left `AIAND_HERMES_API_KEY` in the file.
- `aiand logout` no longer deletes the refresh token when it cannot reach ai&
  to revoke the key. You stay signed in, with a message to retry or to run
  `logout --keep-remote`; before, the key stayed valid with nothing left on
  the machine that could revoke it. Pasted-key and no-refresh-token logouts
  now name the console page that revokes the key.
- A snapshot never copies a config file that already carries ai&'s marker or
  a known ai& key. Before, re-running `on` after moving an agent's config dir
  (`PI_CODING_AGENT_DIR`, `COPILOT_HOME`, Oh My Pi's agent dir) copied the
  wired file, key included, into `~/.config/aiand/snapshots` and replaced the
  real pre-aiand snapshot. Now `on` adds a moved dir's files beside the first
  capture instead of replacing it, and Pi, Oh My Pi and the Copilot CLI refuse
  to wire a second dir while the first still holds the key (run `off` first),
  as Claude Code and Codex already did. `aiand restore` says which files it
  had no copy of, and keeps the copies of files the agent no longer reads.
  `aiand logout` deletes snapshot copies an older version left holding the
  logged-out key, and copies carrying ai&'s marker even when the key in them
  is another one. `aiand restore` keeps what `on` recorded while a path it left
  alone (the agent no longer reads it) may still be wired, so `off` run from a
  shell that names that path can still tell your values from ours.
- `aiand omp off` and `aiand copilot off` no longer leave the ai& key behind
  when you edited the `aiand` provider's `baseUrl`. They keep your edit,
  remove the key (and Oh My Pi's `managedBy` stamp) from the block, and say
  so. They remove only a key ai& put there (a stored, session or `AIAND_API_KEY`
  key, or the one `on` wrote); a key you set in the repointed block stays. Before, the key stayed and `off` forgot it had written it, so logout
  could not remove it either.
- `on` and the key refresh after `login` refuse to write the ai& key into an
  agent config that sits inside a git repository, which is where a GNU Stow or
  chezmoi symlink into a dotfiles repo used to put it, one `git add -A` from
  being pushed. The error names the repository and how to proceed; gitignore
  the file and set `AIAND_ALLOW_GIT_TRACKED=1` to write it anyway. A bare
  dotfiles repository directly in your home directory (`git
  --git-dir=~/.dotfiles --work-tree=~`) counts too: it is recognised from its
  `core.worktree`, or from the `index` such a repository grows, without
  running git, and so do the repositories yadm (`~/.local/share/yadm/repo.git`)
  and vcsh (`~/.config/vcsh/repo.d/*.git`) keep. The opt-in is remembered for each file in the agent's recorded
  state, so the key rotation a later `login` runs, without the variable, still
  swaps the key it wrote instead of leaving the agent on a dead one; `off`
  forgets it. Config files that do not hold the key still follow links as
  before.
- `aiand omp on` quotes and escapes every model id or value it writes to
  Oh My Pi's YAML unless it is a plain id, URL or key, so a carriage return,
  NEL, U+2028/2029, tab, control character or a word like `yes` or `0x1F` in
  a catalog string can no longer add keys or change a value's type.
- `aiand opencode on` copies only the descriptive fields of each model from
  the gateway's `/v1/api.json` (name, family, dates, limits, cost,
  modalities, capability flags, status, reasoning options) and drops
  `npm`, `provider`, `options`, `headers`, `variants` and any string carrying
  an OpenCode `{env:…}` or `{file:…}` substitution.
  `aiand opencode` (the session launcher) holds the models it builds from the
  catalog to the same allowlist, and leaves out a model whose id carries one.
- `aiand opencode off` on an `opencode.json` that does not parse no longer
  reports "nothing to turn off" with the key still inside. It says the file
  may still hold your ai& key, asks you to fix the JSON and run `off` again,
  and keeps what `on` recorded so that retry strips exactly what it added,
  as `aiand claude off` already did.
- `install.ps1 uninstall --purge` refuses a config directory with a directory
  link or junction inside it, deleting nothing. Windows PowerShell 5.1 follows
  a junction when it deletes recursively, which would have removed files
  outside the config directory.
- A release install no longer replaces a git clone it did not create. A
  developer's checkout at `AIAND_DIR` has no ownership marker and is not the
  default install directory, so the installer stops and leaves it alone, as
  `uninstall` already did.
- `uninstall --purge` no longer refuses everything when HOME is reached
  through a symlink and `~/.config/aiand` was never created. A config
  directory that does not exist is skipped, not guarded, and the purge says so.
- The installers' "no published release was found" and "release v… was not
  found" errors now tell users to `npm install -g @aiand/cli` meanwhile, which
  matters from merge until the first release with a `SHA256SUMS`.
- A failed `publish.yml` run can be re-run. A version already on npm with no
  complete GitHub release resumes instead of stopping at the "already on
  npm" check: it publishes nothing, requires npm to serve the tarball it just
  packed, and creates the release (as a draft, published once every asset is
  attached). The wait for npm to serve a new version is up to about ten
  minutes, with backoff, up from 150 seconds.
- `install.sh update` and `install.ps1 update` say why when npm's latest
  version, which the update notice reads, is ahead of the latest GitHub
  release, which they install: "already up to date; npm shows X, but its
  GitHub release is not out yet". Before, the notice and the updater looked
  like a loop.
- The Hermes Agent install hint on macOS and Linux no longer pipes the
  site's installer into bash. It downloads the installer at the pinned
  commit to a temp file and runs it only after its sha256 matches. The Oh My
  Pi hint downloads the binary to a temp file, checks it, and only then
  moves it into `~/.local/bin`, so an unverified binary is never on PATH.
  On Windows it is now plain PowerShell that works when pasted at a
  PowerShell prompt: the old `powershell -Command "…"` line broke on its
  nested quotes. The Hermes hint on Windows does the same as the other
  platforms: it downloads the commit-pinned `install.ps1` and runs it only
  when its SHA-256 matches (the earlier line was missing a closing quote and
  could not be parsed), in PowerShell 7 and Windows PowerShell 5.1 alike.
- Opening Claude Code or Codex when it is missing installs a pinned release,
  not whatever npm calls latest: `@anthropic-ai/claude-code@2.1.312` and
  `@openai/codex@0.165.0`. Codex and the Copilot CLI install with
  `--ignore-scripts`, since neither package has an install script. Claude
  Code still runs its postinstall, which puts its native binary in place.
  The question names the exact command it will run. `check:dist` now fails
  any npm install hint that has no exact version, or that runs install
  scripts without a stated reason.
- The update notice for installer installs printed a command that rebuilt
  the version already installed. It now prints `bash ~/.aiand/cli/install.sh
  update`, or on Windows `powershell -NoProfile -ExecutionPolicy Bypass -File
  "…\install.ps1" update`, which runs under the default execution policy.
  `update` always fetches and verifies the latest release, and it updates
  the install directory it runs from. npm installs are told to run
  `npm install -g @aiand/cli@latest`. Installs made before this release
  update by running the one-line install command again.
- The installers refuse an `AIAND_SOURCE` that starts with `-` and end
  `git clone`'s options with `--`, so a source can never be read as a git
  option such as `--upload-pack`.
- On Windows, a program run through an npm `.cmd` shim can no longer be
  planted in the current directory. npm's shim runs `node.exe` beside itself
  if there is one and otherwise a bare `node`, which `cmd.exe` looks for in the
  current directory first (the default Node installer keeps the shims in
  `%APPDATA%\npm` and `node.exe` in Program Files), so `cd cloned-repo &&
  aiand codex` ran a `node.exe` or `node.cmd` from the repo. aiand now sets
  `NoDefaultCurrentDirectoryInExePath=1` for itself and every process it
  starts, and `aiand codex on` bakes Node's absolute path and this install's
  `dist\index.js` as Codex's auth command instead of `aiand.cmd`. Run
  `aiand codex on` again to replace a baked `aiand.cmd`.
- On Windows, aiand finds programs that are Store App Execution Aliases (such
  as a `python.exe` or `winget.exe` in `%LOCALAPPDATA%\Microsoft\WindowsApps`)
  again. Those are zero-byte reparse points that `stat` can refuse to open,
  and the PATH walk had stopped seeing them.
- On macOS and Linux, the system tools aiand starts (`which`, `open`,
  `xdg-open`, `pgrep`, `security`, `secret-tool`, `sqlite3`) are found through
  the absolute entries of PATH only. They used to run through the whole PATH,
  so an empty, `.` or relative entry could pick a same-named file in the
  current directory. They also no longer inherit `AIAND_API_KEY` or
  `AIAND_SECRET_STORE_MASTER_KEY`, which the keychain tools never needed.
- On Windows, `aiand logout` and the rest of the credential store no longer
  start `secret-tool`. It was a bare name, so `cmd.exe` tried the current
  directory first, and the child inherited `AIAND_API_KEY`. Nothing is
  spawned there now.
- Two `aiand` processes on Windows can no longer lose a key to each other.
  Moving a sign-in into DPAPI on first read, or saving a new one, rewrites
  whole key stores, and processes running at once (Codex starts one per
  session) could overwrite each other's update: a key whose old copy was
  already removed was gone, and `credentials.json` could lose a concurrent
  sign-in. The key stores and `credentials.json` are now updated under a
  cross-process lock, the old copy is removed only after DPAPI is seen to
  hold the key, and a stale read never overwrites a newer sign-in.
- Signing in on Windows no longer fails when an old encrypted-file store
  cannot be read (for example after `AIAND_SECRET_STORE_MASTER_KEY` changed)
  even though DPAPI already holds the new key. The leftover file copy is
  simply left alone.
- A config folder shared between Windows and WSL or Linux no longer shows the
  Linux side as signed out, nor tries to start a Windows PowerShell from it,
  once Windows has moved the key into DPAPI. The Linux side now says the key
  was stored with Windows DPAPI and to sign in again there.
- A single failed PowerShell start on Windows no longer keeps your key out of
  DPAPI until you sign in again. Constrained Language Mode, which is policy,
  is remembered for good. After a timeout or a PowerShell that would not
  start, the next save tries DPAPI again (once per run), and a read waits ten
  minutes before it tries again: a PowerShell that hangs used to cost every
  `aiand` process, and so every Codex session, 20 seconds on its first read of
  the key. `aiand status` says why the key is in the file in both cases.
- The fallback warning on Windows now says how to stop aiand trying DPAPI
  (`AIAND_KEY_STORAGE=file`) for machines where endpoint security blocks the
  PowerShell call. `docs/windows-key-storage.md` records what a DPAPI read
  costs and a test plan for real Windows machines, Microsoft Defender
  included.
- A stray control character no longer swallows the text after it. A mis-decoded
  quote (`â€\u009d`) carries an 8-bit string introducer that was read as the
  start of a hidden sequence, so `aiand run`, `aiand chat` and every table or
  field cut off at that point. Those introducers are now dropped on their own,
  and an escape-introduced string that is never closed ends at the next line
  break, or after 4096 characters, instead of running to the end of the
  output.
- An emoji or other character outside the basic plane that a model streams
  split across two chunks now prints whole, on a terminal and in a pipe,
  instead of as two replacement characters.
- Chat in the GitHub Copilot app no longer fails with `400 max_tokens must
  be an integer of at least 1 and below the model's context window`.
  `aiand copilot-app on` set each model's output limit to its whole context
  window, which the app sends as `max_tokens`. It now writes the output limit
  ai& publishes for the model, capped at half the context window, and gives
  the prompt the rest, so prompt and output together fit the model. Run
  `aiand copilot-app on` again to update a database set up earlier.
- Ctrl+C inside an agent started by aiand reaches only the agent. aiand used
  to exit and delete the session's settings on the first press, handing the
  prompt back while the agent kept running (Claude Code uses that press to
  clear its input). SIGTERM and SIGHUP are passed on to the agent, and the
  session's files are removed after it exits. A launched agent killed by a
  signal now exits with `128 + n` instead of `1`.
- Saving an ai& model as the default in `/model` inside an `aiand claude`
  (or `aiand run-agent claude`) session no longer leaves plain `claude`
  starting on a model Anthropic does not serve: aiand puts your own default
  back as soon as Claude Code saves the pick, so a `claude` started in
  another terminal meanwhile is not affected either. An ai& default left by
  an earlier session is removed when the next one ends. While
  `aiand claude on` is in effect, an ai& default is yours to keep. A
  `settings.json` symlinked into a dotfiles checkout is covered too.
- `aiand logout --all` no longer deletes a sign-in it could not read. A profile whose
  credential would not load (a locked keychain over SSH) or a corrupt
  `credentials.json` is now reported as `revoked: false, kept: true`, its sign-in
  files stay for a retry, and the run is `complete: false` with a `problems` entry.
- `aiand logout --all` no longer strips the Copilot app while the app is running: like
  `aiand copilot-app off`, it now asks you to quit it first (the app rewrites its
  database on exit and would put the key back), and keeps that agent's state for a retry.
- `aiand restore <agent> --force` no longer drops what `on` recorded while a file it could
  not restore still holds ai& wiring (a Copilot CLI wired at a non-default URL, say), so a
  later `aiand <agent> off` can still find the key it has to remove.
- `aiand opencode on` no longer writes a model id into OpenCode's root `model` unless OpenCode's
  cleaned model map carries it, so an id holding `{env:}` or `{file:}` cannot be read back
  through OpenCode's substitution.
- Sweeping the overlay of a crashed Hermes session no longer reverts a store shim you
  updated since: it puts back only a shim that still points into the overlay.
- Running `aiand claude off` again after one was interrupted during its reload wait now
  removes the keys the first run had emptied, instead of leaving `""` values behind and
  claiming you edited them.
- Signing in, or switching profile, no longer bakes a key into an agent wired for another
  endpoint when `on` left no record of where (pre-0.8 `AIAND_BASE_URL=staging aiand opencode on`,
  then `aiand login --force` against production). Each agent's own config is read for the
  base URL it bakes and compared with the credential's; one that cannot be judged is left alone
  with a note naming `aiand --profile <name> <agent> on`, and a corrupt `wired.json` no longer
  reads as safe.
- `aiand login` over SSH signs in with a device code right away instead of
  waiting five minutes for a browser redirect that can't reach the remote
  machine, and no longer opens a browser on the remote machine.
- `install.ps1` no longer starts with a byte-order mark, so
  `irm <url> | iex` runs it from its first line instead of failing on
  `PowerShell` and `param()` as commands. It is plain ASCII now (the banner is
  built from character codes), which Windows PowerShell 5.1 reads correctly
  from the raw bytes a release serves, and a test fails if either comes back.
- A release install refuses a git checkout whose branch has no upstream, as
  well as one with commits its upstream lacks. Before, `git switch -c mywork`,
  a commit, and a re-run of the installer replaced the checkout and the commit
  with it, because the failed comparison read as "nothing ahead".
- An update stopped between the two moves that swap it in (Ctrl-C, a closed
  terminal, `SIGTERM`) puts the previous install back instead of leaving
  `~/.aiand/cli` empty, and a run that was killed outright is repaired by the
  next one before it does anything else. Staging and `cli.prev-*` folders an
  earlier run left behind are removed on the next run; a folder that is not an
  `@aiand/cli` install, a link, and one a still-running installer is using are
  left alone. `install.ps1` does the same. The pid in a `cli.prev-<pid>` name
  counts with or without a suffix after it, and a run that finds another
  installer's set-aside install, while that installer is still running, no
  longer puts it back or deletes it, which made that installer's second move
  nest the new install inside the old one.
- A release download over the size limit stops at the limit with a message
  naming it, instead of being downloaded whole and then refused without one.
  The limit is 16 MiB for the tarball (a release is a few hundred KiB), 4 MiB
  for `SHA256SUMS` and npm's manifest, and 64 MiB for what the tarball unpacks to.
- `aiand pi on --model native` after an earlier `aiand pi on` now hands
  back the `defaultProvider` and `defaultModel` that `on` set, as it does
  on a fresh config. They used to stay, so ai& kept deciding Pi's model.
- `aiand pi off` removes Pi's ai& credential last, so an `off` that stops
  part-way can be run again. After the agent dir moved, it now removes a
  credential whose marker Pi dropped, and keeps a provider block you
  edited, as it already did in the current dir.

### Removed

- The organization picker at sign-in. A key belongs to exactly one org, so
  browser and device sign-in, `aiand login --paste` and `--with-token` no
  longer ask a multi-org account to choose one: the CLI records the org the
  gateway names in the token response (or, if it names none, the first org it
  lists; for a pasted key, the first org the gateway lists) instead of one the
  key does not bill, which `status` and `whoami` then misreported.
- The keychain tier on Windows. Windows keeps its key in DPAPI or the
  encrypted file, so `AIAND_KEY_STORAGE=keychain` now fails there with a
  clear error instead of being tried.


## [0.7.1] - 2026-11-02

### Changed

- `aiand claude on` picks `deepseek-ai/deepseek-v4.1-flash-1017` as Claude
  Code's fast model, replacing `deepseek-ai/deepseek-v4.1-flash`, which ai&
  retires on 2026-11-06 0:00 JST. A setup written earlier keeps the old
  model until then: run `aiand claude on` again after that date, or run
  `aiand claude on --model <your main model>` to switch now.


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
