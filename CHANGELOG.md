# Changelog

All notable changes to this project will be documented in this file.

Versioning follows semver, with the caveat that before `1.0` a minor version may include
breaking changes while the command surface settles.

## [0.2.0] - 2026-09-17

### Changed

- Subtractive `off`: `aiand <agent> off` removes exactly what aiand added
  and keeps the user's own edits. It never replays the pre-aiand snapshot —
  that is break-glass `aiand restore <agent> --force` (refused without
  `--force`). `restore` only copies or deletes paths in the adapter's
  managed files, and only from inside that agent's snapshot directory.
- `opencode on` no longer writes `enabled_providers` / `disabled_providers`
  into `opencode.json` — hiding the user's other providers was hostile. The
  provider lockdown stays on `run-agent` only, where the one-run inline
  config is thrown away with the process.
- `opencode on` sets a root `model` only when the file has none, or when
  `--model` is passed (not `native`). `off` strips what we added; a
  `provider.aiand` block or model the user edited is left in place, and
  `off` says so. A config file we created is deleted when nothing else
  remains; a user-created file is not.
- `aiand init` honors `--profile` (same as the per-agent verbs) for batch
  wiring, interactive wiring, and `--all`.
- `aiand status` distinguishes three auth states: signed in (exit 0),
  not signed in (exit 1), and gateway unreachable (exit 0 with a distinct
  `reachable: false` field in `--json`), so scripts gating on the exit code
  no longer false-fail during an outage. `--json` gains the `reachable`
  field; `whoami` still fails loudly on an unreachable gateway.

### Added

- Uninstall: `bash install.sh uninstall` turns every aiand-routed agent
  `off` first (aborting before deleting anything when off fails, so
  snapshots stay retryable), then removes the launcher and the `~/.aiand/cli`
  checkout. Profiles, credentials, and snapshots under `~/.config/aiand` are
  intentionally kept. `--force` (or `AIAND_UNINSTALL_FORCE=1`) skips the
  agent teardown for broken installs; the removal target is canonicalized and
  refused unless it sits strictly inside HOME.
- Flag did-you-mean: a mistyped flag now prints `Did you mean --profile?`
  alongside the parse error, using the same nearest-match threshold as
  unknown-command suggestions.
- Mock-gateway test harness: a loopback-only HTTP double
  (`test/mock-gateway.mjs`) drives the built CLI against scripted 429
  (Retry-After), 401-refresh-then-200, and happy-path identity responses, so
  the API client's error paths have direct coverage without the live gateway.
- CI now smoke-tests `install.sh` itself: the installer job runs the real
  script into an isolated HOME from the checkout copy and asserts the
  launcher reports the PR's version.

- Sandbox E2E harness `scripts/sbx-test.mjs`: the full command matrix
  against the live gateway in an isolated VM, with an offline
  `--smoke` subset and a `--plan` mode that lists the matrix without running
  it. Host driver `scripts/contree-e2e.sh` orchestrates the ConTree microVM:
  disposable runs, tagged images `aiand-sbx:base` and `aiand-sbx:e2e`.

### Fixed

- Piped stdin is honored no matter how the parent provides it. `readStdin`
  only accepted FIFOs and files, so a caller that spawns the CLI with
  socketpair stdio (notably Node's own `child_process`, whose pipes are
  AF_UNIX sockets) had its piped context silently dropped by `run` and its
  key rejected by `login --with-token`. Sockets are accepted now.

- `run-agent --base-url` goes through the same https-or-loopback check as
  every other command, before any session or catalog work (`--help` still
  wins over a bad URL).
- Ownership Marker: `opencode on` stamps `x-aiand: true` in `opencode.json`,
  and probe/disable/refreshKey treat a config as ours only when the marker
  is present (plus an `sk-` key and https/loopback URL). Marker-only — no
  prod-URL legacy path. A foreign provider named `aiand` can no longer read
  active and be deleted by `off` or `logout`.
