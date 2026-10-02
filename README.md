<img src="docs/assets/aiand-cli-logo.svg" alt="ai&amp; CLI logo" width="480">

**Less setup. More building.**

Connect the tools you love to ai& inference. ai& CLI handles sign-in and
configuration, so you can get straight to building.

- **Sign in through your browser.** Get started without copying API keys.
- **Keep your settings.** Connect OpenCode while preserving your existing providers and chosen model.
- **See models and prices.** Explore the catalog in your billing currency.

## Quick start
```bash
npm install -g @aiand/cli  # Requires Node.js 22 or newer.
aiand login                # Sign in through your browser
aiand opencode on          # Add ai& to OpenCode
opencode
```

Prefer a quick prompt?

```bash
git diff | aiand run "Review this diff. Be ruthless."
```

## Install

Requires Node.js 22 or newer.

```bash
npm install -g @aiand/cli
```
or:

```bash
curl -fsSL https://raw.githubusercontent.com/aiandlabs/aiand-cli/main/install.sh | bash
```

```powershell
irm https://raw.githubusercontent.com/aiandlabs/aiand-cli/main/install.ps1 | iex
```

The installer will modify your shell, `AIAND_NO_MODIFY_PATH=1` to skip permanent PATH changes while still adding the CLI to the installer's process PATH.

To update the CLI, run the install command again.

To uninstall a copy from the installer:

```bash
bash ~/.aiand/cli/install.sh uninstall
```

```powershell
& "$env:USERPROFILE\.aiand\cli\install.ps1" uninstall
```

Uninstall turns off every agent aiand wired, then removes the CLI. Your
profiles and credentials under `~/.config/aiand` are kept. For an npm install,
run `aiand init --off` first, then `npm uninstall -g @aiand/cli`.


## Commands

| Command | What it does |
| --- | --- |
| `aiand login` / `logout` | Start or end this machine's session |
| `aiand whoami` | Identity, organization, and key expiry |
| `aiand status` | Sign-in state plus every agent's wiring |
| `aiand <agent> on\|off\|status` | Wire a coding agent to ai&, or unwire it |
| `aiand init` | Detect installed agents and wire them in one go |
| `aiand run-agent <agent>` | Run an agent on ai& for one session only |
| `aiand restore <agent> --force` | Put an agent's config back as it was before aiand |
| `aiand run <prompt>` | One prompt, streamed to stdout |
| `aiand chat` | Interactive conversation |
| `aiand models` | The model catalog, with prices in your billing currency |
| `aiand logs` | Recent requests, with `--follow` |
| `aiand usage` | Requests and tokens, compared with the previous period |
| `aiand orgs` | Organizations you belong to |
| `aiand config` | Profiles and defaults |
| `aiand key export` | Print the active key, for piping into another tool |

Most commands take `--json`, and every command takes `--help`.

## Coding agents

