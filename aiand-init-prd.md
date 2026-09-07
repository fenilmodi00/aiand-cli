# PRD · Agent setup (+ auth polish) for `@aiand/cli`

One path from a fresh install to a coding agent that talks to ai& — and one path that puts every harness back exactly as it was.

This document takes the **best of two upstreams**, then fits them into what `@aiand/cli` already ships. Decisions for **Q1–Q8 are locked** below.

| Upstream | What it is good at | How we use it |
| --- | --- | --- |
| [`nebius-tf-relay`](file:///home/fenil/nebius-tf-relay) (`nebiusrelay`) | Harness detection, proxied-vs-spawned edge cases, broader agent matrix, session launchers, snapshot/restore of managed files | **Agent wiring knowledge** — recipes and adapters, rewritten for native `api.aiand.com` (no local daemon) |
| [`fireconnect`](file:///home/fenil/fireconnect) (`@fireconnect/cli`) | Permanent `on` / `off` / `status` product shape, auth UX (browser mint + paste + CI token), key storage tiers, IDE harnesses (Cursor / VS Code), Claude model-slot wizard, uninstall-restores-all | **Auth and CLI product patterns** — and the primary harness command surface |

Neither is a wholesale port. Nebius’s relay exists because Nebius Token Factory speaks OpenAI chat completions only; FireConnect exists because Fireworks wants permanent native config with no proxy. ai& already speaks the native wire formats **and** already has device-login — so we steal patterns, not binaries.

---

## The ask

`@aiand/cli` already handles sign-in, inference, and usage (`login` / `logout` / `whoami` / `run` / `chat` / `models` / `logs` / `usage` / `orgs` / `config`). The missing piece on the roadmap is **agent setup**: writing configuration so local coding agents run against ai& without hand-copying env vars from docs.

Two prior artbases already solved adjacent versions of that problem. This document is the target shape for `@aiand/cli`.

---

## Why no daemon (from the relay analysis, still true)

Nebius Token Factory speaks OpenAI `/chat/completions` only. The relay therefore runs a **local daemon** that translates:

| Harness family | Relay approach |
| --- | --- |
| **Proxied** — Claude Code, Codex, ChatGPT Desktop | Daemon translates Anthropic Messages / OpenAI Responses ↔ Nebius chat completions; injects `ANTHROPIC_BASE_URL` / Codex provider pointing at `127.0.0.1` |
| **Spawned** — OpenCode, Pi, Prime, Hermes, DeepSeek, Grok | Ephemeral or overlay config pointed at Nebius; no proxy |

FireConnect already proved the other model: **rewrite the harness’s own config, no proxy, no wrapper required to keep working**. That matches ai&’s gateway:

| Endpoint | Who needs it |
| --- | --- |
| `/v1/messages` | Claude Code |
| `/v1/responses` | Codex / ChatGPT Desktop (`wire_api = "responses"`) |
| OpenAI-compatible chat | OpenCode, Pi, Prime, Hermes, DeepSeek, Grok, Cursor, VS Code Chat |
| `/v1/models` | Live catalog (Anthropic / OpenAI / Codex shapes) |
| `/v1/api.json` | models.dev-shaped catalog, pre-login |

**Upshot:** every harness is FireConnect’s simple case. Write native config (or inject env for one session), point it at `api.aiand.com`, done — no loopback address, no session token, no process to keep alive, no client-side cost meter, no format translator.

---

## Source map — already / take / skip

### Already in `@aiand/cli` (keep and build on)

| Capability | Notes |
| --- | --- |
| `aiand login` | OAuth 2.0 **device authorization grant**; mints an org-scoped `sk-` key for this machine |
| `aiand logout` | Revokes server-side for **minted** device keys (unless `--keep-remote`), then deletes local credential — see [Auth](#auth-improvements) for paste-key revoke rules |
| Credentials + profiles | XDG `~/.config/aiand/`; profiles via `--profile` / `AIAND_PROFILE`; today `credentials.json` mode `0600` holds secrets — **upgrade path** to FireConnect-style storage tiers (Q6 locked) |
| `AIAND_API_KEY` | CI path; nothing written to disk |
| `aiand whoami` / `config` / `orgs` | Identity and profile management |
| `aiand logs` / `aiand usage` | Org-scoped spend and request history — preferred over any client-side meter |
| `aiand models` | Priced catalog |
| House conventions | Node 22, `tsc`, command modules, `--json`, XDG `~/.config/aiand/` |

### Take from FireConnect

| Pattern | Why | Fit for aiand |
| --- | --- | --- |
| **Harness-first `on` / `off` / `status`** | Primary UX for permanent native config; stock binary works afterwards | Adopt as the agent-setup surface (see [The surface](#the-surface)) |
| **Short harness ids** | `claude`, `codex`, … — not `claude-code` | Locked (Q8) |
| **Byte-for-byte snapshot before write** | `off` restores pre-connect state, including “file did not exist” | Required; store under `~/.config/aiand/backups/` |
| **Idempotent `on`** | Second connect does not clobber the original backup | Required |
| **Inline sign-in when a harness needs a key** | `fireconnect claude` prompts login if unsigned-in | `aiand claude` / `init` should offer `aiand login` rather than fail cold |
| **Paste / `--with-token` / `--api-key` login paths** | Browser mint *or* paste an existing key; stdin token for CI | Extend `aiand login` (device grant stays default; paste is additive) — see [Auth](#auth-improvements) |
| **Minted vs pasted revoke tracking** | Only offer/attempt server revoke for keys this CLI minted | Locked (Q7) — same as FireConnect |
| **Secret storage tiers** | OS keychain → encrypted file → plaintext `0600`; config holds a reference | Locked (Q6) — merge with aiand profiles |
| **Richer global `status`** | Sign-in state + key source + storage tier + per-harness on/off | Extend beyond `whoami`; keep `whoami` for identity-only |
| **Claude model-slot mapping** | Wizard + slot flags (`--opus`, `--sonnet`, `--haiku`, …) | Port the *UX idea*; map slots from ai& `/v1/models`, not Fireworks aliases |
| **ChatGPT as Codex alias** | Shared `~/.codex/config.toml`; quit Desktop before write | Same shared-file reality as the relay |
| **Cursor + VS Code Chat adapters** | IDE SQLite / `safeStorage` / quit-before-write | Add to matrix (FireConnect has them; the relay does not) |
| **Surgical config edits** | Preserve unrelated settings (MCP servers, user prefs) | Especially Codex TOML and OpenCode JSON |
| **Atomic writes** | Temp + rename for harness config files | Housekeeping win; small shared helper |
| **`uninstall` restores all harnesses** | Safe teardown story | Optional later; npm uninstall alone does not restore agent configs |
| **Attribution / privacy-safe request headers** where harnesses allow | `X-Title` / referer-style, no user/path/credential data | Evaluate against ai& gateway expectations |
| **Ground-truth harness status from real config** | Do not trust a stale “enabled” flag in CLI config | `status` probes each adapter’s files |
| **Foreign-writer detection** | Warn when another tool already manages the same files | Locked (Q5) |

### Take from nebius-tf-relay

| Pattern | Why | Fit for aiand |
| --- | --- | --- |
| **Harness detection + install hints** | `which` + official install URL; never install agents | Same |
| **Per-harness edge-case recipes** | Claude conflicting env, Codex empty-config defaults, OpenCode `enabled_providers`, Prime persistent dir, DeepSeek `DSH_HOME`, Grok isolated auth | Capture in adapters so we do not rediscover them |
| **Broader CLI harness set** | Prime, Hermes, Grok (and DeepSeek overlap with FireConnect) | P2 after the solid subset |
| **Optional session launchers** | `nebiusrelay claude` injects for one process only | Optional convenience *alongside* permanent `on` — not the default; live under `aiand` only (e.g. `aiand claude --session` or `aiand run-agent claude` — exact flag chosen in Phase 2) — **no** short shell aliases (`aclaude`, …) |
| **Live model catalog + defaults** | Fetch at wire time; cache with offline fallback | From ai& `/v1/models`, not Nebius |
| **Interactive picker when no harness named** | Detected agents only | `aiand init` or bare multi-select |
| **Shared Codex / ChatGPT backup manifest** | One restore path for the shared file | Same as FireConnect’s chatgpt alias |

### Do not port

| From | Skip | Reason |
| --- | --- | --- |
| Relay | Local proxy daemon | Server speaks native formats |
| Relay | Anthropic ↔ OpenAI / Responses ↔ chat translation | Not needed |
| Relay | Client-side `CostTracker` / `usage --last` | Use `aiand logs` / `aiand usage` |
| Relay | Model fallback + circuit breaker | Belongs in the inference service |
| Relay | Tavily-backed native `web_search` | Defer; Claude/Codex search is agent- or gateway-side |
| Relay | Self-update / `install.sh` bundle | npm package; existing release path |
| Relay | Telemetry collector | Out of scope |
| Relay | Bun/pnpm monorepo layout | Stay on Node 22 + `tsc` |
| FireConnect | Cognito localhost OAuth + PKCE as primary | aiand already has a working **device** grant against `api.aiand.com` |
| FireConnect | Shell env hook exporting the API key | Prefer baked literals or harness-native env refs; hooks are fragile across shells |
| FireConnect | `fireconnect key export` as a user-facing command | Internal resolver only; do not expose a key-dump command |
| FireConnect | Azure / Microsoft Foundry provider mode | Out of scope for `@aiand/cli` |
| FireConnect | FireRouter / Anthropic BYOK forwarding | Fireworks-specific routing product |
| FireConnect | Claude `usage` / `live` tmux meter / `demo` race | Redundant with platform `logs`/`usage`; expensive to maintain |
| FireConnect | Fireworks websearch MCP install | Only if ai& ships an equivalent MCP/server tool later |
| FireConnect | Fire Pass (`fpk_`) key-type branching | aiand key model is org-scoped `sk-` (+ env override) |
| FireConnect | Short shell aliases (`aclaude`, …) | Locked **no** (Q3) |
| Either | Migrating `~/.nebiusrelay/` / `~/.fireconnect/` installs | Fresh path; document coexistence (Q5) |

---

## Auth improvements

Device login stays the default. FireConnect’s auth surface is richer in ways that help CI, key rotation, and “I already have a key from the console.”

### Keep (aiand today)

- Device authorization grant → org-scoped machine key
- Auto-rotate near expiry / on rejection (for minted device credentials that have refresh)
- Profiles with separate credentials
- `AIAND_API_KEY` for ephemeral CI (writes nothing)
- `logout` clears local state; revoke rules below

### Adopt from FireConnect (additive)

| Addition | Behavior |
| --- | --- |
| **Paste an existing key** | `aiand login --paste` (TTY, masked) or `aiand login --api-key <sk-…>`; validate against the API before store |
| **`--with-token`** | Read key from stdin for non-interactive CI that still wants a *stored* profile credential (distinct from ephemeral `AIAND_API_KEY`) |
| **Already-signed-in UX** | Without `--force`, confirm before replacing (FireConnect asks; aiand today errors and points at `--force` — keep `--force`, soften the default path) |
| **Env vs store clarity** | When `AIAND_API_KEY` is set, login/store paths should say so clearly and not silently write a second key behind it (FireConnect’s mutual-exclusivity rule, adapted) |
| **Global status includes auth source** | Report whether the active token came from device credential, paste store, profile store, or `AIAND_API_KEY`, plus which **storage tier** holds the secret |
| **Minted-key state** | When device grant (or any CLI-mint path) creates a key, persist a small minted record (key id / revoke handle + display label) so logout knows it is *ours* — FireConnect’s `minted-key.json` pattern, adapted under `~/.config/aiand/` |
| **Paste clears mint record** | Storing a *different* key via paste / `--api-key` / `--with-token` clears the minted record so logout will not try to revoke a key we no longer hold (FireConnect) |

### Key storage tiers (Q6 — locked)

Follow FireConnect’s ladder; keep aiand’s **profiles** and XDG layout.

| Tier | When | What lives where |
| --- | --- | --- |
| **OS keychain** | Available and usable (macOS Keychain, Windows Credential Manager, Linux Secret Service when a session keyring works) | Profile credential metadata / config holds a **reference**; secret in keychain |
| **Encrypted file** | No usable keychain — default preference on Linux SSH/WSL (FireConnect remote-context policy) | AES-GCM (or equivalent) file under `~/.config/aiand/` (or XDG data), mode `0600` |
| **Plaintext file** | Last resort when neither above works | `credentials.json` (or per-profile secret file) mode `0600` — today’s behavior |

Rules:

- `aiand status` / `aiand whoami` (extended) report which tier is active.
- Do **not** invent user-facing APIs like `aiand key export`; resolution stays internal for harness bake / API calls.
- Harness configs still receive **baked literals** (or IDE `safeStorage`) at `on` time — same as FireConnect.
- Profiles remain first-class: each profile has its own secret slot; `--profile` / `AIAND_PROFILE` unchanged.
- Optional override env (FireConnect has `FIRECONNECT_KEY_STORAGE`) may exist later for tests/CI; not a Phase 1 product surface requirement.

### Paste-login revoke (Q7 — locked; same as FireConnect)

| Key origin | On `aiand logout` |
| --- | --- |
| **Minted by this CLI** (device grant / browser mint) | Clear local secret; **offer** to revoke server-side (TTY). `--revoke` (or keep today’s default-revoke for minted device keys) skips the question and revokes. `--keep-remote` skips revoke. Clear minted-state record either way. |
| **Pasted / `--api-key` / `--with-token`** | Clear local secret **only**. Do **not** offer or attempt server revoke — we did not mint it and must not revoke a shared console key on the user’s behalf. |
| **`AIAND_API_KEY` env only** | Nothing stored; logout is a no-op for store; note that the env var still applies until unset. |

If a paste replaces a previously minted key, drop the minted record when the stored secret changes (FireConnect `persistApiKey` behavior) so a stale revoke offer cannot target the wrong key.

### Explicitly not replacing

- Do **not** switch primary sign-in to localhost callback OAuth (FireConnect’s Cognito path). Device grant already matches headless / WSL / SSH well, and `--no-browser` exists.
- Do **not** add a second auth product — still one story: `aiand login`. Harness `on` reuses the session.

### R4 (auth for wiring) still holds

Key written into agent config comes from the active session (honour `--profile`). If unsigned-in, harness commands offer `aiand login` rather than asking for a raw key in the harness flow. `AIAND_API_KEY` remains valid for wiring in CI without a stored session.

---

## The surface

**Locked (Q2):** primary product surface is FireConnect-style **`aiand <harness> on|off|status`** (permanent native config; stock binary works afterwards). Default verb with no subcommand is `on` (same as FireConnect: `aiand claude` ≡ `aiand claude on`). Optional session launchers follow **nebiusrelay** (one-shot env) and never replace `on`. **`aiand init`** is discovery/batch only — not the primary UX. Harness nouns are short ids: `claude`, `codex`, … (Q8). **No** short shell aliases such as `aclaude` / `acodex` (Q3).

```bash
# Sign-in (existing + FireConnect-inspired additions)
$ aiand login                         # device grant (default) — mints + records minted state
$ aiand login --paste                 # paste an existing sk- key (no mint record)
$ aiand login --with-token < key.txt  # non-interactive store
$ aiand logout                        # minted → offer/attempt revoke; pasted → local only
$ aiand logout --keep-remote          # local clear only

# Primary UX — wire permanently (FireConnect shape)
$ aiand claude                        # default verb: on
$ aiand claude on
$ aiand claude off
$ aiand claude status
$ aiand claude status --json
$ aiand codex on --model …
$ aiand chatgpt off                   # alias → codex shared config
$ aiand cursor on                     # quit Cursor first
$ aiand vscode on

# Batch / discovery only (not primary; wraps the same adapters)
$ aiand init                          # detect installed agents, ask which to wire
$ aiand init --all                    # wire everything detected
$ aiand init --off                    # restore all managed agents
$ aiand init --off claude             # same as `aiand claude off`

# Inspect (auth + harnesses)
$ aiand status                        # sign-in + key source + storage tier + per-harness wiring
$ aiand status --json
$ aiand whoami                        # identity-only (unchanged)

# Optional session launchers (nebius convenience; do not replace `on`)
# Always under `aiand`, never short aliases; exact flag chosen in Phase 2:
$ aiand claude --session [--model …] -- …
$ aiand run-agent claude [--model …] -- …
```

**Product call (locked):** `on` / `off` / `status` is the primary product (FireConnect). `init` is the discovery/batch wrapper only. Launchers are optional for people who refuse permanent config changes. Users invoke stock binaries after `on` (`claude`, `codex`, …).

---

## Agent matrix

Union of FireConnect’s seven harnesses and the relay’s eight (+ ChatGPT). **First-ship priority is locked (Q1):** Claude Code, Codex, and OpenCode ship first (P0); then ChatGPT Desktop / Cursor / Pi; then VS Code and relay-only P2 harnesses. Agent ids match FireConnect: `claude`, `codex` (not `claude-code`).

| Agent id | Binary / app | Wire format | Config strategy for ai& | Upstream notes | v1 priority |
| --- | --- | --- | --- | --- | --- |
| `claude` | `claude` | Anthropic Messages | Permanent `~/.claude/settings.json` per [Claude recipe](#claude-code-recipe-q4--locked); slot mapping from catalog | Both; FireConnect permanent-config pattern | **P0** |
| `codex` | `codex` | OpenAI Responses | `~/.codex/config.toml` provider block: `base_url`, `wire_api = "responses"`, model + catalog | Both; FireConnect bakes bearer literal | **P0** |
| `chatgpt` | ChatGPT Desktop | Same as Codex | Alias of `codex`; shared file; quit app before write | Both | **P1** |
| `opencode` | `opencode` | OpenAI-compatible | Provider entry in `opencode.json` (or highest-precedence inject); lockdown clutter providers | Both | **P0** |
| `pi` | `pi` | OpenAI-compatible | `~/.pi/agent/{settings,models,auth}.json` (FireConnect persistent path) or temp overlay (relay launch style) | Prefer FireConnect’s persistent three-file snapshot for `on` | **P1** |
| `cursor` | Cursor IDE | OpenAI-compatible | `state.vscdb` + IDE safeStorage; **quit first** | FireConnect only | **P1** |
| `vscode` | VS Code Chat | OpenAI-compatible | `chatLanguageModels.json` + `state.vscdb` + safeStorage; **quit first** | FireConnect only | **P2** |
| `deepseek` | `dsh` | OpenAI-compatible | `~/.dsh/settings.yaml` + `.credentials.yaml`; throwaway `DSH_HOME` if UI-remembered model wins | Both | **P2** |
| `prime` | `prime-agent` | OpenAI-compatible | aiand-owned dir under `~/.config/aiand/agents/prime/` — never touch `~/.prime/agent` | Relay only | **P2** |
| `hermes` | `hermes` | OpenAI-compatible | Home overlay (`HERMES_HOME`) | Relay only | **P2** |
| `grok` | `grok` | OpenAI-compatible | Isolated auth file + model catalog URL + env base URL | Relay only | **P2** |

Detection never installs agents. Missing binary → print official install command + docs URL (relay `HARNESS_INSTALL` pattern).

Registry shape: one adapter module per agent with `on` / `off` / `status` / `detect` / `resolveKey` (FireConnect `defineHarness` + relay install-hint fields).

---

## Per-agent wiring notes

Hairy bits already paid for upstream. Capture them in adapters.

### Claude Code recipe (Q4 — locked)

Permanent native config, **no local proxy**. Match FireConnect’s “write `settings.json`, stock `claude` works afterwards” model; use Anthropic-compatible auth (ai& is not Fireworks — do not invent an `X-Fireworks-*`-style header unless the gateway later requires one).

**Write** `~/.claude/settings.json` (mode `0600`) with an `env` block:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.aiand.com",
    "ANTHROPIC_AUTH_TOKEN": "<active sk- key>"
  }
}
```

| Rule | Detail |
| --- | --- |
| **Auth var** | Prefer **`ANTHROPIC_AUTH_TOKEN`** (baked literal) over `ANTHROPIC_API_KEY`. Goal: avoid Claude Code’s interactive “custom API key” prompt when possible. |
| **No `apiKeyHelper`** | Same as FireConnect’s permanent path — helper scripts are fragile and not the default. |
| **No custom-header auth by default** | FireConnect’s `ANTHROPIC_CUSTOM_HEADERS` / `X-Fireworks-Api-Key` exists because Fireworks auth is non-standard. `api.aiand.com` is Anthropic Messages-compatible (`/v1/messages`); the CLI already authenticates with Bearer `sk-`. Use standard Claude env auth. |
| **Clear conflicts in managed `env`** | When wiring, remove/overwrite managed conflict keys in settings `env`: `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, stale model-override vars we own — so a leftover Anthropic key in settings cannot win over the ai& token. |
| **Pre-approve shell keys** | If `process.env.ANTHROPIC_API_KEY` is set, pre-approve it in `~/.claude.json` → `customApiKeyResponses.approved` (FireConnect) so first launch does not prompt. |
| **Slots** | Per-slot defaults from live `/v1/models` (Opus / Sonnet / Haiku / vision / subagent). FireConnect wizard + flags are the UX; model ids come from ai&. |
| **Snapshot** | Byte-for-byte backup of `settings.json` (and any companion files we touch) before write; `off` restores. |
| **Base URL path** | Host is locked to `https://api.aiand.com`. Exact path suffix (root vs `/v1`) is confirmed in Phase 1 against live `/v1/messages`; do not change the auth *shape* above without a PRD update. |
| **Fallback if AUTH_TOKEN fails verification** | If Phase 1 proves Claude Code will not send `ANTHROPIC_AUTH_TOKEN` correctly to this gateway, switch the baked var to `ANTHROPIC_API_KEY` **and** keep the `customApiKeyResponses` pre-approval path. Document the switch in the adapter; do not re-open “custom header vs proxy” design. |

Optional (evaluate, do not block Phase 1): deny Anthropic server-side tools the gateway cannot run; ai& search MCP only if/when the platform ships one; helpful defaults (`ENABLE_TOOL_SEARCH`, max output tokens, statusLine) — never replace a user-owned `statusLine`.

### Codex / ChatGPT

- Native path: provider in `~/.codex/config.toml` with `wire_api = "responses"`, `base_url` → `https://api.aiand.com/v1` (exact path confirmed against gateway).
- Write a model catalog file Codex can read; resolve defaults from `/v1/models`.
- Surgical TOML edits — preserve `[[mcp_servers]]` and unrelated keys (FireConnect `toml-patch` lesson).
- First-run empty config: only then inject generic user defaults (`approval_policy`, `sandbox_mode`); never overwrite a non-empty user file beyond the managed provider block.
- ChatGPT Desktop shares this file — managing Codex **is** managing ChatGPT. One backup; quit Desktop before write (FireConnect asks; `--force` escapes).

### OpenCode

- Merge provider into `~/.config/opencode/opencode.json` (FireConnect) or inject via highest-precedence content (relay). Prefer the permanent merge for `on`.
- Force model selection so a user global default does not win.
- Lockdown: `enabled_providers` + disable Zen/`opencode` provider clutter.
- Whitelist curated models so models.dev merge does not dump hundreds of unrelated ids.

### Pi

- FireConnect: snapshot/restore `settings.json`, `auth.json`, `models.json` under `~/.pi/agent/`.
- Custom `openai-completions` provider; baked key literal mode `0600`.
- Relay’s temp-dir launch remains available only if we ship session launchers.

### Cursor / VS Code

- Quit the IDE before `on` / `off` or the running app flushes state over ours.
- Keys in IDE `safeStorage`, not plaintext JSON where the IDE supports it.
- `off` removes only what aiand registered (IDE path is not always full-file restore).

### Prime / Hermes / DeepSeek / Grok

- **Prime:** persistent aiand-owned directory — Prime bootstraps auth/sessions/IPython in its config dir; a throwaway dir re-bootstraps every launch.
- **Hermes:** home overlay over `~/.hermes`.
- **DeepSeek:** `--patch` loses to UI-remembered model; use throwaway `DSH_HOME` when needed; FireConnect’s credentials file path for permanent `on`.
- **Grok:** isolate auth file so xAI login is not used; make it obvious this is ai&, not xAI.

---

## Coexistence with other writers (Q5 — locked)

Multiple tools may write the same harness files (`~/.claude/settings.json`, `~/.codex/config.toml`, OpenCode JSON, Pi auth, IDE DBs). Product rule:

1. **Detect foreign managed markers** before `on` (and surface them in `status`). Known examples to probe for:
   - FireConnect: `managedBy: "fireconnect"`, `X-Fireworks-Api-Key` / Fireworks base URLs, fireconnect-owned IDE model lists
   - Nebius relay: loopback / `127.0.0.1` proxy base URLs, nebiusrelay-owned provider blocks / markers
   - Any other recognizable “managed by \<tool\>” stamps adapters learn over time
2. **Warn clearly** — name the other tool when known, say which files would be overwritten, and that last writer would otherwise win.
3. **Require explicit overwrite** — refuse to write unless the user passes `--force` (or answers yes on a TTY confirm). Do **not** silently clobber foreign-managed config.
4. **Snapshot still protects pre-aiand state** — the first successful aiand `on` still takes a byte-for-byte backup of whatever was on disk *before aiand wrote*, so `off` restores that pre-aiand snapshot (including a prior fireconnect/nebiusrelay config if the user forced overwrite). Restoring does not re-register the foreign tool; it only puts files back.
5. **No migration** of `~/.fireconnect/` / `~/.nebiusrelay/` installs — fresh aiand path only; document the conflict in help/status copy.
6. **aiand markers** — our own writes carry recognizable ownership (`managedBy: "aiand"` or equivalent per harness format) so *we* can strip surgically on `off` and so other tools can detect us the same way.

`status` should report `foreign: fireconnect|nebiusrelay|…|none` (or similar) per harness when markers are present.

---

## Requirements

### R1 — Detect what’s installed

Bare `aiand init` (and harness commands that need a binary) find agents on PATH and explain how to install missing ones. Never touches one the user did not pick.

**Done when** a machine with two agents lists exactly those two; a machine with none says so and prints install instructions.

### R2 — Write native config, not a required wrapper

Each agent gets config in its own format so the stock binary works afterwards. After `aiand claude on`, plain `claude` reaches ai&.

**Done when** after `aiand claude on`, plain `claude` in a new shell reaches ai&.

### R3 — Snapshot before writing

Anything modified is backed up first. `off` restores byte for byte (file-based harnesses), including “file did not exist before.” IDE harnesses remove only managed registrations.

Shared Codex / ChatGPT config uses one backup manifest.

**Done when** `on` then `off` leaves config identical to before (file harnesses).

### R4 — Use the session, never a pasted key in the harness flow

Key written into agent config comes from the active `aiand login` session (or `AIAND_API_KEY`). If unsigned-in, harness `on` offers login. Honour `--profile`. Paste belongs on `aiand login`, not as a prompt inside every harness.

**Done when** `claude on` works with no `AIAND_API_KEY` set after device login, and work/personal profiles can be wired separately.

### R5 — Idempotent and honest about state

Second `on` is a no-op for backups (no second snapshot that clobbers the real backup). `aiand status` / `aiand <harness> status` report wiring, provider, model, auth source, storage tier, and foreign-writer detection.

**Done when** `on` → `on` → `off` restores the original; status is truthful after each step.

### R6 — Sensible model defaults, overridable

Defaults from the live catalog, including per-slot mapping where an agent has tiers. `--model` / slot flags override. Retired catalog ids must not be written.

**Done when** defaults resolve from `/v1/models` and a removed model does not leave a dead name in config.

### R7 — Scriptable

Every command takes `--json`; machine output on stdout, human on stderr; meaningful exit codes.

**Done when** `aiand status --json | jq` works and a failed `on` exits non-zero with the reason on stderr.

### R8 — One adapter module per agent

Mirror FireConnect’s harness registry + the relay’s detect/install-hint fields: detect binary, install hint, `on`, `off`, snapshot paths, `status` probe. Adding an agent = one module + one registry line.

**Done when** Claude and Codex ship as separate adapters with shared snapshot helpers; a third agent does not require touching their files.

### R9 — Optional session launch without permanent write

A launcher path can run with env/config for this process only, leaving user files untouched — for users who refuse permanent `on`. Invoked under `aiand` only (e.g. `aiand claude --session` or `aiand run-agent claude`; exact naming in Phase 2) — **never** as `aclaude` / similar. Does not change the locked primary UX (`on` / `off` / `status`).

**Done when** the launcher works without having run `on`, and agent settings are unchanged afterwards.

### R10 — Auth paths cover browser, paste, and CI

`aiand login` supports device grant (default), paste / `--api-key`, and `--with-token`. `AIAND_API_KEY` remains the no-store CI escape hatch. Minted vs pasted revoke follows Q7. Secret storage follows Q6 tiers.

**Done when** all three stored-login paths validate before write; env-key interaction is documented and enforced; logout revoke behavior matches the table in Auth.

### R11 — Foreign writers require explicit overwrite

`on` / `init` refuse to clobber fireconnect / nebiusrelay / other managed markers without `--force` or confirmed TTY consent (Q5).

**Done when** a machine with FireConnect-managed Codex refuses `aiand codex on` until forced, and after a forced `on` → `off` the snapshot restores the pre-aiand bytes.

---

## Not in this version

1. **A local proxy daemon** — server speaks the wire formats natively.
2. **Client-side cost metering / live Claude usage TUI** — `aiand logs` / `aiand usage` are the source of truth.
3. **Model fallback and circuit breaking** — inference service / auto-router.
4. **A second auth product** — one path: `aiand login` (+ env key for CI).
5. **User-facing key export / dump commands** — internal resolver only.
6. **Tavily / Fireworks-style websearch MCP** — defer until ai& has a server-side or MCP story.
7. **Azure / Foundry / FireRouter / Fire Pass** — FireConnect-specific.
8. **Migrating `~/.fireconnect/` or `~/.nebiusrelay/` installs** — fresh path; detect + warn only (Q5).
9. **Self-update install.sh** — stay on npm.
10. **Short shell aliases** (`aclaude`, `acodex`, …) — do not ship (Q3).

---

## Delivery plan

Matches locked Q1 priority (Claude / Codex / OpenCode first) and locked Q2 FireConnect surface (`on` / `off` / `status` primary).

| Phase | Scope | Exit criteria |
| --- | --- | --- |
| **0** | Shared detect + snapshot/restore + harness registry + status plumbing; login paste / `--with-token`; minted-state + revoke rules; secret-store tier plumbing (or staged behind plaintext with tier API ready); foreign-marker helpers | Unit tests for backup/restore round-trip; login paths validate before store; logout revoke matrix covered |
| **1** | P0: `claude` + `codex` via `on` / `off` / `status` with locked Claude recipe; `aiand status` aggregates; foreign-marker gate on `on` | Plain `claude` and `codex` hit ai& after `on`; AUTH_TOKEN (or documented API_KEY fallback) verified live |
| **2** | P0 complete: `opencode` + `init` multi-select (batch/discovery only) + optional session launchers (under `aiand`, no short aliases; pick exact launcher flag here) | Spawned config + ephemeral launch paths |
| **3** | P1: `chatgpt` alias + `cursor` (quit-before-write) | Desktop + CLI share Codex restore; Cursor round-trip |
| **4** | P1/P2: `pi`, `vscode`, then remaining P2 harnesses as demand warrants | Each adapter green against live `/v1/*` |

Start with Phase 1 end-to-end before expanding the matrix.

---

## Open questions

None. Product decisions Q1–Q8 are locked. Remaining implementation details (exact optional session-launcher flag spelling in Phase 2; Claude `BASE_URL` path suffix verification in Phase 1) are engineering follow-through, not open product questions.

---

## Locked decisions (Q1–Q8)

| ID | Decision |
| --- | --- |
| **Q1** | **First-ship agent set:** **Claude Code, Codex, OpenCode** (P0); then ChatGPT Desktop / Cursor / Pi (P1); then VS Code + relay-only harnesses (P2). Matrix priorities above are definitive, not tentative. |
| **Q2** | **FireConnect-style primary UX:** `aiand <harness> on\|off\|status` (default verb = `on`). Permanent native config; no daemon. `aiand init` is discovery/batch only. Session launchers are optional convenience under `aiand`, never the default path. |
| **Q3** | **No short aliases.** Do not ship `aclaude` / `acodex` / … Session launchers, if any, live under `aiand` only. Users run stock `claude` / `codex` after `on`. |
| **Q4** | **Claude permanent recipe:** `~/.claude/settings.json` with `ANTHROPIC_BASE_URL=https://api.aiand.com` + baked `ANTHROPIC_AUTH_TOKEN=<sk-…>` (mode `0600`); no `apiKeyHelper`; no Fireworks-style custom header by default; clear conflicting managed env; pre-approve shell `ANTHROPIC_API_KEY` in `~/.claude.json`. See [Claude Code recipe](#claude-code-recipe-q4--locked). |
| **Q5** | **Detect foreign markers → warn → require explicit overwrite (`--force` / confirm).** Snapshot still captures pre-aiand bytes. No silent last-writer-wins. No migration of other tools’ installs. |
| **Q6** | **FireConnect-style storage tiers** (keychain → encrypted file → plaintext `0600`), merged with aiand **profiles** + XDG paths. Config/metadata holds refs when possible; harnesses bake literals. No user-facing key-export command. |
| **Q7** | **Same as FireConnect:** logout revokes (or offers revoke) only for **minted** keys; pasted / `--api-key` / `--with-token` keys are cleared locally only. Replacing a minted key with a paste clears minted state. |
| **Q8** | **Short harness ids:** `claude`, `codex`, … Command surface `aiand claude on`, `aiand codex off`. Not `claude-code`. |

---

## House conventions

Align with existing `@aiand/cli` (not the relay’s Bun/pnpm monorepo, not FireConnect’s `~/.fireconnect/cli` git install):

- **Node 22**, TypeScript, plain `tsc` — no bundler.
- **Minimal new runtime deps** — TOML writer/patcher for Codex is the first likely justified dependency (FireConnect uses `smol-toml`; evaluate before adding). Keychain / encrypted-file may pull a small secret-store dependency (evaluate FireConnect’s `cross-keychain` approach before inventing one).
- **One module per command** exporting `help` and `run(argv)`, registered in `COMMANDS`.
- **Agent adapters** under e.g. `src/agents/<id>.ts`, registered in a single array / map (`on` / `off` / `status` / `detect`). Ids are short (`claude`, not `claude-code`).
- **Config** in `~/.config/aiand/config.json`; credentials / secret store per Q6; agent snapshots under `~/.config/aiand/backups/`.
- Agent configs live where each tool expects them.
- Comments explain why, not what.
- `--json` / stderr-human / meaningful exit codes on every command.
- Atomic write helper for files we own or patch.

---

## Decision summary

| Topic | Decision |
| --- | --- |
| Daemon | **No** |
| First-ship agents | **Claude, Codex, OpenCode** (P0) (Q1) |
| Primary UX | FireConnect-style **`aiand <harness> on\|off\|status`** (Q2) |
| Harness ids | Short: **`claude`**, **`codex`**, … (Q8) |
| Short aliases | **No** (`aclaude`, …) (Q3) |
| Batch / discovery | **`aiand init`** wrapper only — not primary |
| Session launchers | Optional (relay-inspired), not default; under `aiand` only |
| Claude auth | Permanent settings.json: **BASE_URL + AUTH_TOKEN**; no proxy; no custom-header default (Q4) |
| Coexistence | Detect foreign markers; warn; **explicit overwrite** (Q5) |
| Auth | Keep device grant + profiles; **add paste / token paths**; FireConnect **storage tiers** (Q6); FireConnect **minted vs paste revoke** (Q7) |
| Spend truth | Platform `logs` / `usage`, not client meters |
| IDE harnesses | Yes (from FireConnect), after CLI P0 |
| Relay-only harnesses | P2 |
| Package / runtime | Existing `@aiand/cli` conventions |

---

*Revised 2026-09-07: locked Q1 (first-ship agents) and Q2 (FireConnect `on`/`off`/`status` primary; `init` batch-only). Q3–Q8 unchanged. No open product questions remain. Next: Phase 0–1 (auth paste + tiers + Claude/Codex) end to end.*
