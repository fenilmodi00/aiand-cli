# aiand-cli

The `ai&` command line interface — sign in, call models, and see what your organization
is spending, without leaving the terminal.

```
npm install -g @aiand/cli
aiand login
aiand run "explain this stack trace" < trace.txt
```
## Install with one line

Requires Node.js 22+, git, and npm. Clones into `~/.aiand/cli`, builds, and
puts `aiand` on PATH via `~/.local/bin` (re-run to update):

```bash
curl -fsSL https://raw.githubusercontent.com/aiandlabs/aiand-cli/main/install.sh | bash
aiand login
aiand init
```

Uninstall restores every aiand-routed agent first (aborting without deleting
anything if a restore fails), then removes the launcher and the checkout.
Profiles, credentials, and agent snapshots under `~/.config/aiand` are kept:

```bash
bash ~/.aiand/cli/install.sh uninstall
```

## Install from source

Requires Node.js 22+.

```bash
npm ci
npm run build
node dist/index.js --help    # or `npm link` to get `aiand` on PATH
```

## Commands

| Command | What it does |
| --- | --- |
| `aiand login` / `logout` | Start or end this machine's session |
| `aiand whoami` | Identity, organization, and key expiry |
| `aiand key export` | Print the active session key to stdout |
| `aiand <agent> on\|off\|status` | Wire a coding agent to ai& — see below |
| `aiand init` | Detect installed agents and wire them in batch |
| `aiand run-agent <agent>` | Launch an agent on ai& for one session only |
| `aiand status` | Sign-in state plus every agent's wiring |
| `aiand run <prompt>` | One prompt, streamed to stdout |
| `aiand chat` | Interactive conversation with a transcript |
| `aiand models` | The model catalog, priced in your billing currency, with a vision column |
| `aiand logs` | Recent inference requests, with `--follow` |
| `aiand usage` | Requests and tokens, against the prior window |
| `aiand orgs` | Organizations you belong to |
| `aiand config` | Profiles and defaults |

Most commands take `--json` for machine-readable output; every command takes `--help` for
its own flags.

## Agent setup

Point OpenCode at ai& without hand-copying env vars. `on` writes OpenCode's
own native config, so a stock `opencode` just works afterwards. `off`
restores the previous state byte for byte, including files that did not
exist before. `run-agent` is the one-session launcher: it injects routing
into one process's environment without persistent config.
```bash
aiand opencode on        # provider entry in ~/.config/opencode/opencode.json
aiand opencode status    # ground truth from the agent's real config files
aiand opencode off       # byte-for-byte restore of whatever was there before
aiand init               # detect the installed agent, ask whether to wire it
aiand run-agent opencode -- …  # one-session launch
aiand status             # who is signed in, where the key lives, whether opencode is on
```

The baked key comes from the active session (`--profile` honored), and the
model default resolves from the live `/v1/models` catalog, so a retired
model id is never written. `on` preserves unrelated providers already in
the config and stamps its block with an `x-aiand` ownership marker, so
`off` strips only what aiand wrote. Snapshots of the pre-existing config
live under `~/.config/aiand/backups/` and are removed by `off`.
Pass `native` as `--model` to leave the model unpinned so the agent's own
default wins.

## Signing in

`aiand login` opens your browser and signs in there by default. Approving
mints an **organization-scoped API key for this machine** — the same kind of
`sk-` key the console issues — labeled `aiand@<hostname>` so the console key
list names the machine. A probe of `GET /auth/authorize` runs first: 404/501
means the gateway has no browser flow, and the CLI continues with a device
code instead. A recoverable browser failure (timeout, port in use, rejected
exchange — not a browser-side cancel or Ctrl-C) falls back to a device code
too; when no browser opener is available the CLI prints the authorization
URL and waits for the callback.
Non-interactive runs skip the browser and use a device code directly:

```
  Your code   BCDF-GHJK
  Approve at  https://api.aiand.com/auth/device?user_code=BCDF-GHJK
```