aiand currently supports [OpenCode](https://opencode.ai),
[Claude Code](https://code.claude.com/docs),
[Codex](https://developers.openai.com/codex/cli) and
[CodeAF](https://agentfield.ai/docs/codeaf).

```bash
aiand opencode on        # route OpenCode through ai&
aiand opencode status    # check what OpenCode is actually configured to use
aiand opencode off       # remove exactly what aiand added
aiand run-agent opencode # or: use ai& for this one session, change nothing
```

`on` adds an `aiand` provider to `~/.config/opencode/opencode.json`, with the
models from the live catalog, so plain `opencode` uses ai& afterwards. Your
other providers and your own edits are left alone. If you already chose a
model it stays chosen; pass `--model <id>` to switch, or `--model native` to
keep OpenCode's own default.

`off` removes only what aiand wrote. If a config ever ends up in a state you
do not want, `aiand restore opencode --force` puts back the exact file from
before aiand first touched it.

```bash
aiand claude on          # route Claude Code through ai&
aiand claude status
aiand claude off
aiand run-agent claude   # launch Claude Code on ai&, nothing written
```

`on` writes an `env` block into `~/.claude/settings.json` (or
`$CLAUDE_CONFIG_DIR/settings.json`): the gateway URL, your key, and a catalog
model for every slot. The main slots get a vision model unless your profile
names a model; background work (the `haiku` slot) gets a fast one. Pass
`--model <id>` to switch the main slots. A `model` setting ai& cannot serve is
set aside until `off`; one it can serve is kept, and Claude Code starts on it.
Claude Code's context budget is capped at 200k tokens, so long sessions
compact before open models start to degrade (a model shown with a `[1m]`
suffix is sized the same way). Claude Code's attribution header is turned off,
since ai& would otherwise pass it to the model as prompt text. `/model` lists
every ai& model: Claude Code only discovers gateway models whose id contains
"claude", so `on` writes them into its `modelPicker` setting, replacing the
built-in Opus, Sonnet and Haiku rows (a `modelPicker` of your own is kept). The Bedrock, Vertex
and Foundry switches are written as `0`, so one left on elsewhere cannot route
Claude Code away from ai&. WebSearch is denied because it runs on Anthropic's
servers; WebFetch still works. The key sits in that file while Claude Code is
wired, so keep it out of a dotfiles repo, and Claude Code passes it to every
command and hook it runs, as it does every `env` value. A project's own `.claude/settings.json`
can override these values. `/effort` is sent to ai& as the model's reasoning
level, so pick one the model publishes: `moonshotai/kimi-k3` takes `low`,
`high` and `max`, and any other level is rejected.

```bash
aiand codex on           # write an ai& profile for Codex
codex --profile aiand    # then start Codex on ai&
aiand codex status
aiand codex off
aiand run-agent codex    # launch Codex on ai&, nothing written
```

`on` writes a separate profile, `~/.codex/aiand.config.toml` (or
`$CODEX_HOME/aiand.config.toml`), and leaves your `config.toml` alone, so plain
`codex` keeps your usual setup and `codex --profile aiand` uses ai&. The profile
never holds your key: Codex runs `aiand key export` for your active aiand
profile, so a rotation or `aiand config use` needs nothing (`on --profile
<name>` pins another profile instead). It pins a reasoning level the model
publishes, for Plan Mode too, and turns off Codex's hosted tools (web search,
image generation and the like), which ai& does not run. A model or
level you pick in Codex's `/model` stays across another `on`; pass
`--model <id>` to switch. Settings of your own in the profile survive `on` and
`off`. `on` refuses a profile that already routes Codex elsewhere; `--force`
takes it over, and `aiand restore codex --force` brings the old one back. Your `config.toml` still loads under the profile, so its MCP servers and
plugins come along. Which Codex versions work with ai&, and what changed
between them, is in the
[Codex guide](https://docs.aiand.com/integrations/codex/).

```bash
aiand codeaf on          # add an ai& connection to CodeAF
aiand codeaf status      # check what CodeAF is actually configured to use
aiand codeaf off         # remove exactly what aiand added
aiand run-agent codeaf   # launch CodeAF on ai&, nothing written
```

`on` adds an `aiand` connection to `~/.codeaf/config.json` (or
`$CODEAF_HOME/config.json`), with the session key and a model pin, so
plain `codeaf` uses ai& afterwards. Your other settings and connections
are left alone. If you already chose a model it stays chosen; pass
`--model <id>` to switch, or `--model native` to keep CodeAF's own
default. The key sits in that file while CodeAF is wired, so keep it out
of a dotfiles repo. `on` refuses a config that already routes CodeAF
somewhere ai& does not manage; `--force` takes it over.

`off` removes only what aiand wrote. If a config ever ends up in a state
you do not want, `aiand restore codeaf --force` puts back the exact file
from before aiand first touched it. `aiand run-agent codeaf` launches
CodeAF on ai& for one session, writing nothing; `aiand run-agent codeaf
-- chat --once "…"` is the one-shot door.

When your key rotates, aiand updates the agents it wired, so they keep working
without another `on`.

## Signing in

`aiand login` opens your browser. Approving creates an API key for your
organization, labeled `aiand@<hostname>` so you can tell your machines apart
in the console. If the browser sign-in cannot finish (no browser, a timeout, or
a script with no terminal), aiand switches to a code you approve from any
device:

```
  Your code   BCDF-GHJK
  Approve at  https://api.aiand.com/auth/device?user_code=BCDF-GHJK
```

Already have a key from the console?

```bash
aiand login --paste                # masked prompt
aiand login --with-token < key.txt # read it from stdin
```

`aiand logout` offers to revoke a key that `login` created. A key you pasted in
is only removed from this machine; revoke it in the console.

**Where the key lives.** The OS keychain when there is one, otherwise an
encrypted file under `~/.config/aiand/`. The encrypted file keeps its key right
next to it, so it guards against a casual look, not against anyone who can
read that directory. `AIAND_KEY_STORAGE=plaintext` stores it as a plain
owner-only file if you ask for that. `aiand status` shows which one you have.

Keys last 30 days and rotate automatically during their last 3 days, or right
away if the server rejects one.

**CI and scripts:** skip `login` and set `AIAND_API_KEY`. Nothing is written to
disk.

## Running prompts

```bash
aiand run "why is the sky blue?"
cat main.ts | aiand run "review this file"
aiand run -m deepseek-ai/deepseek-v4-flash --system "be terse" "summarize CAP theorem"
aiand run --no-stream --json "hello" | jq .usage
```

Piped input is added to the prompt. The answer goes to stdout and everything
else to stderr, so `aiand run … > out.md` saves just the answer.

After each answer, a dim footer shows the model, tokens, cost, time, and
request ID (`-q` hides it). Cost and timing usually appear only with
`--no-stream`:

```
deepseek-ai/deepseek-v4-flash  ·  9 in / 21 out  ·  0.00000660 USD  ·  181ms  ·  919a9aa4…
```

Without `-m`, aiand uses your profile's model, or the recommended default from
the catalog. `-m auto` lets ai& pick per request, where your account supports
it. Set a default with `aiand config set model <id>`.

If a reasoning model spends its whole budget thinking, aiand tells you so and
suggests raising `--max-tokens`, rather than printing a blank line.

## Logs and usage

```bash
aiand logs --range 1h --errors     # only failed requests
aiand logs --follow                # tail new requests
aiand usage --range 30days
aiand usage --metrics              # full breakdown
```

Both cover your whole organization, not just this machine.

## Configuration

```bash
aiand config                                     # current settings
aiand config set model deepseek-ai/deepseek-v4-flash
aiand config profiles                            # list profiles
aiand config use work                            # switch profile
aiand config path                                # where the files are
```

Settings live in `~/.config/aiand/config.json` (or under `$XDG_CONFIG_HOME`).
Credentials are kept in a separate file, so the config is safe to share.

Profiles keep separate sign-ins, so `--profile work` and `--profile personal`
can use different organizations at the same time.

Flags win over environment variables, which win over the stored profile.

| Variable | Effect |
| --- | --- |
| `AIAND_API_KEY` | Use this key; no login, nothing stored |
| `AIAND_PROFILE` | Profile to use |
| `AIAND_BASE_URL` | API endpoint (default `https://api.aiand.com`) |
| `AIAND_AUTH_URL` | Sign-in endpoint, if different from the API |
| `AIAND_CONFIG_DIR` | Where config and credentials live |
| `AIAND_HOME` | Home directory to find agent configs in (e.g. your Windows home from WSL) |
| `AIAND_KEY_STORAGE` | `keychain`, `file`, or `plaintext` |
| `AIAND_SECRET_STORE_MASTER_KEY` | 64 hex characters; your own key for the encrypted file |
| `AIAND_NO_BROWSER=1` | Never open a browser; print the sign-in link instead |
| `AIAND_UPDATE_CHECK=0` or `NO_UPDATE_CHECK=1` | Turn off the daily update notice |
| `NO_COLOR` | Turn off color |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Request or usage error (the message says which) |
| `2` | Not signed in, or the session could not be refreshed |
| `3` | Sign-in denied, or the code expired |
| `70` | A bug in aiand; the stack trace is printed, please report it |
| `127` | Unknown command, or the agent is not installed |
| `130` | Interrupted (Ctrl-C) |

`aiand status` exits `0` when signed in, even if ai& cannot be reached to check
the key (`reachable: false` in `--json`), and `1` only when signed out. Scripts
that gate on it keep working during an outage.

## Roadmap

- **Files:** uploads for vision, video, audio, and document inputs
- **Billing:** balance, history, auto-recharge, redemption codes
- **Video:** asynchronous generation jobs

## Contributing and security

Building from source, tests, and releases: [CONTRIBUTING.md](CONTRIBUTING.md).
Report vulnerabilities privately: [SECURITY.md](SECURITY.md).
People who have helped build aiand-cli: [THANKS.md](THANKS.md).

## License

Apache-2.0
