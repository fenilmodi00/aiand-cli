# Changelog

All notable changes to this project will be documented in this file.

Versioning follows semver, with the caveat that before `1.0` a minor version may include
breaking changes while the command surface settles.

## [Unreleased]

## [0.4.0] - 2026-09-29

### Added

- `aiand pi on` wires the Pi coding agent to ai& through
  `~/.pi/agent/`: an `aiand` provider in `models.json` speaking the gateway's
  OpenAI-compatible dialect with every model from the live catalog, the
  session key in `auth.json` (locked to 0600, marked `managedBy: "aiand"`),
  and `defaultProvider`/`defaultModel` in `settings.json`. `off` removes
  exactly what `on` added and restores a `defaultModel` it had to set aside
  because the gateway cannot serve it; one it can serve is kept. Pass
  `--model native` to leave Pi's own default model. Reasoning models run at
  their gateway default effort: Pi's client would otherwise send an effort
  level (`medium`) the catalog does not publish for every model, and the
  gateway rejects it.

- `aiand run-agent pi` launches Pi on ai& for one session with no Pi config
  written under `~/.pi/`: a throwaway overlay becomes
  `PI_CODING_AGENT_DIR` holding the generated provider and the session key
  (never the child env), while session history still lands in the user's
  real session directory. User-supplied `--provider`/`--model`/`--models`/
  `--api-key` passthrough flags are stripped so the routing cannot be
  overridden; the overlay is removed after the session ends.

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
