# Changelog

All notable changes to this project will be documented in this file.

Versioning follows semver, with the caveat that before `1.0` a minor version may include
breaking changes while the command surface settles.

## [Unreleased]

### Added

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
- `aiand dsh on` wires DeepSeek Harness to ai& through `$DSH_HOME`
  (or `~/.dsh`): an `aiand` provider route replacing the `llm-pi-ai`
  row in `cordis.patch.yml`, speaking the gateway's OpenAI-compatible
  chat dialect with every model from the live catalog, and a marked
  `agent-default-model` pin. The key rides in `$DSH_HOME/.credentials.yaml`
  as a credential ref dsh resolves on every request (locked to 0600),
  never as a literal in the patch YAML. `off` removes exactly what
  `on` added, including from the files `on` recorded when the dsh
  home moved in between, and puts back a default it had to set aside
  because the gateway cannot serve it; one it can serve is kept, and
  your own rows survive both verbs. Pass `--model <id>` to switch;
  `--model native` is refused, since DeepSeek Harness's own default
  needs a DeepSeek key the gateway cannot serve. `aiand run-agent dsh`
  runs one session with the real `~/.dsh` config and credentials
  untouched: a throwaway `$DSH_HOME` holds the same rows and the key,
  dsh starts in its `web` profile on a terminal and answers a piped
  task headless, session history still lands in the real
  `~/.dsh/sessions`, and the overlay is removed after the session ends.
  Bare `aiand dsh` opens DeepSeek Harness the way `aiand code` does —
  wiring it with `on` when it is not wired yet, offering the npm install
  after a yes when missing, then running dsh with the args you passed (a
  profile you named stands; otherwise dsh starts in its `web` profile on a
  terminal, or headless for a piped task), and a `--patch` overlay dropped
  since it would outrank the injected routing). Each model's published
  reasoning
  levels pass through when dsh's own schema names them: GLM-5.3 offers
  low, high, and max, an omitted level runs at the engine default (max
  on GLM-5.3), and a level dsh does not name (`none`) is dropped rather
  than written, since one unmappable key would fail the whole route's
  validation and leave dsh with no route at all; the route states
  `supportsReasoningEffort: true` rather than `false`, which dropped the
  parameter. `status` probes the
  patch file itself, so a marker a dsh rewrite dropped still reads
  active while the record proves the routing ours; the same proof gates
  `off` and `refreshKey`, and rebaking swaps only the ref `on` wrote,
  keyed on the previous key. The patch reader survives the shapes a
  hand-edited `cordis.patch.yml` and dsh's own writers produce — a row's
  `id` read from any first-level key, in block or flow (`- {id: …}`)
  form, through CRLF endings, quoted scalars and comments — and refuses
  the ones it cannot prove safe with a loud error naming the file rather
  than a raw crash. A hand-written `llm-pi-ai` row carrying any user
  config (`timeoutMs`, a flow `providers:` map, anything) is refused
  instead of overwritten, and a `$DSH_HOME/profiles/<profile>` layer
  that also configures `llm-pi-ai` warns, since the home layer hides its
  providers while the aiand route is on. `off` hands a set-aside default
  back exactly as it found it — the user's own `name:`, keys and
  comments, byte for byte, no banner — never touches the blank that
  separated the user's rows or the comment above the next one, and each
  on/off cycle round-trips the file byte for byte, trailing newline
  included. A credentials file whose last ref dsh deleted (`refs: {}`,
  or a user's flow map) takes ours without a second `refs:` key, which
  dsh would refuse to boot. A rotation reads both the block and the flow
  form of the credential store, so `status`, `off` and `refreshKey` still
  agree, and a key swap never disturbs the user's own flow refs.
  (#21, thanks @fenilmodi00)

- Both one-line installers end with an agent summary: which coding-agent
  binaries (`opencode`, `claude`, `pi`, `omp`, `codex`, `copilot`, `dsh`,
  `hermes`) are on `PATH`, install hints for the missing ones, and a nudge to
  run `aiand init`. Wiring still never happens at install time. The omp hint
  picks its release asset by platform and architecture and verifies the
  download against the sha256 the release publishes. `npm ci` also passes
  `--prefer-offline`, so re-runs and updates reuse the npm cache.
  (#32, thanks @fenilmodi00)

### Changed

- `--base-url` and `aiand config set api-url|auth-url` refuse `/v1`-suffixed
  URLs (adapters append `/v1` themselves, so a suffixed URL would double to
  `/v1/v1`) and base URLs carrying a query or fragment, at set time. An
  unreachable gateway no longer echoes credentials embedded in the base URL.
  (#34, thanks @fenilmodi00)

### Fixed

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
- `install.sh` reads the staged version with `sed` instead of spawning node,
  dropping the verification path to two node spawns.
  (#32, thanks @fenilmodi00)

- The installers' agent summary and install hints can no longer drift from the
  releases the CLI pins: `scripts/check-dist.mjs` reads `install.sh` and
  `install.ps1` the same way it reads `ci.yml`, so a versioned install hint
  (e.g. `opencode-ai@`, `pi-coding-agent@`, `@github/copilot@`, the omp release
  asset and the sha256 it is verified against, the Hermes commit in both the
  `install.ps1` `irm` URL and the `-Commit` flag) that disagrees with its
  adapter's pinned version — or drops out of one installer — fails the gate
  instead of quietly telling users to install an unreviewed release. The probed
  agent list is derived from the registry, so a newly shipped agent that never
  appears in the summary fails the gate too.
  (#32, thanks @fenilmodi00)

- The installers' omp hint is checked against the adapter's own rendering,
  per platform, so each one prints a command the CLI would print on that
  machine: `scripts/check-dist.mjs` renders `install.sh`'s hint function
  under a `uname` that answers for Linux and macOS on both x64 and arm64 and
  `install.ps1`'s through PowerShell with `PROCESSOR_ARCHITECTURE` set for
  both Windows architectures. A case arm pointing at the other architecture's
  asset, a mismatched digest, or a removed `mkdir`/`chmod` fails the gate, and
  `scripts/install-behavior.mjs` compares the summary it actually prints
  against the same commands rather than one host's asset spelled by hand, so
  the macOS and Linux-arm64 cases are covered too. The agent ids both
  installers probe are read from the built registry and compared as a set,
  each installer keeping its own display order.
  (#32, thanks @fenilmodi00)

- `install.ps1` ships without a UTF-8 BOM, so `irm ... | iex` no longer
  prints `The term '#' is not recognized` and `The term 'param' is not
  recognized`: `irm` delivers the BOM as a character, which stops line 1
  from parsing as a comment and demotes the `param()` block. The wordmark is
  ASCII now, so the file parses the same whether Windows PowerShell 5.1 reads
  it as UTF-8 or ANSI, and the bold-cyan colour is reset after it instead of
  leaving every later line coloured.
  (#32, thanks @fenilmodi00)

- `aiand dsh on` refuses a hand-written `llm-pi-ai` row carrying any user
  config — not just `providers` — instead of replacing the whole row and
  deleting settings like `timeoutMs`. (#21, thanks @fenilmodi00)

- `aiand dsh on` reads a row's `id` from any first-level key of the item
  (`-\n  id: llm-pi-ai`, `- name: ...` before `id:`), so a hand-edited
  `cordis.patch.yml` in those shapes no longer makes `on` append a second
  `llm-pi-ai` row whose whole-config replace silently drops the user's
  providers. (#21, thanks @fenilmodi00)

- A flow-map `llm-pi-ai` row (`- {id: llm-pi-ai}`) is no longer invisible to
  the patch reader: a dormant one is replaced in place instead of stacked
  under a duplicate `on` appends, and a foreign one carrying `config:` (or
  `providers:`) is refused — the foreign-config check it used to bypass
  silently now runs on it. A flow row whose braces never close, or which
  names a key twice, is a loud `CliError` naming the file rather than an
  unread row. (#21, thanks @fenilmodi00)

- `aiand dsh on` warns when a `$DSH_HOME/profiles/<profile>/cordis.patch.yml`
  layer also configures `llm-pi-ai`: the home layer replaces the entry's
  whole config, so Web UI providers are hidden while the aiand route is on.
  (#21, thanks @fenilmodi00)

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

