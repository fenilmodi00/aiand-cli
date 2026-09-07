# aiand-cli

The `ai&` command line interface — sign in, call models, and see what your organization
is spending, without leaving the terminal.

```
npm install -g @aiand/cli
aiand login
aiand run "explain this stack trace" < trace.txt
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
| `aiand <agent> on\|off\|status` | Wire a coding agent to ai& — see below |
| `aiand init` | Detect installed agents and wire them in batch |
| `aiand status` | Sign-in state plus every agent's wiring |
| `aiand run <prompt>` | One prompt, streamed to stdout |
| `aiand chat` | Interactive conversation with a transcript |
| `aiand models` | The model catalog, priced in your billing currency |
| `aiand logs` | Recent inference requests, with `--follow` |
| `aiand usage` | Requests and tokens, against the prior window |
| `aiand orgs` | Organizations you belong to |
| `aiand config` | Profiles and defaults |

Every command takes `--json` for machine-readable output and `--help` for its own flags.

## Agent setup

Point a local coding agent at ai& without hand-copying env vars. `on` writes the agent's
own native config — a stock `claude` or `codex` binary just works afterwards — and `off`
restores the previous state byte for byte, including files that did not exist before.

```bash
aiand claude on          # writes ~/.claude/settings.json with the ai& env block
aiand claude status      # ground truth from the agent's real config files
aiand claude off         # byte-for-byte restore of whatever was there before
aiand codex on           # ~/.codex/config.toml + model catalog; chatgpt is an alias
aiand claude --model moonshotai/kimi-k3 --opus zai-org/glm-5.3
aiand init               # detect installed agents, ask which to wire
aiand status             # who is signed in, where the key lives, which agents are on
```

The baked key comes from the active session (`--profile` honored), and model defaults and
Claude's opus/sonnet/haiku slots resolve from the live `/v1/models` catalog, so a retired
model id is never written. `on` refuses to touch a config another tool manages — pass
`--force` to overwrite it. Snapshots of the pre-existing config live under
`~/.config/aiand/backups/` and are removed by `off`.

## Signing in

`aiand login` uses the OAuth 2.0 device authorization grant. The CLI prints a short code
and opens your browser; approving there mints an **organization-scoped API key for this
machine** — the same kind of `sk-` key the console issues.

Already have a key from the console? Paste or pipe it instead:

```bash
aiand login --paste          # masked prompt
aiand login --api-key sk-…   # as an argument
aiand login --with-token < key.txt   # CI: read one line from stdin
```

A pasted key is validated against the API, stored with `origin: paste`, and never
revoked by `aiand logout` — this CLI did not mint it, so it only clears the local copy.
Device-login keys are offered a server-side revoke instead.

```
$ aiand login

  Your code   BCDF-GHJK
  Approve at  https://api.aiand.com/auth/device?user_code=BCDF-GHJK

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
the secret.

For CI and scripts, skip the login entirely and set `AIAND_API_KEY`. Nothing is written to
disk in that mode.

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

Cost and timing are opt-in server-side and only sent on non-streaming responses, so
`--no-stream` shows more of the footer than a stream does. Pass `-q` to drop it entirely.

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
`--base-url` for one command, set `AIAND_BASE_URL`, or store it on a profile:

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
| `NO_COLOR` | Disable color |

Precedence is flags, then environment variables, then the stored profile.


## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Request or usage error (the message says which) |
| `2` | Not signed in, or the session could not be refreshed |
| `3` | Login denied in the browser |
| `70` | A bug in the CLI — the stack trace is printed |
| `127` | Unknown command or missing agent binary |
| `130` | Interrupted |

## Contributing

```bash
npm ci
npm run lint         # tsc --noEmit
npm test             # node:test, no test framework needed
npm run build
npm run check:dist   # asserts on the built binary
npm run check:public # repository hygiene checks
```

All of these run in CI. Issues and pull requests are welcome.

## Roadmap

Sign-in, inference, observability, and agent setup for Claude Code and Codex ship today.
More agents (opencode, pi, cursor, vscode, …) and the remaining surface are next:

- **Files** — uploads for vision, video, audio, and document inputs
- **Billing** — balance, history, auto-recharge, redemption codes
- **Video** — asynchronous generation jobs

## License

Apache-2.0