Already have a key from the console? Paste or pipe it instead:

```bash
aiand login --paste                # masked prompt
aiand login --with-token < key.txt # CI: read one line from stdin
```

A pasted key is validated against the API, stored with `origin: paste`, and never
revoked by `aiand logout` — this CLI did not mint it, so it only clears the local copy.
Device-login keys are offered a server-side revoke instead, which posts the stored
refresh token to the gateway and is skipped when the credential has none.

```
$ aiand login

Signed in.

email    you@example.com
org      Acme (org_1a2b…)
profile  default
key      sk-abcd…wxyz
```

The secret lives in the best available storage tier — the OS keychain, an AES-256-GCM
encrypted file under `~/.config/aiand/`, or (only when asked for via
`AIAND_KEY_STORAGE=plaintext`) a `0600` plaintext file. `credentials.json` keeps only
metadata, and older all-in-one credentials are migrated automatically. The key lives for
30 days and is rotated automatically when a command runs inside the last 3 days of its
life — or immediately if the server rejects it. `aiand status` reports which tier holds
the secret. The file tier keeps its `secret-store.key` next to `secret-store.json`: it is
defence-in-depth against a casual read, not encryption-at-rest against anyone who can
read the config dir.

For CI and scripts, skip the login entirely and set `AIAND_API_KEY`. Nothing is written to
disk in that mode.

`aiand key export` prints the active session key raw, for piping into another tool.

### run

```bash
aiand run "why is the sky blue?"
cat main.ts | aiand run "review this file"
aiand run -m deepseek-ai/deepseek-v4-flash --system "be terse" "summarize CAP theorem"
aiand run --no-stream --json "hello" | jq .usage
```

Piped stdin is appended to the prompt, so a file can be passed as context. Answers go to
stdout and everything else to stderr, so `aiand run … > out.md` captures only the answer.

The dim footer after each answer reports the resolved model, token counts, cost, and
request ID — read from response headers rather than the body, which stays in its
OpenAI-compatible shape:

```
deepseek-ai/deepseek-v4-flash  ·  9 in / 21 out  ·  0.00000660 USD  ·  181ms  ·  919a9aa4…
```

Cost and timing are opt-in server-side; the server typically returns them on non-streaming
responses, so `--no-stream` shows more of the footer than a stream does. Pass `-q` to drop
it entirely.

If a response comes back with no content — a reasoning model can spend its whole token
budget thinking — the CLI says why rather than printing a blank line:

```
No content. The token budget was spent reasoning (40 reasoning tokens) before any answer
was written. Raise --max-tokens, or pick a model that reasons more briefly.
```

Model `auto` lets ai& choose per request, and the choice appears in the footer. Where it
is not enabled for an account, name a model with `-m` or set a default with
`aiand config set model <id>`.

### logs and usage

```bash
aiand logs --range 1h --errors     # only non-2xx
aiand logs --follow                # tail new requests
aiand usage --range 30days
aiand usage --metrics              # full metric breakdown
```

Both are organization-scoped, so they show every key's traffic, not just this machine's.

## Configuration

Settings live in `~/.config/aiand/config.json`; credentials are kept apart in
`credentials.json` so the config file stays shareable.

```bash
aiand config                                     # resolved settings
aiand config set model deepseek-ai/deepseek-v4-flash
aiand config profiles                            # list, with sign-in state
aiand config use work                            # switch profile
aiand config path                                # where the files are
```

Profiles keep separate credentials, so `--profile work` and `--profile personal` can be
signed into different organizations at once.

The API endpoint defaults to `https://api.aiand.com`. To point the CLI elsewhere, pass
`--base-url` for one command, set `AIAND_BASE_URL`, or store it on a profile — base URLs
must be `https`, except `http` on loopback for local testing:

```bash
aiand config set api-url http://127.0.0.1:8080
aiand config set auth-url http://127.0.0.1:8080
```

### Environment variables