- `opencode.json` reads accept JSONC: OpenCode documents comments and
  trailing commas for the file, so a commented config no longer blocks
  `on`/`status`. Trailing-comma stripping is string-aware (a `,}` inside a
  string value is preserved).
- Atomic writes follow symlinks instead of replacing them: dotfile-managed
  configs (stow/chezmoi) keep their link through `on`/`off`.
- `run-agent` scrubs `AIAND_API_KEY` from the child environment — the
  adapter's own injection carries the key, so a leaked env var would hand
  it to every process the agent spawns.
- Profile names are validated at the trust boundary: `__proto__` and other
  prototype keys can no longer silently drop credential metadata.
- The plaintext secret store rides the atomic writer, and
  `AIAND_SECRET_STORE_MASTER_KEY` is validated as 64 hex characters rather
  than 64 characters of anything.

- macOS keychain writes no longer put the secret in the child's argv: the
  command rides `security -i` stdin, counts only when the readback matches
  byte-for-byte, and falls back to the argv form otherwise — never worse
  than before, invisible to `ps` whenever interactive mode takes.


### Added

- Browser sign-in as the default interactive login: `aiand login` on a
  terminal opens the browser at the gateway's authorize page and catches the
  redirect on a loopback port (authorization-code + PKCE). Multi-org accounts
  pick their organization with an arrow-key prompt; minted keys are labeled
  `aiand@<hostname>` so the console key list names the machine. A probe of
  `GET /auth/authorize` runs first: 404/501 means the gateway has no browser
  flow and the CLI silently uses the device-code flow; any other answer
  attempts the browser.

- Device sign-in degrades to key paste: when the device flow fails for
  infrastructure reasons (service unreachable, HTTP error, code expired
  before approval) an interactive `aiand login` prints the reason and
  falls through to the masked paste prompt instead of dead-ending.
  User cancellations (Ctrl-C, deny in the browser) and non-interactive
  runs (CI, pipes, `--json`) keep the original error.

### Removed

- `aiand login --api-key <sk-...>`: one of the paste flags for the same
  flow (`--paste` prompts masked, `--with-token` reads stdin). Piped keys
  keep working via `--with-token`; programmatic callers use `pasteLogin({ key })`.

- `aiand login --no-browser` and the SSH/WSL browser-detection machinery
  (`isRemoteContext`, clipboard copy of the approval URL, `openBrowserAware`).
  The CLI now just tries the platform opener; when none exists (bare WSL, SSH)
  it prints the URL. In WSL the Windows browser opens `localhost` callbacks
  natively, so detection only ever disabled a flow that worked. The
  non-interactive device path remains the automatic fallback when no TTY is
  present.

### Fixed

- `publicRequest` silently dropped the request body, so every device-API
  POST (device code, token poll, refresh, revoke) shipped an empty body.
  The body is now forwarded with the JSON content-type; stub-server auth
  tests assert the wire bytes.

### Changed

- Banner replaced with the `ai&` ASCII wordmark (solid block letters with
  shaded edges) and the "Wire any agent" tagline removed from the banner;
  `aiand banner`, `help`, and `--help` now print the wordmark and the version
  line only.
- Internal restructuring: sign-in flows moved to a new
  `src/auth/` module (device login, paste validation, logout, auth status) so
  commands only route and print; the launch-time version/update checks moved
  from `src/system/` to `src/housekeeping/`; atomic writes and config paths
  consolidated into one `src/fsutil.ts`; adapter modules renamed to the
  domain glossary (`engine`→`setup`, `sync`→`rebake`); shared managed-file reading
  (read-or-empty, JSON error hints, idempotency check) extracted to
  `src/agents/managed-file.ts`; the terminal styling layer collapsed to one
  color policy in `src/cli/ui/color.ts` with dead duplicate modules deleted.
  Foreign-tool detection was dropped in the same pass — a behavior change,
  not a move: `status` reports on/off only and no longer reports foreign
  writers, and `on` no longer refuses a config another tool manages.

