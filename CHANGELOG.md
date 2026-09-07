# Changelog

All notable changes to this project will be documented in this file.

Versioning follows semver, with the caveat that before `1.0` a minor version may include
breaking changes while the command surface settles.

## [Unreleased]

### Added

- Agent setup for Cursor, pi, VS Code, DeepSeek Harness, and Prime: each adapter
  writes native config (or an aiand-owned sidecar for Prime) so the stock binary
  routes to ai&. Hermes and Grok are launcher-only (`aiand run-agent`); `on`
  points at that path instead of writing a permanent home.
- ChatGPT Desktop and IDE quit-guards: refuse `codex`/`cursor`/`vscode` writes
  while the owning app holds config in memory; `--force` escapes.
- Agent setup for OpenCode: `aiand opencode on` writes the `aiand` provider
  (key literal, `@ai-sdk/openai-compatible` adapter) into
  `~/.config/opencode/opencode.json`, with the model entries taken verbatim
  from the live `/v1/api.json` catalog. `enabled_providers` locks the picker
  to ai& and the Zen gateway (`opencode` id) is disabled to cut clutter.
  `off` restores the file byte for byte.
- `aiand run-agent <agent> [--model <id>] [--] [args…]` — launch a stock
  agent binary on ai& for one session only: routing and the session key are
  injected into that process's environment, nothing is written to disk, and
  the agent's own exit status is propagated. Works without a prior `on`.
- `aiand init` polish: the interactive picker lists not-installed agents with
  their install commands below the detected ones, and a non-interactive bare
  `aiand init` with nothing detected says so instead of printing an empty
  agent list. `aiand init --off <agent>` is the same as
  `aiand <agent> off`.

### Added

- Agent setup for Claude Code and Codex: `aiand <agent> on|off|status` writes
  the agent's own native config so the stock binary runs against ai& — no
  daemon, no proxy. `on` snapshots the pre-existing config first and `off`
  restores it byte for byte, including files that did not exist.
  `chatgpt` is an alias for `codex` (both share `~/.codex/config.toml`).
- `aiand init` — detect installed agents and wire the chosen subset
  (`--all`, `--off`, interactive picker); detection never installs anything,
  it prints the official install command instead.
- `aiand status` — sign-in state, key source, storage tier, and every
  registered agent's on/off/foreign state from its real config files.
- `aiand login --paste` / `--api-key` / `--with-token` — sign in with an
  existing console key (validated against the API before storing). Pasted
  keys are never revoked by `aiand logout`; device-minted keys are.
- Tiered secret storage: OS keychain when usable, otherwise an AES-256-GCM
  encrypted file under the config dir, plaintext only via explicit
  `AIAND_KEY_STORAGE=plaintext`. `credentials.json` now holds metadata and
  migrates legacy shapes automatically.
- Model defaults and Claude's opus/sonnet/haiku slots resolve from the live
  `/v1/models` catalog (6h-cached, stale-when-offline), so retired model ids
  are never written into agent config. `--model`, `--opus`, `--sonnet`,
  `--haiku` override per `on`.
- Foreign-writer detection: `on` refuses to overwrite a config another tool
  manages, unless `--force` is passed.

### Changed

- `aiand logout` asks before revoking a device-minted key on a TTY
  (`--revoke` / `--keep-remote` to skip the question); non-interactive use
  keeps today's default-revoke behavior.
- `aiand whoami` reports the key source (`device-login`, `pasted-key`,
  `AIAND_API_KEY`) and the active storage tier.
- Exit code `127` now also covers a missing agent binary (with its install
  hint), not just unknown commands.

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