| Variable | Effect |
| --- | --- |
| `AIAND_API_KEY` | Use this key directly; no login, nothing stored |
| `AIAND_BASE_URL` | Override both base URLs |
| `AIAND_AUTH_URL` | Override the sign-in base URL only |
| `AIAND_PROFILE` | Profile to use |
| `AIAND_CONFIG_DIR` | Where config and credentials live |
| `AIAND_HOME` | Home directory agents resolve their config from |
| `AIAND_KEY_STORAGE` | Force the secret tier: `keychain`, `file`, or `plaintext` |
| `AIAND_SECRET_STORE_MASTER_KEY` | 64 hex chars; overrides the encrypted-file master key |
| `AIAND_UPDATE_CHECK` | Set to `0` to disable the update notice |
| `NO_UPDATE_CHECK` | Set to `1` to disable the update notice |
| `NO_COLOR` | Disable color |

Precedence is flags, then environment variables, then the stored profile.

Once a day on a TTY the CLI prints an update tip when npm carries a newer `@aiand/cli`, plus what's-new lines after a version change.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Request or usage error (the message says which); `aiand status` uses it for "not signed in" |
| `2` | Not signed in, or the session could not be refreshed |
| `3` | Login denied in the browser |
| `70` | A bug in the CLI — the stack trace is printed |
| `127` | Unknown command or missing agent binary |
| `130` | Interrupted (e.g. Ctrl-C during `run` / `login`) |

`aiand status` is the exception: it exits 0 when signed in or when the gateway
cannot be reached to verify the key (`reachable: false` in `--json`), and 1
only when the profile is signed out — so scripts gating on it do not
false-fail during an outage.

## Contributing

```bash
npm ci
npm run lint         # tsc --noEmit
npm test             # node:test, no test framework needed
npm run build
npm run check:dist   # asserts on the built binary
npm run check:public # repository hygiene checks
node scripts/e2e.mjs   # agent-adapter changes
```

### Sandbox E2E (full matrix, live gateway)

Every command and every adapter against the real gateway, inside a
disposable sandbox so no local dotfile is touched — the production-credit
phase of testing. The harness `scripts/sbx-test.mjs` is provider-agnostic
(any Linux box, Node ≥ 22.5, zero npm dependencies); the contract is: copy
`dist` + `package.json` + `scripts/sbx-test.mjs` in, run
`node scripts/sbx-test.mjs <cli.js>` with `AIAND_API_KEY` set, throw the
box away. State stays under `/tmp/aiand-sbx`; the host home is never
touched.

- Covers sign-in, `run`/`models`/`logs`/`usage`/`orgs`, `config`, `login
  --paste`, the opencode adapter's `on`/`off`/`status` with byte-for-byte
  snapshot restore, `init` batch, and the `run-agent` launcher.
- Full run spends a few cents of production credit at most. Offline subset,
  no key or network needed, safe anywhere:
  `node scripts/sbx-test.mjs --smoke`.
- `node scripts/sbx-test.mjs --plan` lists the planned checks and exits.

Pick a provider:

```bash
npm run build
export AIAND_API_KEY=sk-…   # a real key; spends a few cents at most
```

- Docker: `docker run --rm -e AIAND_API_KEY -v "$PWD:/work" -w /work
  node:22-slim node scripts/sbx-test.mjs dist/index.js`
- ConTree (disposable microVM, tagged `aiand-sbx:base` / `:e2e` images):
  `scripts/contree-e2e.sh` (needs `contree auth`).
- Daytona / other: `daytona sandbox create`, copy the three payload paths
  in, run the same `node` command, `daytona sandbox delete` after.
- Bare metal (a throwaway Linux box): run the `node` command directly.

All of these run in CI. Issues and pull requests are welcome.

## Roadmap

Sign-in, inference, observability, and opencode agent setup ship
today.
- **Files** — uploads for vision, video, audio, and document inputs
- **Billing** — balance, history, auto-recharge, redemption codes
- **Video** — asynchronous generation jobs

## License

Apache-2.0