### Added

- Key rebake on sign-in: storing a new credential (device login or paste)
  swaps the key literal into the active OpenCode config in one pass, so
  rotation takes effect without re-running `aiand opencode on`.
- `aiand init` uses an arrow-key space-to-toggle checkbox picker over the
  detected agents instead of a typed number list.
- Update-available notice: once a day, on an interactive terminal only, the
  CLI compares its version against the npm registry and prints a dim one-line
  tip when a newer release exists. Disable with `AIAND_UPDATE_CHECK=0` or
  `NO_UPDATE_CHECK=1`; never runs under `CI`.
- Version-change housekeeping: after an upgrade, the CLI prints up to four
  "what's new" lines from the changelog for the new version (interactive
  terminals only), backed by a best-effort forward-migration runner for
  future config-shape changes.

- `aiand key export` — print the active session key to stdout (env key,
  stored credential, or interactive sign-in), for piping into tools that
  want the raw key. `--profile` honored.
- `aiand models` shows a Vision column (`vision` / `text-only`) after the
  context window; `--json` remains the raw catalog.

- Agent setup for OpenCode: `aiand opencode on` writes the `aiand` provider
  (key literal, `@ai-sdk/openai-compatible` adapter) into
  `~/.config/opencode/opencode.json`, with the model entries taken verbatim
  from the live `/v1/api.json` catalog. `enabled_providers` locks the picker
  to ai& and the Zen gateway (`opencode` id) is disabled to cut clutter.
  `off` restores the file byte for byte.
- `aiand run-agent opencode [--model <id>] [--] [args…]` — launch the stock
  agent binary on ai& for one session only: routing and the session key are
  injected into that process's environment, nothing is written to disk, and
  the agent's own exit status is propagated. Works without a prior `on`.
- `aiand init` polish: the interactive picker lists not-installed agents with
  their install commands below the detected ones, and a non-interactive bare
  `aiand init` with nothing detected says so instead of printing an empty
  agent list. `aiand init --off <agent>` is the same as
  `aiand <agent> off`.

- `aiand init` — detect installed agents and wire the chosen subset
  (`--all`, `--off`, interactive picker); detection never installs anything,
  it prints the official install command instead.
- `aiand status` — sign-in state, key source, storage tier, and every
  registered agent's on/off state from its real config files.
- `aiand login --paste` / `--with-token` — sign in with an
  existing console key (validated against the API before storing). Pasted
  keys are never revoked by `aiand logout`; device-minted keys are.
  Multi-org accounts pick their organization the same way a minted
  sign-in does.
- Tiered secret storage: OS keychain when usable, otherwise an AES-256-GCM
  encrypted file under the config dir, plaintext only via explicit
  `AIAND_KEY_STORAGE=plaintext`. `credentials.json` now holds metadata and
  migrates legacy shapes automatically.
- Model defaults resolve from the live `/v1/models` catalog (6h-cached,
  stale-when-offline), so retired model ids are never written into agent
  config. `--model` overrides per `on`.

### Changed

- `aiand logout` asks before revoking a device-minted key on a TTY
  (`--revoke` / `--keep-remote` to skip the question); non-interactive use
  defaults to revoking. The revoke call posts only the stored refresh token
  to the gateway, and is skipped entirely when the credential has none —
  the key is cleared locally only.
- `aiand whoami` reports the key source (`device-login`, `pasted-key`,
  `AIAND_API_KEY`) and the active storage tier.
- Exit code `127` now also covers a missing agent binary (with its install
  hint), not just unknown commands.
- `aiand login` under `AIAND_API_KEY` is a CI short-circuit: it notes that
  the env key takes precedence and exits, storing nothing and starting no
  sign-in flow.
- `--base-url` (and the profile API URL) now feeds the catalog and OpenCode
  model-map fetches behind `opencode on`, so a pointed install resolves models
  from that endpoint; `run-agent` resolves its catalog the same way.

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
