**English** | [日本語](agents.ja.md)

# Coding agents on ai&

Per-agent detail for the table in the [README](../README.md#supported-agents).

Every agent takes the same commands:

| Command | What it does |
| --- | --- |
| `aiand <agent>` | Open the agent on ai&. Wires it first if it is not wired yet |
| `aiand <agent> on` | Wire the agent permanently, so the plain binary uses ai& |
| `aiand <agent> status` | Show what the agent is actually configured to use |
| `aiand <agent> off` | Remove exactly what aiand added |
| `aiand run-agent <agent>` | Use ai& for one session and write nothing to the agent's config |
| `aiand restore <agent> --force` | Put the agent's config back byte for byte as it was before aiand first touched it |

Three agents do not fit the table. The GitHub Copilot app is a desktop app with
no session launch, so `aiand run-agent copilot-app` does not apply: it stops
with "GitHub Copilot app does not support session launches", and
`aiand copilot-app on` is the only way to wire it. Jouzu has no session launch
either, because the setting that would point it at a throwaway config also moves
its sessions: `aiand run-agent jouzu` stops the same way, and `aiand jouzu` or
`aiand jouzu on` wires it. And `aiand codex on` does not
make plain `codex` use ai&: it writes a separate profile, so start Codex with
`codex --profile aiand` (or `aiand codex`). See [Codex](#codex),
[GitHub Copilot app](#github-copilot-app) and [Jouzu](#jouzu).

`aiand code` opens the default agent, OpenCode. `aiand init` detects installed
agents and wires them in one go (`--all` for every detected agent, `--off` to
turn them off).

## How `aiand <agent>` behaves

- If you are signed out, aiand offers to sign you in (on a terminal; it asks
  first).
- If the agent is missing and its install command is an npm install, aiand
  offers to run the install command shown by `aiand <agent> --help`. Other
  install hints are printed with no offer. Without a terminal to ask on, aiand
  never installs anything: it prints the install command and exits with `127`.
- If the agent is not wired yet, aiand runs `on`, so the plain `opencode`,
  `codex --profile aiand`, `pi`, `omp`, `copilot` and `hermes` use ai&
  afterwards too. A plain `jouzu` has ai& available afterwards, but starts on
  its own last-used or project model when it has one; `aiand jouzu` starts on
  the ai& model. That is the difference from `aiand run-agent <agent>`,
  which changes nothing. `aiand claude` is the exception: it runs one session,
  the same as `aiand run-agent claude`, and wires nothing.
- Everything after the agent name goes to the agent as typed, such as
  `aiand claude -p "explain this repo"`. Put aiand's own flags before the agent
  name (`aiand --profile work codex`), and put `--` before an argument aiand
  would read as a verb (`aiand opencode -- status`).
- `on` takes `--model <id>` to pick a model, and `--model native` to leave the
  agent's own default alone, for every agent except Codex and Claude Code.
  Codex refuses `native`: its profile would inherit a `config.toml` model the
  gateway cannot serve. `aiand claude on --model native` points Claude Code at
  the gateway but leaves Claude Code's own model selected, which ai& may not
  serve, so its requests can fail; aiand warns about it. Pass `--model <id>`
  for Claude Code.
- The agent starts with a `PATH` of absolute entries only. An empty, `.` or
  relative entry (such as `./node_modules/.bin`) is dropped, because it would
  resolve to the folder you are standing in, where a cloned repository could
  plant the program the agent runs. Give the agent's tools as absolute paths.
- When your key rotates, aiand updates the agents it wired, so they keep
  working without another `on`. It does so only for an agent wired for the
  same API endpoint as the key, and only where the agent still holds the key
  that was replaced. An agent wired for another endpoint (or one aiand cannot
  tell the endpoint of) keeps its key, and aiand prints the
  `aiand --profile <name> <agent> on` command that moves it.

The agent CLIs are the vendors' own. Their install commands and docs:
[OpenCode](https://opencode.ai),
[Claude Code](https://code.claude.com/docs),
[Codex](https://developers.openai.com/codex/cli), [Pi](https://pi.dev),
[Oh My Pi](https://omp.sh),
[GitHub Copilot CLI](https://docs.github.com/en/copilot/get-started/cli-quickstart),
the [GitHub Copilot app](https://github.com/features/ai/github-app),
[Hermes Agent](https://hermes-agent.nousresearch.com/docs/) (Nous Research) and
[Jouzu](https://github.com/shisa-ai/jouzu) (Shisa AI).

## OpenCode

```bash
aiand opencode           # open OpenCode on ai&, wiring it first if needed
aiand opencode on        # route OpenCode through ai&
aiand opencode status    # check what OpenCode is actually configured to use
aiand opencode off       # remove exactly what aiand added
aiand run-agent opencode # or: use ai& for this one session, change nothing
```

`on` adds an `aiand` provider to `~/.config/opencode/opencode.json`, with the
models from the live catalog, so plain `opencode` uses ai& afterwards. Your
other providers and your own edits are left alone. If you already chose a
model it stays chosen; pass `--model <id>` to switch, or `--model native` to
keep OpenCode's own default. `small_model`, which OpenCode uses for titles and
summaries, is set to the same ai& model, so OpenCode does not pick another one;
`off` hands back a `small_model` of your own. `aiand opencode` still opens on
an ai& model, for that run only.

`off` removes only what aiand wrote. If a config ever ends up in a state you
do not want, `aiand restore opencode --force` puts back the exact file from
before aiand first touched it.

`aiand run-agent opencode` writes each model's published reasoning levels into
the session. GLM-5.3 gets low, high, and max. `aiand opencode on` already
copies those levels from the gateway.

## Claude Code

```bash
aiand claude             # one Claude Code session on ai&, nothing wired
aiand claude on          # route every claude through ai&
aiand claude status
aiand claude off         # back to Anthropic's models
```

`on` writes an `env` block into `~/.claude/settings.json` (or
`$CLAUDE_CONFIG_DIR/settings.json`): the gateway URL, your key, and a catalog
model for every slot. Claude Code sends requests from more than one slot:
session titles and other background calls go to the `haiku` slot, and auto
mode's safety checks to the Sonnet slot.

- **You chose a model** (`--model <id>`, or `aiand config set model <id>`):
  every slot gets that model, the `haiku` slot too, so Claude Code sends
  requests to no other model. That includes auto mode's safety checks:
  `on` writes `CLAUDE_CODE_AUTO_MODE_MODEL` too, so a value exported in your
  shell cannot move them. Add `--fast-model <id>` to give background calls
  and safety checks a separate model. A re-run of `on`, and `aiand claude`
  sessions, keep a `--model` choice; a profile model is followed as it
  changes.
- **You did not:** the main slots get a vision model and the `haiku` slot a
  fast one, from aiand's preferred order.

`aiand claude --model <id>` (one session) does the same for that session.
`aiand claude status` lists the model in every slot and warns about any slot
that holds a model other than the one you chose, such as one you set by hand.
A `model` setting ai& cannot serve is set aside until `off`; one it can serve
is kept, and Claude Code starts on it.

What else `on` changes:

- **Context size.** Claude Code's context budget
  (`CLAUDE_CODE_MAX_CONTEXT_TOKENS`) is the `context_window` the ai& catalog
  publishes for the model Claude Code starts on, including windows above 1M.
  That is the model you chose, a kept `model` setting, or the slot an alias
  such as `aiand claude --model haiku` starts on; `--fast-model` does not
  change it. Claude Code holds one budget per process, so after a `/model`
  switch the session keeps the startup model's budget. To work on another
  model, exit and start a new session with `aiand claude --model <id>`, or run
  `aiand claude on --model <id>` before starting `claude`.
  `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` stays set so a model shown with a `[1m]`
  suffix is sized by its catalog window rather than an assumed 1M. Claude Code
  may keep its built-in window for model ids it recognizes as Claude models;
  see its
  [context override rules](https://code.claude.com/docs/en/model-config#which-ids-claude_code_max_context_tokens-applies-to).
- **Attribution header.** It is turned off, since ai& would otherwise pass it
  to the model as prompt text.
- **`/model`.** It lists every ai& model. Claude Code only discovers gateway
  models whose id contains "claude", so `on` writes them into its
  `modelPicker` setting, replacing the built-in Opus, Sonnet and Haiku rows (a
  `modelPicker` of your own is kept). Each row shows the model's published
  context window (`ai& · 1M context`), and text-only models add
  `· text only`.
- **Other clouds.** The Bedrock, Vertex and Foundry switches are written as
  `0`, so one left on elsewhere cannot route Claude Code away from ai&.
- **Auto-mode safety checks.** In auto mode (Claude Code's default permission
  mode) Claude Code asks a model whether each checked action is safe. Each check
  sends about 30,000 input tokens, and on the main model they cost more than the
  coding work. `on` points them at the fast model with
  `CLAUDE_CODE_AUTO_MODE_MODEL` (Claude Code 2.1.302 or later; older versions
  ignore it and use the main model). It also sets
  `CLAUDE_CODE_AUTO_MODE_SERVER=0`, so Claude Code always runs the checks
  itself: the checks Anthropic runs server-side need Claude models, and without
  that setting Claude Code would ask for them, fall back, and show a notice
  that a later release will ask about or deny every checked action instead.
  See [ADR 2](adr/0002-claude-auto-mode-safety-checks.md).
- **WebSearch** is denied because it runs on Anthropic's servers. WebFetch
  still works.
- **`/effort`** is sent to ai& as the model's reasoning level, so pick one the
  model publishes: `moonshotai/kimi-k3` takes `low`, `high` and `max`, and any
  other level is rejected.

The key sits in that file while Claude Code is wired, so keep it out of a
dotfiles repo. Claude Code passes it to every command and hook it runs, as it
does every `env` value. A project's own `.claude/settings.json` can override
these values.

`off` removes what aiand wrote and hands back a `model` it set aside, so Claude
Code uses your own sign-in and Anthropic's models again.

## Codex

```bash
aiand codex              # open Codex on its ai& profile, writing it first if needed
aiand codex on           # write an ai& profile for Codex
codex --profile aiand    # then start Codex on ai&
aiand codex status
aiand codex off
aiand run-agent codex    # launch Codex on ai&, nothing written
```

`on` writes a separate profile, `~/.codex/aiand.config.toml` (or
`$CODEX_HOME/aiand.config.toml`), and leaves your `config.toml` alone, so plain
`codex` keeps your usual setup and `codex --profile aiand` uses ai&. Your
`config.toml` still loads under the profile, so its MCP servers and plugins
come along.

- **No key in the profile.** Codex runs `aiand key export` for your active
  aiand profile, so a rotation or `aiand config use` needs nothing (`on
  --profile <name>` pins another profile instead). On Windows it runs this
  install's Node and `dist\index.js` directly rather than the `aiand.cmd` shim,
  which would look for `node` in Codex's working directory.
- **Reasoning and tools.** It pins a reasoning level the model publishes, for
  Plan Mode too, and turns off Codex's hosted tools (web search, image
  generation and the like), which ai& does not run.
- **Your changes survive.** A model or level you pick in Codex's `/model` stays
  across another `on`; pass `--model <id>` to switch. Settings of your own in
  the profile survive `on` and `off`.
- **Conflicts.** `on` refuses a profile that already routes Codex elsewhere;
  `--force` takes it over, and `aiand restore codex --force` brings the old one
  back.

Which Codex versions work with ai&, and what changed between them, is in the
[Codex guide](https://docs.aiand.com/integrations/codex/).

## Pi

```bash
aiand pi                 # open Pi on ai&, wiring it first if needed
aiand pi on              # route Pi through ai&
aiand pi status
aiand pi off
aiand run-agent pi       # or: one Pi session on ai&, no Pi config written
```

`on` writes an `aiand` provider into `~/.pi/agent/models.json` speaking the
gateway's OpenAI-compatible dialect, with every model from the live catalog,
saves the session key in `~/.pi/agent/auth.json` (readable only by you), and
sets `defaultProvider`/`defaultModel` in `~/.pi/agent/settings.json`. Your
other providers and credentials are untouched. A `defaultModel` ai& cannot
serve is set aside until `off`; one it can serve is kept. Pass
`--model <id>` to switch, or `--model native` to leave Pi's own default.

Pi offers each model's published reasoning levels. A level the model does not
publish stays hidden. Pi's own default is medium. When medium is not in the
model's list, Pi moves up to the next level it does publish. On GLM-5.3 that
level is high.

Pi's config root moves wholesale with `PI_CODING_AGENT_DIR`.

## Oh My Pi

```bash
aiand omp                # open Oh My Pi on ai&, wiring it first if needed
aiand omp on             # wire Oh My Pi through ai&
aiand omp status
aiand omp off
aiand run-agent omp      # or: one Oh My Pi session on ai&, no omp config written
```

`on` writes an override-only `aiand` provider block into
`~/.omp/agent/models.yml` (omp already bundles the aiand provider, so only the
gateway URL, your key and the ownership marker are written) and pins
`modelRoles.default` in `~/.omp/agent/config.yml`. Your other providers and
settings are untouched. A `modelRoles.default` ai& cannot serve is set aside
until `off`; one it can serve is kept. Pass `--model <id>` to switch, or
`--model native` to leave omp's own default. `PI_CODING_AGENT_DIR` moves the
config root wholesale; `PI_CONFIG_DIR` renames the `.omp` root.

One-session launches keep session history in omp's own session dir, including
its XDG location (`$XDG_DATA_HOME/omp/sessions`) when omp was migrated with
`omp config init-xdg`.

## GitHub Copilot CLI

```bash
aiand copilot            # open Copilot CLI on ai&, wiring it first if needed
aiand copilot on         # wire GitHub Copilot CLI through ai&
aiand copilot status
aiand copilot off
aiand run-agent copilot  # or: one Copilot CLI session on ai&, no config written
```

`on` writes an `aiand` provider into `~/.copilot/providers.json` (or
`$COPILOT_HOME/providers.json`) with every model from the live catalog, and
pins the `aiand/<id>` model in `~/.copilot/settings.json`, which a bare
`copilot` launch needs: a BYOK provider has no built-in default. Your other
providers and their rows are untouched, and the provider row holds the session
key itself, so no GitHub sign-in is involved. Pass `--model <id>` to switch
models; `off` hands back the `model` selection it replaced, or drops the key it
added, and leaves a value you changed in between. The key sits in that file
while Copilot is wired, so keep it out of a dotfiles repo. `--model native`
leaves settings.json's model as it is.

## GitHub Copilot app

The desktop app takes the same wiring through its own provider store, and
nothing else. `aiand copilot-app on` writes an `aiand-`-prefixed provider row
and one model row per catalog model into `~/.copilot/data.db` (or
`$COPILOT_HOME/data.db`); the app has to have created that database, so open it
once first. The app keeps GitHub sign-in even for BYOK providers, and you pick
the ai& model in its own model menu: aiand does not set a default there.

Quit the app before `on` or `off`, since it rewrites the database as it exits
and would clobber the change; `--force` goes ahead anyway. The app is a GUI, so
there is no `run-agent copilot-app`. Bare `aiand copilot-app` wires the app and
tells you how to open it yourself: aiand cannot launch a GUI app, and anything
after `copilot-app` errors.

## Hermes Agent

```bash
aiand hermes             # open Hermes on ai&, wiring it first if needed
aiand hermes on          # route Hermes through ai&
aiand hermes status
aiand hermes off
aiand run-agent hermes   # launch Hermes on ai& for one session, nothing written
```

`on` ships a dedicated `aiand` model provider as a `model-provider` plugin
under `~/.hermes/plugins/model-providers/aiand`, adds a `providers.aiand`
block to `~/.hermes/config.yaml`, and bakes your key into `~/.hermes/.env`
(mode 0600) under a dedicated name. The key lives in Hermes's own process after
the `.env` load but never reaches the tools Hermes runs: the generated provider
declares the var, which mirrors into Hermes's provider env blocklist, so
terminal and tool children are spawned without it.

- **Reasoning levels.** The generated provider carries each model's published
  levels (GLM-5.3 offers low, high, and max). A stock install leaves the level
  unset, so no `reasoning_effort` is sent and the gateway's per-model default
  applies; a level you pick is clamped onto the published set.
- **Model.** The top-level model pins from the live catalog. Pass `--model <id>`
  to switch, or `--model native` to leave the model section exactly as it is
  (Hermes needs a default to send, so ai& never deletes one).
- **Your own entries.** Your other providers, plugins, sessions, and edits are
  left alone. Your own `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` and
  `ANTHROPIC_TOKEN` entries in `~/.hermes/.env` are commented out where they sit
  (`# aiand set aside: …`) and `off` uncomments them.

`off` removes only what aiand wrote. If a config ever ends up in a state you do
not want, `aiand restore hermes --force` puts back the exact files from before
aiand first touched it.

`run-agent` routes one session through a throwaway `HERMES_HOME` overlay
without a prior `on`. Your sessions, skills, memories, logs, and own plugins are
symlinked back so they stay native and resumable, while credentials exist only
inside the overlay and the real `~/.hermes`, including its `config.yaml`, is
never written. The overlay ships the same dedicated `aiand` model provider, and
its `config.yaml` pins the model from the live catalog: use `--model <id>` to
choose (a session launch always names a model, so `--model native` is the usual
catalog error). `--model` or `-m` in the arguments after `--` counts as
`--model`: the session runs on it. `--provider` there is stripped so nothing
can override the injected routing, and the overlay is removed after the
session ends: success, failure, or Ctrl-C.

## Jouzu

```bash
aiand jouzu              # open Jouzu on ai&, wiring it first if needed (also: aiand jz)
aiand jouzu on           # route Jouzu through ai&
aiand jouzu status
aiand jouzu off
```

Jouzu is Shisa AI's terminal coding harness, built on Pi. It keeps Pi's files
in its own config dir, so `on` writes the same `aiand` provider, credential
(readable only by you) and `defaultProvider`/`defaultModel` as `aiand pi on`,
but into Jouzu's `agent` dir: `~/Library/Application Support/Jouzu/agent` on
macOS, `$XDG_CONFIG_HOME/jouzu/agent` (default `~/.config/jouzu/agent`) on
Linux, `%APPDATA%\Jouzu\agent` on Windows, or `$JOUZU_HOME/agent` when
`JOUZU_HOME` is set. Pi's own `~/.pi` is not touched, and your Shisa sign-in and
other providers stay as they are. `off` removes only what aiand wrote, and
`aiand restore jouzu --force` puts back the exact files from before aiand first
touched them.

Jouzu starts on its project default or last-used model before `defaultModel`,
so `aiand jouzu` adds `--provider aiand --model <id>` for that run, unless your
arguments already pick a model, a session or a Jouzu command; `/model` switches
inside the session as usual. `--model native` leaves Jouzu's own choice. The
signed Windows launcher keeps its config elsewhere: set `JOUZU_HOME` to its data
dir before `on`. There is no `run-agent jouzu`, because `JOUZU_HOME` also moves
Jouzu's sessions and state, so a one-session overlay would hide your history.

Jouzu is third-party software that ai& does not control. ai&'s data residency
and retention commitments cover only the data our API receives, not what Jouzu
itself stores, sends or does on your machine.
