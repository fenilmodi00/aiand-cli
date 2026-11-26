<img src="docs/assets/aiand-cli-logo.svg" alt="ai&amp; CLI logo" width="480">

**English** | [日本語](README.ja.md)

**Less setup. More building.**

`aiand` is the command line for ai& inference. It signs you in through your
browser, then points your coding agent at ai& (Claude Code, OpenCode, Codex and
others) without a proxy or a daemon. It also sends prompts, lists models and
prices, and shows your requests and usage.

Guide: [docs.aiand.com/cli](https://docs.aiand.com/cli/)

## Quick start

1. **Install.** You need Node.js 22 or newer.

   macOS and Linux:

   ```bash
   curl -fsSL https://github.com/aiandlabs/aiand-cli/releases/latest/download/install.sh | bash
   ```

   Windows (PowerShell):

   ```powershell
   irm https://github.com/aiandlabs/aiand-cli/releases/latest/download/install.ps1 | iex
   ```

   The installer runs on Windows PowerShell 5.1 as well as PowerShell 7. Every
   other PowerShell command in this README is for PowerShell 7 (`pwsh`): see
   [Updating and uninstalling](#updating-and-uninstalling).

   Or on any system: `npm install -g @aiand/cli`.

2. **Sign in.** The installer offers to do this at the end. To do it later:

   ```bash
   aiand login
   ```

3. **Open your agent on ai&.**

   ```bash
   aiand claude    # Claude Code
   aiand code      # OpenCode
   ```

   Other agents are in [Supported agents](#supported-agents). No agent? Try
   `aiand run "hello"`.

Open a new terminal if `aiand` is not found after installing.

## Try the cli-v2 preview (side-by-side)

This branch installs as `aiand-v2` next to a production `aiand` — separate
command, checkout (`~/.aiand/cli-v2`), and state (`~/.config/aiand-v2`) — so
you can run the preview without touching a production install:

```bash
curl -fsSL https://raw.githubusercontent.com/fenilmodi00/aiand-cli/cli-v2/install.sh | bash
```

Use `aiand-v2` wherever this README says `aiand` while you run the preview.
`aiand-v2 update` re-fetches the preview branch, which the installer builds
from that branch's source because a preview is not a published release.
Uninstall the preview (it keeps the preview's profiles and credentials) with:

```bash
curl -fsSL https://raw.githubusercontent.com/fenilmodi00/aiand-cli/cli-v2/install.sh | bash -s -- uninstall
```

Set `AIAND_V2_SIDEBYSIDE=0` to install the production defaults instead. On
Windows, run the preview from Git Bash; `install.ps1` has no side-by-side mode.

## Supported agents

The ai& CLI works with these coding agents:

| Agent | Command | What the `on` command changes |
| --- | --- | --- |
| [OpenCode](https://opencode.ai) | `aiand opencode` or `aiand code` | Adds an `aiand` provider to `~/.config/opencode/opencode.json` |
| [Claude Code](https://code.claude.com/docs) | `aiand claude` | Writes an `env` block to `~/.claude/settings.json` |
| [Codex](https://developers.openai.com/codex/cli) | `aiand codex` | Writes a separate profile, `~/.codex/aiand.config.toml`. Run `codex --profile aiand` |
| [Pi](https://pi.dev) | `aiand pi` | Adds a provider to `~/.pi/agent/models.json`, the key to `auth.json`, the default to `settings.json` |
| [Oh My Pi](https://omp.sh) | `aiand omp` | Writes `~/.omp/agent/models.yml` and `config.yml` |
| [GitHub Copilot CLI](https://docs.github.com/en/copilot/get-started/cli-quickstart) | `aiand copilot` | Adds a provider to `~/.copilot/providers.json` and sets the model in `settings.json` |
| [GitHub Copilot app](https://github.com/features/ai/github-app) | `aiand copilot-app` | Writes provider rows to `~/.copilot/data.db`. aiand wires it; you open the app |
| [Hermes Agent](https://hermes-agent.nousresearch.com/docs/) | `aiand hermes` | Adds a provider plugin under `~/.hermes/plugins/`, plus `config.yaml` and `.env` |
| [Jouzu](https://github.com/shisa-ai/jouzu) | `aiand jouzu` or `aiand jz` | Pi's three files, in Jouzu's own config dir: a provider in `agent/models.json`, the key in `auth.json`, the default in `settings.json` |

`aiand <agent>` opens the agent on ai&, signing you in and wiring it first if
needed. `aiand claude` is the exception: it runs one session and wires nothing
(see the [example below](#example-use-ai-with-claude-code)). `aiand <agent> on` wires it without opening it. `aiand <agent> off`
removes what aiand added. `aiand <agent> status` shows what the agent really
uses.

- Your other providers and your own edits are left alone. `off` removes only
  what aiand wrote. `aiand restore <agent> --force` puts back the file as it was
  before aiand first changed it.
- `aiand run-agent <agent>` uses ai& for one session and writes nothing to the
  agent's config.
- `aiand init` detects installed agents and wires them together (`--all` for
  every one, `--off` to turn them off).
- If an agent is missing, aiand offers to install it when the install command
  is an npm install. Otherwise it prints the command and exits with `127`.
- Everything after the agent name goes to the agent as typed. Put aiand's own
  flags before it (`aiand --profile work codex`), and put `--` before an
  argument aiand would read as a verb (`aiand opencode -- status`).
- When your key rotates, aiand updates the agents it wired.

Details and per-agent notes: [docs/agents.md](https://github.com/aiandlabs/aiand-cli/blob/main/docs/agents.md).

## Example: use ai& with Claude Code

There are two ways to use ai& with Claude Code: one session at a time, or every
session.

### For one session only

```bash
aiand claude                              # open one Claude Code session on ai&
aiand claude -p "explain this repo"       # pass arguments to Claude Code
aiand claude --model <id>                 # pick the ai& model for this session
aiand claude --session                    # the same, from the agent's own command
aiand claude on --session
```

`aiand claude` starts one Claude Code session on ai& and writes nothing to your
Claude Code settings. Plain `claude` sessions in other terminals keep using
Anthropic's models, before, during and after. Everything after `claude` goes to
Claude Code as typed, except `--model <id>`, which picks the ai& model for every
model slot of the session; `aiand models` lists them.

If you pick an ai& model in `/model` and save it as your default, aiand puts
your own default back as soon as Claude Code saves it, so a plain `claude`, even
one started while the ai& session is still open, starts on a model it can use.
While `aiand claude on` is in effect, an ai& default is left in place, since
every `claude` runs on ai& then.

### For every session

```bash
aiand claude on                  # route every claude through ai&
claude                           # now uses ai&
aiand claude status              # check what Claude Code is configured to use
aiand claude off                 # back to Anthropic's models
```

- **`aiand claude on`** writes the gateway URL, your key and model settings into
  `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`). After that,
  every `claude` uses ai&. Pass `--model <id>` to pick a model; Claude Code
  then sends every request to it, background calls included.
- **Sessions that are already open switch too.** Claude Code applies `on` and
  `off` to running sessions: `on` moves them to ai& at once, and `off` moves
  them back. `off` takes about three seconds while running sessions reload. If
  a session still answers from ai&, restart it: `/exit`, then
  `claude --continue`.
- **To go back,** run `aiand claude off`. It removes what aiand added and keeps
  your own edits. `aiand restore claude --force` puts back the file exactly as
  it was before aiand first changed it.

The key is stored in `settings.json` while Claude Code is wired. Keep that file
out of a dotfiles repo. What else `on` changes (context size, `/model` list,
WebSearch) is in [docs/agents.md](https://github.com/aiandlabs/aiand-cli/blob/main/docs/agents.md#claude-code).

## Signing in

`aiand login` opens your browser. Approving creates an API key for your
organization, labeled `aiand@<hostname>` so you can tell your machines apart in
the console. Over SSH, or if the browser sign-in cannot finish (no browser, a
timeout, or a script with no terminal), aiand shows a code you approve from any
device instead:

```
  Your code   BCDF-GHJK
  Approve at  https://api.aiand.com/auth/device?user_code=BCDF-GHJK
```

Already have a key from the console?

```bash
aiand login --paste                # masked prompt
aiand login --with-token < key.txt # read it from stdin
```

`aiand logout` offers to revoke a key that `login` created. If the revoke cannot
reach ai&, you stay signed in so you can run `logout` again; `--keep-remote`
forgets the key here without revoking it. A key you pasted in is only removed
from this machine: revoke it in the [console](https://console.aiand.com/api-keys).

Signing in again (`aiand login --force`, or yes to "Sign in again and replace
it?") revokes the key the old sign-in created, once the new one is stored. A
sign-in that fails or is cancelled before the new one is stored keeps the old
one; if a later step fails, the old key is still revoked. If the revoke cannot
reach ai&, the new sign-in still stands and aiand says so: revoke the old key
in the console. `--keep-remote` keeps the old key valid. A pasted key is never
revoked.

Keys expire. aiand rotates one automatically in its last 3 days, or right away
if the server rejects it.

**CI and scripts:** skip `login` and set `AIAND_API_KEY`. Nothing is written to
disk.

## Where your key is stored

`aiand status` shows which of these you have.

| OS | Where | Protects against |
| --- | --- | --- |
| macOS | Keychain | Other accounts on the machine, and a copy of your files taken elsewhere |
| Linux | Secret Service (GNOME Keyring, KWallet) through `secret-tool` | The same, once the keyring is unlocked at login |
| Windows | DPAPI, through the Windows PowerShell that ships with Windows. The encrypted key is under `%USERPROFILE%\.config\aiand\` | Other Windows accounts, and a copy of the file taken to another machine or account |

Nothing here protects the key from programs running as you.

When none of these works (a headless Linux box with no keyring, or a Windows
machine whose PowerShell runs in Constrained Language Mode), the key goes to a
file under `~/.config/aiand/`. `aiand status` labels it
`file (owner-only, not encrypted at rest)`, because the decryption key sits next
to the file. It guards against a casual look, not against anyone who can read
that folder. On Windows, `aiand status` also says why DPAPI was not used.

<details>
<summary>More on key storage</summary>

- `AIAND_KEY_STORAGE` picks one tier: `keychain` (macOS and Linux only), `dpapi`
  (Windows only), `file`, or `plaintext`, a plain owner-only file used only when
  you ask for it. `--json` output adds `storage_tier` with the same ids.
- Set `AIAND_SECRET_STORE_MASTER_KEY` to supply the file tier's key yourself and
  the file is encrypted at rest against a copy of the folder. The label becomes
  `file (encrypted; key held outside the config folder)`. If the owner-only ACL
  could not be applied on Windows (`icacls` failed; `AIAND_DEBUG=1` says why),
  the label says `not owner-only`.
- A key stored in the file tier on Windows moves into DPAPI the next time aiand
  reads it. If PowerShell cannot be reached (it hangs, times out or fails), the
  key stays in the file, `aiand status` says why, and reads leave it there for
  ten minutes before trying again, so a PowerShell that hangs costs one wait and
  not one per `aiand` process. The next sign-in tries DPAPI at once.
- Before you downgrade aiand on Windows, run `aiand logout`. An older version
  cannot see a key that has moved into DPAPI, so it can neither sign it out nor
  revoke it.
- Each `aiand` run that reads a DPAPI key starts Windows PowerShell once, which
  can take a moment on a cold machine. If your endpoint security blocks that,
  set `AIAND_KEY_STORAGE=file` to skip DPAPI.

Cost, endpoint-security behaviour and a test plan for Windows fleets:
[docs/windows-key-storage.md](https://github.com/aiandlabs/aiand-cli/blob/main/docs/windows-key-storage.md).

</details>

## Shared and loaner computers

The trust boundary is the operating-system account: anyone who can sign in to
the same account can use what aiand stored there. Before you hand a machine
back:

```bash
aiand logout --all
```

It asks first; off a terminal, pass `--force`. Then it:

- revokes every key `login` created on this machine, one profile at a time, and
  keeps the sign-in of any it could not reach, so you can run it again;
- removes ai& from every coding agent, whichever profile wired it, and checks
  that no ai& key is left in their config files;
- deletes leftover session files that a crashed `aiand run-agent` left in the
  temp directory, except one a Hermes shim still points into: deleting it
  would break your `hermes` command, so it is reported, and goes on a later
  run once Hermes is reinstalled;
- deletes every stored key, OS keychain entries included, and `~/.config/aiand`
  itself: profiles, settings and snapshots.

To remove the CLI as well, run the installer's `uninstall --purge`. It does the
same sign-out first and deletes nothing if that fails. See
[Uninstall](#updating-and-uninstalling).

**Revoke pasted keys in the console.** Keys you pasted in (`--paste`,
`--with-token`) cannot be revoked from the CLI, which did not create them.
`logout --all` lists them. Revoke them at
[console.aiand.com/api-keys](https://console.aiand.com/api-keys), and do the
same for any key it could not revoke.

Then sign out of the coding agents themselves if you used them with other
accounts.

<details>
<summary>When <code>logout --all</code> exits 1</summary>

It exits `0` when nothing is left, and `1` after listing whatever was:

- a key it could not revoke. That profile's sign-in and the config directory
  stay, since the refresh token is the only thing that can revoke it. Run
  `logout --all` again, or `logout --all --keep-remote` to forget it here and
  revoke it in the console;
- a stored sign-in it could not read (a locked keychain over SSH, or a corrupt
  `credentials.json`). That profile keeps its sign-in files and the config
  directory stays, so a retry can still revoke the key. Unlock the keychain or
  fix the file, then run `logout --all` again. `uninstall --purge` stops here
  too and deletes nothing;
- an agent config it could not fix (for example one that is no longer valid
  JSON). That agent keeps its `snapshots/<agent>` folder and the config
  directory stays. Fix the config, run `aiand <agent> off`, then `logout --all`
  again;
- a session still running;
- files of your own in the config directory, which it leaves in place.

`--keep-remote` deletes everything locally without revoking anything. `--json`
reports each step.

`logout --all` deletes a config directory only inside your home directory. For
an `AIAND_CONFIG_DIR` elsewhere, set `AIAND_WIPE_OUTSIDE_HOME=1`. It also wipes
only a directory that proves it is aiand's, so a mistyped `AIAND_CONFIG_DIR`
(say `~/.docker`) loses nothing. aiand puts a `.aiand-config` file in a
directory the first time it writes there, but only when the directory is new,
empty, or holds nothing but aiand's own files (a cache write into `~/.docker`
marks nothing). The file holds a random id that the directory's `config.json`
records too, so an empty or copied one proves nothing; a directory from before
that passes when its `config.json` holds a `profile` and `profiles`. Sign-in
files (`credentials.json`, `secret-store.*`) need that `config.json` beside
them, since `.aiand-config` alone vouches only for caches. Otherwise
it refuses before touching anything; run `aiand login` with `AIAND_CONFIG_DIR`
set to the directory if it really is aiand's, so aiand writes them; if its
`config.json` records another id than `.aiand-config`, delete `.aiand-config`
first, since aiand never rewrites one that names an id. If that
directory holds a sign-in with no `config.json` (one interrupted before it was
written), run `aiand logout --profile <name>` there before that login, for each
profile in its `credentials.json`: that revokes the key where it was issued, which a new
`aiand login` over it would not. A sign-in that does not record where it was
issued is not sent anywhere from a directory with no `config.json`, or one
whose `config.json` records another id: revoke its key in the console and run
`aiand logout --keep-remote`. Inside it,
a `locks` or `snapshots` folder keeps any entry aiand did not put there. The
directory is checked again right before anything is deleted from it, so one
swapped for a link while a revoke ran is refused.

</details>

## Updating and uninstalling

The installer puts the CLI in `~/.aiand/cli` and a launcher in `~/.local/bin`.
It adds that folder to your PATH: in `~/.zshrc` (zsh), `~/.bash_profile` (bash on
macOS) or `~/.bashrc` (bash on Linux), or in your user PATH on Windows. For fish
and nushell it prints the command to run instead. Set `AIAND_NO_MODIFY_PATH=1`
to skip the change. Re-running it, or `update`, never touches `~/.config/aiand`, so
your agents stay wired.

> **PowerShell 7.** The PowerShell commands in this README are for PowerShell 7
> (`pwsh`). Windows PowerShell 5.1 only receives security fixes, and Microsoft
> recommends installing PowerShell 7: see
> [Install PowerShell on Windows](https://learn.microsoft.com/powershell/scripting/install/install-powershell-on-windows)
> (Windows PowerShell 5.1 prints the same link, <https://aka.ms/PSWindows>, each
> time it starts). This is about the shell you type into. The installer still
> runs on Windows PowerShell 5.1, so the one-line `irm … | iex` install works
> from either, and aiand itself uses the Windows PowerShell 5.1 that ships with
> Windows to reach DPAPI.

**Update.** The CLI tells you on a terminal when a new version is out (set
`AIAND_UPDATE_CHECK=0` to turn that off). For an npm install, run
`npm install -g @aiand/cli@latest`. For the installer:

```bash
bash ~/.aiand/cli/install.sh update
```

```powershell
pwsh -ExecutionPolicy Bypass -File "$env:USERPROFILE\.aiand\cli\install.ps1" update
```

`-ExecutionPolicy Bypass` applies to that one PowerShell process only, so it
works under Windows' default policy without changing it.

**Uninstall.** This turns off every agent aiand wired, then removes the CLI. Your
profiles and keys under `~/.config/aiand` are kept.

```bash
bash ~/.aiand/cli/install.sh uninstall
```

```powershell
pwsh -ExecutionPolicy Bypass -File "$env:USERPROFILE\.aiand\cli\install.ps1" uninstall
```

For an npm install, run `aiand init --off`, then `npm uninstall -g @aiand/cli`.

**On a shared or loaner machine,** add `--purge` to leave nothing behind:

```bash
bash ~/.aiand/cli/install.sh uninstall --purge
```

```powershell
pwsh -ExecutionPolicy Bypass -File "$env:USERPROFILE\.aiand\cli\install.ps1" uninstall --purge
```

`--purge` runs `aiand logout --all` first. That revokes the keys this CLI
created and removes pasted keys from this machine, though a pasted key stays
valid in the console. It also removes ai& from every agent's config. Then it
deletes the config directory (`~/.config/aiand`, or `AIAND_CONFIG_DIR`) along
with the CLI. If signing out fails, nothing is deleted. If it revokes every key
but leaves something behind (a key still in an agent's config, a snapshot an
agent still needs), the installer names it, keeps the config directory, and
exits 1. `--force --purge` skips the sign-out and deletes the files anyway, but
then the keys are not revoked, so revoke them in the console.

<details>
<summary>How the installer verifies what it installs</summary>

The installer installs the latest release, never the main branch. It downloads
the `@aiand/cli` tarball from npm and installs it only if it matches both npm's
sha512 and the `SHA256SUMS` attached to the GitHub release. `AIAND_VERSION=x.y.z`
picks a release, and is the only way to install one older than the version you
have; without it the installer refuses to go backwards. Nothing older than
0.8.0, the first release published with a `SHA256SUMS`, can be installed. If no
release can be reached (or GitHub rate-limits the download), it stops and
changes nothing.

Those checks cover the tarball, not the script. The one-liner fetches the
installer script from the latest GitHub release and runs it before anything is
verified, so you trust GitHub for that first step. It comes from a release's
assets, not the main branch, so a push to main does not change what it does. If
you would rather not trust GitHub for it, use `npm install -g @aiand/cli`, which
trusts npm alone. If the one-liner answers 404, no release carries the installer
yet: use the npm command meanwhile.

`update` runs the installer copy that arrived inside an earlier verified release,
so, unlike the one-liner, it does not fetch a script from GitHub again. An
install from an older installer (one that cloned the main branch) has no such
copy and updates by running the one-line install command again.

The installer swaps the new copy in for `~/.aiand/cli` only after it has run
`--version` and `--help`. If it is stopped part-way (Ctrl-C, closing the
terminal), it puts the previous copy back, and if it was killed outright the next
run does that before anything else. That run also removes the `.cli-staging-*`
and `cli.prev-*` folders an earlier run left in `~/.aiand`, except those of an
installer that is still running, which it neither deletes nor puts back. It leaves a git
checkout alone, and says so, when the installer did not create it, when it has
local changes, when it has commits its upstream lacks, or when its branch has no
upstream to compare against. A download that is larger than a release can be (16
MiB for the tarball, 4 MiB for the checksums and npm's manifest) is stopped at
that size with a message.

</details>

## Commands

| Command | What it does |
| --- | --- |
| `aiand login` / `logout` | Start or end this machine's session |
| `aiand logout --all` | Remove every ai& key and setting from this machine |
| `aiand whoami` | Identity, organization, and key expiry |
| `aiand status` | Sign-in state, key storage, and every agent's wiring |
| `aiand code` | Open OpenCode on ai&, setting it up first if needed |
| `aiand <agent>` | Open a coding agent on ai& the same way |
| `aiand <agent> on\|off\|status` | Wire a coding agent to ai&, or unwire it |
| `aiand init` | Detect installed agents and wire them in one go |
| `aiand run-agent <agent>` | Run an agent on ai& for one session only |
| `aiand <agent> --session` | Run a coding agent on ai& for one session, no config written |
| `aiand restore` | Pick agents and put their configs back as they were before ai& (interactive; `<agent> --force` for scripts) |
| `aiand run <prompt>` | One prompt, streamed to stdout |
| `aiand chat` | Interactive conversation |
| `aiand models` | The model catalog, with prices in your billing currency |
| `aiand logs` | Recent requests, with `--follow` |
| `aiand usage` | Requests and tokens, compared with the previous period |
| `aiand cache` | Cache hit rate, per agent and per model, and what the cache saved |
| `aiand harness` | Compare agent request shapes on cache behavior |
| `aiand orgs` | Organizations you belong to |
| `aiand config` | Profiles and defaults |
| `aiand key export` | Print the active key, for piping into another tool |
| `aiand update` | Update ai& to the latest version (`--check` reports only) |

Most commands take `--json`, and every command takes `--help`.

`aiand` with no command opens an interactive menu. Signed out it shows the two
ways in — browser approval or a pasted API key. Signed in, the first row is
**Set up every agent I have**, which wires every installed agent in one go (the
same as `aiand init --all`); below it, installed agents sit under *Agents*, and
agents ai& supports but this machine is missing sit under *More agents* — Enter
on one of those offers its install and then wires it, exactly as
`aiand <agent>` does.

Type to search agents and commands, `↑`/`↓` or `Tab` to move, `1-9` to jump
straight to a row, `Enter` to open it, and `Esc` to quit. Each row shows the
command it runs and, where one applies, a state badge; the focused row's
description sits under a rule. A pipe gets the static home screen instead, so
`aiand | less` still works.

`AIAND_THEME=light` switches the colors to the light palette, which is picked
automatically when your terminal reports a light background. `NO_COLOR` turns
all color off, and terminals without truecolor get the xterm-256 palette.

### Running prompts

```bash
aiand run "why is the sky blue?"
cat main.ts | aiand run "review this file"
git diff | aiand run "Review this diff. Be ruthless."
aiand run -m deepseek-ai/deepseek-v4.1-flash-1017 --system "be terse" "summarize CAP theorem"
aiand run --no-stream --json "hello" | jq .usage
```

Piped input is added to the prompt. The answer goes to stdout and everything
else to stderr, so `aiand run … > out.md` saves just the answer.

On a terminal, `aiand run` and `aiand chat` strip escape and control sequences
from what the model writes, so a reply cannot set your clipboard, retitle the
window, plant a disguised link, or move the cursor to overwrite earlier lines.
A bare carriage return prints as a new line. Piped or redirected output is not
filtered: `aiand run … > out.md` gets the model's raw text, byte for byte.

After each answer, a dim footer shows the model, tokens, cost, time, and request
ID (`-q` hides it). Cost and timing usually appear only with `--no-stream`:

```
deepseek-ai/deepseek-v4.1-flash-1017  ·  9 in / 21 out  ·  0.00001530 USD  ·  181ms  ·  919a9aa4…
```

Without `-m`, aiand uses your profile's model, or the recommended default from
the catalog. `-m auto` lets ai& pick per request, where your account supports
it. Set a default with `aiand config set model <id>`.

If a reasoning model spends its whole budget thinking, aiand tells you so and
suggests raising `--max-tokens`, rather than printing a blank line.

### Logs and usage

```bash
aiand logs --range 1h --errors     # only failed requests
aiand logs --follow                # tail new requests
aiand usage --range 30days
aiand usage --metrics              # full breakdown
```

Both cover your whole organization, not just this machine.

## Cache and harnesses

The gateway caches prompt prefixes, so the request *shape* an agent uses
decides what it pays. `aiand cache` shows what you actually spent and what
the cache saved; `aiand harness` compares the shapes.

```bash
aiand cache                        # hit rate and savings, by agent
aiand cache --by model             # the same, per model
aiand cache --attribute omp=sk-abcd...1234   # label a key the CLI cannot place
```

Requests are attributed to an agent by the API key the CLI baked into that
agent's config. An agent wired by hand has no such key, so it shows as
`unknown` rather than being guessed — `--attribute` labels one yourself.

```bash
aiand harness                      # compare request shapes
aiand harness --scenario multi-turn-refactor
aiand harness --harness claude-code --harness omp   # compare two, in parallel
aiand harness --sweep-models       # every shape against every model
```

A harness here is a request shape, not a prompt. Each harness also speaks its
own wire dialect, and the benchmark sends what that harness really sends:

| Shape | Dialect | What it does | Cache |
| --- | --- | --- | --- |
| `claude-code` | Anthropic | stable system + tools, append-only transcript | hits |
| `omp` | OpenAI | stable system + tools, append-only transcript | hits |
| `reordered-stable` | Anthropic | reordered the same way every turn | hits |
| `rebuilt-system` | Anthropic | system block rebuilt every turn | misses |
| `compacting` | Anthropic | history replaced by a fresh summary | misses |
| `reordered` | Anthropic | blocks reordered as the conversation grows | misses |

Reordering per se is not the problem — a reorder that never changes still
hits. A reorder that *moves* breaks the prefix, and so does rebuilding the
system block or compacting the history. The benchmark measures this against
the gateway rather than asserting it.

> The two dialects report the prompt differently, and the difference is
> invisible in the totals: the OpenAI dialect's `prompt_tokens` includes the
> cached portion, the Anthropic dialect's `input_tokens` excludes it. The
> gateway's `/logs` normalizes both to the same convention, so the two
> harnesses come out with identical hit rates — the cache does not care which
> dialect sent the request.

## Configuration

```bash
aiand config                                     # current settings
aiand config set model deepseek-ai/deepseek-v4.1-flash-1017
aiand config profiles                            # list profiles
aiand config use work                            # switch profile
aiand config path                                # where the files are
```

Settings live in `~/.config/aiand/config.json` (or under `$XDG_CONFIG_HOME`).
Credentials are kept in a separate file, so the config is safe to share.

Profiles keep separate sign-ins, so `--profile work` and `--profile personal`
can use different organizations at the same time.

Flags win over environment variables, which win over the stored profile.

A stored sign-in only works against the endpoints it was issued by. If
`--base-url`, `AIAND_BASE_URL`, `AIAND_AUTH_URL` or `aiand config set` point
somewhere else, the CLI refuses to send the stored key (exit 2) rather than hand
it, or its refresh token, to that host. Sign in for the other endpoint on its
own profile: `aiand login --profile staging --base-url <url>`. `AIAND_API_KEY` is
not stored, so it goes wherever you point it.

| Variable | Effect |
| --- | --- |
| `AIAND_API_KEY` | Use this key; no login, nothing stored |
| `AIAND_PROFILE` | Profile to use |
| `AIAND_BASE_URL` | API endpoint (default `https://api.aiand.com`) |
| `AIAND_AUTH_URL` | Sign-in endpoint, if different from the API |
| `AIAND_CONFIG_DIR` | Where config and credentials live |
| `AIAND_HOME` | Home directory to find agent configs in (for example your Windows home from WSL) |
| `AIAND_KEY_STORAGE` | `keychain` (macOS and Linux only), `dpapi` (Windows only), `file`, or `plaintext` |
| `AIAND_SECRET_STORE_MASTER_KEY` | Supplies the file tier's key from outside the config folder, instead of `secret-store.key` beside the ciphertext. Exactly 64 hex characters (a 32-byte AES-256 key, for example `openssl rand -hex 32`); anything else is an error. Keep it set for every run: without it, or with a different value, the stored key cannot be decrypted |
| `AIAND_NO_BROWSER=1` | Never open a browser; print the sign-in link instead |
| `AIAND_NO_CLIPBOARD=1` | Never write to the clipboard; `overview --share` saves the PNG and prints its path |
| `AIAND_ALLOW_GIT_TRACKED=1` | Let `on` write the key into an agent config that sits inside a git repository (a Stow or chezmoi link into your dotfiles); refused otherwise, gitignored or not. Gitignore the file and set this variable |
| `AIAND_WIPE_OUTSIDE_HOME=1` | Let `logout --all` delete an `AIAND_CONFIG_DIR` outside your home directory |
| `AIAND_UPDATE_CHECK=0` or `NO_UPDATE_CHECK=1` | Turn off the update notice (it is also off when `CI` is set) |
| `AIAND_AUTO_UPDATE=0` | Turn off the background update notice (foreground `aiand update` still works) |
| `AIAND_DEBUG=1` | Show details that are normally hidden, such as why a file could not be restricted to your account |
| `NO_COLOR` | Turn off color |

The installers read their own variables (`AIAND_VERSION`, `AIAND_DIR`,
`AIAND_NO_MODIFY_PATH`): see the top of `install.sh` and `install.ps1`.

## Behind a corporate proxy

The CLI sends its requests through `HTTPS_PROXY` or `HTTP_PROXY` when either is
set. It honours `NO_PROXY`.

It trusts certificates installed in the operating system's certificate store.
A proxy that inspects HTTPS with a company certificate works when that
certificate is installed there.

If the company certificate is not in the system store, set
`NODE_EXTRA_CA_CERTS` to a PEM file that contains it.

Coding agents the CLI opens read the same variables themselves.

Node 22.21 or later is required.

## Troubleshooting

**`Not logged in.` (exit 2).** You have no sign-in for this profile, or the
session could not be refreshed. Run `aiand login` (add `--force` to replace an
existing session). In a script, set `AIAND_API_KEY` instead.

**`The key stored for profile "…" was issued for …; refusing to send it to …`
(exit 2).** A stored sign-in only works against the endpoint that issued it, and
`--base-url`, `AIAND_BASE_URL`, `AIAND_AUTH_URL` or `aiand config set` now point
somewhere else. Drop the override, or sign in for that endpoint on its own
profile: `aiand login --profile staging --base-url <url>`.

**`aiand` is not found after installing.** The installer adds its folder to your
PATH, and a terminal that was already open does not see that. Open a new
terminal. In VS Code, restart VS Code so its terminal picks up the new PATH. If
the installer printed that it could not update the PATH, add `~/.local/bin`
(Windows: `%USERPROFILE%\.local\bin`) yourself.

**PowerShell says running scripts is disabled** when you run `install.ps1` from a
file. The one-line `irm … | iex` command is not affected. For a file, such as
`update` or `uninstall`, use the form shown in
[Updating and uninstalling](#updating-and-uninstalling):
`pwsh -ExecutionPolicy Bypass -File … install.ps1 …`. It applies to that
one process only.

**On Windows, `aiand status` says PowerShell runs in Constrained Language Mode.**
Your organization's policy blocks the Windows DPAPI call, so aiand stores the key
in an owner-only file under `%USERPROFILE%\.config\aiand\` instead. Sign-in and
everything else work. To encrypt that file at rest, set
`AIAND_SECRET_STORE_MASTER_KEY` (see
[Where your key is stored](#where-your-key-is-stored)). If your endpoint security
blocks PowerShell instead, set `AIAND_KEY_STORAGE=file` to stop aiand trying.

Reporting a problem: include the output of `aiand --version` and `aiand status`.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Request or usage error (the message says which) |
| `2` | Not signed in, or the session could not be refreshed |
| `3` | Sign-in denied, or the code expired |
| `10` | `aiand status` (observability surface): budget near-limit — at/above the near-limit threshold, or projected to exceed the budget this month |
| `11` | `aiand status` (observability surface): limit-hit — the budget is fully used |
| `20` | `aiand status` (observability surface): indeterminate — a budget is set but the data behind the verdict is incomplete or untrustworthy |
| `30` | `aiand status` (observability surface): no-data — the local store is empty or has never synced |
| `70` | A bug in aiand; the stack trace is printed, please report it |
| `127` | Unknown command, or the agent is not installed |
| `130` | Interrupted (Ctrl-C) |
| `143` | Terminated (SIGTERM) |

The `10`–`30` codes are the statusline automation contract (feature catalog
G5). They are set on any `aiand status` run that requests the observability
surface — `--format line`, `--format json`, `--watch`, or `--write-state` —
including the same run as the snapshot write. Plain `aiand status` (the auth
view) keeps `0`/`1` below. Consumers of the JSON snapshot
(`aiand status --write-state <path>`) should also refuse a
`schema_version` they do not understand: version 1 is current, additive
fields keep `1`, breaking changes bump it.

`aiand status` exits `0` when signed in, even if ai& cannot be reached to check
the key (`reachable: false` in `--json`), and `1` only when signed out. Scripts
that gate on it keep working during an outage.

`aiand usage --verify` — the reconciliation accuracy gate — exits `0` when the
local store's totals reconcile exactly with the gateway's, and `1` when any
metric mismatches (the exact delta is reported, never smoothed). Windows the
gateway cannot verify (past 3 months) are reported `UNVERIFIABLE` and do not
change the exit code.

## Contributing and security

Building from source, tests, and releases: [CONTRIBUTING.md](CONTRIBUTING.md).
Report vulnerabilities privately: [SECURITY.md](SECURITY.md).
People who have helped build aiand-cli: [THANKS.md](THANKS.md).

## License

Apache-2.0
