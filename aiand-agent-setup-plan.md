# Plan — Agent setup (+ auth polish) for `@aiand/cli`

## Context

Implement the PRD at `aiand-init-prd.md` (read it first; decisions Q1–Q8 are locked there). Today the CLI handles sign-in/inference/usage; the missing piece is **agent setup**: `aiand <agent> on|off|status` writes native config so stock `claude`/`codex`/etc. run against `api.aiand.com` — no daemon, no proxy — plus `aiand init` (batch/discovery), `aiand status` (aggregate), `aiand run-agent <id>` (one-process session launcher), and auth polish (paste login, secret-storage tiers, minted-vs-pasted logout).

Grounding facts already verified this session:
- Gateway: `POST /v1/messages|/v1/responses|/v1/chat/completions` exist (401 unauth); `GET /v1/models` and `GET /v1/api.json` are public. Claude base = `https://api.aiand.com` (client appends `/v1/messages`); Codex/OpenCode base = `https://api.aiand.com/v1`.
- Repo: Node 22 ESM, plain `tsc`, **zero runtime deps enforced by `scripts/check-dist.mjs`** — keep it that way (user-locked). Dispatch hook: `src/index.ts` `findCommand` miss → 127; agent nouns `claude/codex/chatgpt/opencode/pi/cursor/vscode/deepseek/prime/hermes/grok` collide with nothing; `init`, `status`, `run-agent` are free names.
- Auth: `Credential = {access_token, refresh_token, expires_at, user?, org?}` in `<configDir>/credentials.json` (0600); device grant `/auth/device/{code,token,logout}`; `openSession` prefers `AIAND_API_KEY`, auto-rotates ≤3d to expiry via `rotateTokens`; key validation = `getUser` (`GET /api/user`, Bearer).
- Prior art read: FireConnect `/home/fenil/fireconnect/packages/setup-cli` (engine/adapter split, byte-snapshot, TOML string surgery, AES-256-GCM file store, minted-key revoke, masked `readSecret`) and relay `/home/fenil/nebius-tf-relay/packages/cli` (detect/install-hints, Codex catalog JSON, Claude conflicting-env list, per-harness recipes). Neither has foreign-writer detection — built fresh here.
- This machine (WSL): `claude`, `codex`, `pi` on PATH (Windows shims); `opencode`, `code` missing.

Every step below is executable top-to-bottom with zero design decisions. Where a step says "port", the source file path is given.

## Code sourcing rules (apply to every step)

**Copy from upstream, never write from scratch.** Both upstreams are Apache-2.0/MIT and the owner has written permission to reuse their code. For every "port X" step: open the named upstream file, copy the relevant function/module into the target file, then modify — do not retype or reinvent. Rationale: battle-tested code + big token/time savings. Exceptions (built fresh, both upstreams lack them): `src/agents/foreign.ts` detection matrix, the aiand-specific login/logout/whoami auth changes, `src/agents/registry.ts`, the agent-noun dispatch in `src/index.ts`.

**Rename map — apply while porting.** Mechanical substitution on every copied block, so shipped code never carries upstream vocabulary:

| Upstream literal | aiand literal |
| --- | --- |
| `fireworks` / `fireworks-ai` (provider ids, table headers) | `aiand` |
| `api.fireworks.ai` / any upstream base URL | `api.aiand.com` |
| `FIREWORKS_API_KEY` (env var) | `AIAND_API_KEY` |
| `fw_` key prefix checks | `sk-` |
| `nebius` / `nebiusrelay` (ids, markers, env vars) | `aiand` |
| `NEBIUS_API_KEY` | `AIAND_API_KEY` |
| `~/.fireconnect/` / `~/.nebiusrelay/` (state dirs) | `~/.config/aiand/` via `configDir()` |
| `FireConnect` / `Fireworks` / `Nebius` in strings & comments | `ai&` / `aiand` |
| upstream model ids / router aliases (e.g. `deepseek-flash-latest`, `glm-latest`, `DEFAULT_MODEL_ID`) | ids resolved from the live aiand `/v1/models` catalog (never hardcode) |

Porting also means: strip upstream-only branching while copying — Azure/Foundry, FireRouter/BYOK headers, Fire Pass `fpk_` key types, gRPC-web mint, live-usage tmux, websearch MCP, shell env hooks, telemetry headers, self-update, daemon/proxy/cost-meter code and its imports. Cut those blocks; do not leave dead stubs. ESM `.mjs` → TypeScript `.ts` with the repo's strict tsconfig: add types, replace JSDoc typedefs with exported `type` declarations, keep function bodies otherwise intact.

**Zero-mention rule (user-locked).** Neither upstream name (nor fireworks/nebius vocabulary) is mentioned anywhere in this repo's shipped text: no `src/`, no `dist/`, no `test/`, no README/CHANGELOG, no help/error/status strings, no comments. The upstream repos appear only in these planning docs (`aiand-init-prd.md`, this plan) as port sources — never in the aiand codebase. `test/hygiene.test.mjs` (step 8) enforces the grep. The one functional necessity — foreign-writer detection must probe for the other tools' on-disk markers (PRD Q5) — is satisfied by `src/agents/foreign.ts` assembling those strings at runtime from fragments, so the literals exist nowhere in the repo.

## Shared contracts (freeze before any parallel work)

All new code under `src/`. Conventions: one module per command exporting `help` + `run(argv)`; `--json` machine output on stdout, human on stdout, errors via `CliError` to stderr; comments explain why.

**`src/agents/types.ts`** — the adapter interface every phase implements:

```ts
import type { Model } from "../api/models.js";

export type Verb = "on" | "off" | "status";
export type ForeignTool = string;             // display id of a foreign config writer, assembled at runtime by foreign.ts — never a literal here (zero-mention rule)

export type DetectResult = { installed: boolean; path: string | null };
export type ProbeResult = {
  active: boolean;                      // aiand routing live, ground truth from real files
  foreignTool: ForeignTool | null;
  model: string | null;
};

export type EnableInput = {
  apiKey: string;                       // resolved session key, baked literal
  model: string;                         // resolved default or --model
  slots: Record<string, string>;         // claude only: opus/sonnet/haiku
  catalog: Model[];                      // live /v1/models
  home: string;                          // agentHome()
};

export type AgentAdapter = {
  id: string;                            // short: "claude", "codex", ...
  label: string;                         // "Claude Code"
  bin: string;                           // PATH binary: "claude", "codex", "dsh", ...
  install: { command: string; url: string };
  aliases?: string[];                    // e.g. codex: ["chatgpt"]
  detect(): DetectResult;                // which/where probe
  managedFiles(): string[];              // absolute paths this adapter touches
  probe(): Promise<ProbeResult>;         // read real config, no flags trusted
  enable(input: EnableInput): Promise<{ model: string; filesWritten: string[] }>;
  disable(): Promise<void>;              // strip aiand writes AFTER manifest restore
  sessionLaunch?(model: string | undefined): {
    env: Record<string, string>;         // added to child env
    clear: string[];                     // deleted from child env
    args?: string[];                     // extra CLI args before passthrough
  };
  launcherOnly?: boolean;                 // hermes/grok: on/off unsupported
};
```

**`src/agents/paths.ts`**: `export function agentHome(): string { return process.env.AIAND_HOME || homedir(); }` — every adapter resolves its config files from `agentHome()`. Tests set `AIAND_HOME` + `AIAND_CONFIG_DIR`.

**Other frozen literals**:
- Backups: `<configDir()/backups/<agentId>/latest.json` manifest `{createdAt: string, files: {path: string, backupPath?: string, existed: boolean}[]}` (0600) + sibling `<ISO-timestamp>/` dir holding byte-for-byte copies. Port relay `packages/cli/src/lib/codex-app.ts` `backupFiles`/`restoreCodexApp` (lines 234–342).
- Secret store (Phase 0): encrypted blob `<configDir()/secret-store.json`, key `<configDir()/secret-store.key` (32 random bytes, 0600), AES-256-GCM, format `[version=1][iv 12][tag 16][ciphertext]` — port `/home/fenil/fireconnect/packages/setup-cli/lib/keys/builtin-file-secret-store.mjs` (whole file). Env override `AIAND_SECRET_STORE_MASTER_KEY` (64 hex) for tests. Tier env `AIAND_KEY_STORAGE` = `keychain|file|plaintext`.
- Codex: provider id `aiand` (`[model_providers.aiand]`), auth env for session launches `AIAND_CODEX_AUTH_TOKEN`, catalog file `~/.codex/aiand-models.json` (aiand-owned, deleted on `off`).
- OpenCode: provider id `aiand` (NOT `opencode` — that id collides with Zen which we disable), `disabled_providers: ["opencode"]`, `enabled_providers: ["aiand"]`.
- Claude slots: `main→ANTHROPIC_MODEL`, `opus→ANTHROPIC_DEFAULT_OPUS_MODEL`, `sonnet→ANTHROPIC_DEFAULT_SONNET_MODEL`, `haiku→ANTHROPIC_DEFAULT_HAIKU_MODEL` (+`ANTHROPIC_SMALL_FAST_MODEL` same value as haiku).
- Exit codes: unknown agent noun → 127; not signed in during `on` → 2 (existing `NotLoggedInError`); foreign-config refusal → 1 via `CliError` with hint `Pass --force to overwrite it.`.
- Model defaults (`src/agents/catalog.ts`): `PREFERRED_DEFAULTS = ["zai-org/glm-5.3", "moonshotai/kimi-k3", "qwen/qwen3.8-27b", "google/gemma-4-31b-it"]` → first id present in live catalog; else first catalog entry. Slot mapping: `opus` = highest `output_per_1m` among tool-calling models, `sonnet` = default, `haiku` = lowest `input_per_1m` among tool-calling models. Retired ids never written (everything resolves through the live/cached catalog; profile.model honored first).

## Approach — Phase 0 (foundation + auth), two parallel workers

### Worker A — shared agent foundation (new files only, no edits to existing modules)

1. **`src/io/atomic.ts`**: `writeFileAtomic(path, data, mode?)` — write `path.tmp-<pid>` then `rename`, chmod after. Port FireConnect `lib/io/atomic-write.mjs` shape.
2. **`src/cli/prompt.ts`**: `isInteractive()` (stdin+stdout TTY), `confirm(message, {default: boolean}): Promise<boolean>` (readline; non-TTY returns default), `readSecret(prompt): Promise<string>` (masked `*` echo, raw mode, backspace, Ctrl-C → exit 130; non-TTY/Windows falls back to visible readline line). Port `/home/fenil/fireconnect/packages/setup-cli/lib/ui/read-secret.mjs`.
3. **`src/agents/detect.ts`**: `detectBinary(bin): DetectResult` via `spawnSync(process.platform === "win32" ? "where" : "which", [bin])`, first stdout line. `INSTALL_HINTS: Record<string, {command, url}>` — claude: `npm install -g @anthropic-ai/claude-code` / `https://docs.anthropic.com/en/docs/claude-code/setup`; codex: `npm install -g @openai/codex` / `https://github.com/openai/codex`; opencode: `npm install -g opencode-ai@latest` / `https://opencode.ai`; pi: `npm install -g @earendil-works/pi-coding-agent` / `https://pi.dev/docs/latest/quickstart`; deepseek: `npm install -g @deepseek-ai/dsh` / `https://github.com/deepseek-ai/deepseek-harness`; prime: `curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh` / `https://github.com/PrimeIntellect-ai/prime-agent`; hermes: `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash` / `https://hermes-agent.nousresearch.com/docs/`; grok: `curl -fsSL https://x.ai/cli/install.sh | bash` / `https://github.com/xai-org/grok-build` (values from relay `packages/cli/src/lib/harness.ts`).
4. **`src/agents/snapshot.ts`**: `snapshotFiles(agentId, files: string[]): Promise<string>` (writes manifest + timestamped copies; skips files that don't exist → `existed: false`), `restoreSnapshot(agentId): Promise<boolean>` (false = no manifest; copies back or deletes per `existed`; removes manifest + snapshot dir), `hasSnapshot(agentId): Promise<boolean>`. Port relay `codex-app.ts` backup/restore mechanics minus daemon parts.
5. **`src/agents/foreign.ts`**: `detectForeign(paths, readers): Promise<ForeignTool | null>` — read each managed file's text and match the upstream signatures: FireConnect-managed (`api.fireworks.ai` hostnames, `X-Fireworks-Api-Key` custom header, `[model_providers.fireworks-ai]`, `managedBy": "fireconnect"` stamps) and relay-managed (loopback `127.0.0.1`/`localhost` base URLs, `nebiusrelay` substrings such as `# >>> nebiusrelay`). Per the zero-mention rule, every probe string and display label (the `ForeignTool` value) is assembled at runtime from fragments — `["fire", "works"].join("")` style — so the literal never appears in `src/`, `dist/`, or user-visible output. Order: FireConnect probes first, then relay. Also export `foreignMarkerFixtures(): { fireconnectSettings: string; codexConfig: string }` (same fragment technique) so tests can plant realistic foreign configs without the literals.
6. **`src/agents/catalog.ts`**: `getCatalog(baseUrl, session | null): Promise<Model[]>` — reuse `listModels` from `src/api/models.ts`; cache `<configDir()/model-catalog.json` `{fetchedAt, baseUrl, models}` with 6h TTL; on fetch failure use stale cache, else throw `CliError("Could not reach the model catalog.", {hint: "Check your network and retry."})`. Plus `resolveDefault(models, profileModel?)`, `resolveSlots(models)` per the frozen literals.
7. **`src/agents/session.ts`**: `requireSessionKey(profileOverride?): Promise<{key: string; source: "env" | "device" | "paste"; profile: string}>` — `openSession` under the hood; on `NotLoggedInError`: if TTY, `confirm("Not signed in. Run aiand login now?")` → invoke device login (import `run` from `src/commands/login.ts` with same profile flag) then retry once; else rethrow.
8. **Tests** (`test/snapshot.test.mjs`, `test/catalog.test.mjs`, `test/hygiene.test.mjs`): snapshot round-trip incl. "file did not exist" and idempotent re-snapshot (existing manifest + aiand-active → no new backup); catalog default/slot resolution from a fixture model list; cache TTL expiry via injected `fetchedAt`. Hygiene test greps `src/`, `dist/`, `test/`, `README.md`, `CHANGELOG.md` for `/fireworks|fireconnect|nebius/i` and fails on any hit (planning docs — `aiand-init-prd.md`, `Aegets_plan.md` — are not shipped text and are excluded); it also asserts `foreign.ts` exposes `foreignMarkerFixtures` so no test hardcodes the literals.

### Worker B — auth polish + storage tiers

9. **`src/secrets.ts`** (new): tier store. API: `storeSecret(profile, blob: string): Promise<"keychain"|"file"|"plaintext">`, `loadSecret(profile): Promise<string | null>`, `deleteSecret(profile): Promise<void>`, `detectTier(): Promise<"keychain"|"file"|"plaintext">`.
   - keychain: macOS `security add-generic-password -s aiand -a <profile> -w <blob> -U` / `find-generic-password -s aiand -a <profile> -w` / `delete-generic-password`; Linux `secret-tool store|lookup --service=aiand --account=<profile>`; Windows: tier unavailable in v1. Availability probe = write+read+delete a canary `aiand-probe-<random>`.
   - file: port FireConnect `builtin-file-secret-store.mjs` (AES-256-GCM) at the frozen aiand paths; secrets JSON map `{ "<profile>": "<blob>" }`.
   - plaintext: `<configDir()/credentials-plaintext.json` 0600; only via `AIAND_KEY_STORAGE=plaintext`.
   - Selection: env override → keychain probe → file. Never silently falls to plaintext.
10. **`src/config.ts`** refactor (keep exports `loadCredential/saveCredential/clearCredential`): `Credential` becomes metadata + origin — `{ origin?: "device" | "paste"; expires_at?: number; user?; org?; storage: "keychain" | "file" | "plaintext" }` — and the secret blob (JSON `{access_token, refresh_token}`) moves into the tier store. `loadCredential` reassembles `{access_token, refresh_token, ...meta}`. **Migration**: if a profile entry in `credentials.json` still carries `access_token` (legacy shape), move the pair into the active tier and rewrite the file as metadata. Missing `origin` = `"device"` (all existing credentials were device-minted).
11. **`src/api/client.ts`**: `openSession` — if stored credential has no `refresh_token` (pasted key) return its token without rotation; `request()` 401-retry only when `session.credential?.refresh_token` exists (a rejected pasted key surfaces as the 401 hint, not a crash).
12. **`src/commands/login.ts`**: add `--paste` (TTY masked `readSecret("Paste your ai& API key (sk-…): ")`; up to 3 attempts), `--api-key <sk-…>`, `--with-token` (read one line from stdin; TTY with empty stdin → `CliError("Pipe the key: aiand login --with-token < key.txt")`). All three: shape-check `/^sk-/`, validate via `getUser` with the key as Bearer against `authUrl` (new tiny `validateKey(key, authUrl)` in `src/api/account.ts` using plain `fetch` + `Authorization`), then store with `origin: "paste"` (clearing any minted state by construction — origin lives on the credential). When `AIAND_API_KEY` is set, print stderr warning `AIAND_API_KEY is set; it takes precedence over the stored session until unset.` and continue. Already-signed-in without `--force`: TTY → `confirm("Profile … is already signed in as <email>. Sign in again?")` (default no → exit 0); non-TTY → keep today's error. Device path sets `origin: "device"`. Update `help` text.
13. **`src/commands/logout.ts`**: matrix — `origin: "device"`: TTY → `confirm("Revoke the ai& key this machine minted?")` default yes; `--revoke` skips prompt and revokes; `--keep-remote` local-only; non-TTY → revoke (today's default). `origin: "paste"`: local-only always; `--revoke` → `CliError("This key was pasted, not minted by this CLI; refusing to revoke it.")`. `AIAND_API_KEY`-only (no stored credential): print note that the env var still applies. Delete secret via tier store.
14. **`src/commands/whoami.ts`**: `source` field becomes `device-login | pasted-key | AIAND_API_KEY`; add `storage` tier to `--json`.
15. **Tests** (`test/auth-store.test.mjs`; update `test/config.test.mjs`): tier round-trips with `AIAND_KEY_STORAGE=plaintext` and `file` (with `AIAND_SECRET_STORE_MASTER_KEY` fixed); legacy `credentials.json` migration; paste stores `origin: "paste"` and logout stays local-only; device logout non-TTY revokes (stub `revokeTokens` via injectable seam — export `__setRevokeForTests` or accept a function param); openSession never rotates a pasted key.

**Phase 0 gate**: `npm run lint && npm test && npm run build` green; existing `inference`/`output` tests untouched and passing.

## Approach — Phase 1 (P0: claude + codex + surface)

Three parallel workers after Phase 0 (A/B/C); D integrates.

### Worker A — `src/agents/claude.ts` + `test/agents-claude.test.mjs`

16. Adapter per contract. `managedFiles()` = `[<home>/.claude/settings.json, <home>/.claude.json]`. `probe()`: read settings.json; `active` iff `env.ANTHROPIC_BASE_URL === "https://api.aiand.com"`; `model` from `env.ANTHROPIC_MODEL`.
17. `enable()`: snapshot is taken by the engine before this runs. Write `~/.claude/settings.json` (0600, `writeFileAtomic`) preserving unrelated keys, with `env` block:
    - `ANTHROPIC_BASE_URL: "https://api.aiand.com"`, `ANTHROPIC_AUTH_TOKEN: <apiKey>` (preferred; PRD-locked Q4).
    - Slot env vars from `input.slots` (frozen literals above).
    - Clear managed conflicts inside the `env` block first: `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, and every slot/model-mapping key we own (full list = union of relay `claude/core.ts` `CONFLICTING_ENV_KEYS` lines 11–29 and FireConnect `MODEL_MAPPING_ENV_KEYS` — copy both lists verbatim into the module).
    - No `apiKeyHelper`, no custom headers, no proxy.
18. Pre-approval: if `process.env.ANTHROPIC_API_KEY` is set, add `key.trim().slice(-20)` to `customApiKeyResponses.approved` in `~/.claude.json` (preserve everything else). Port `/home/fenil/fireconnect/packages/setup-cli/lib/harnesses/claude/index.mjs` `approveStrayAnthropicApiKey` (lines 293–317).
19. `disable()`: nothing beyond manifest restore (engine restores both snapshotted files byte-for-byte).
20. `sessionLaunch(model)`: env `{ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_MODEL: model}`; `clear` = the conflicting-env list. Port relay `claude/core.ts` list.
21. Slot flags in the command layer (Worker D parses): `--model`, `--opus`, `--sonnet`, `--haiku` (values = model ids from catalog; validate against catalog, error lists valid ids).
22. Tests: enable writes expected env block and preserves unrelated settings keys; conflicts cleared; snapshot round-trip byte-identical incl. missing-file case; idempotent second `on` keeps first backup; foreign fireconnect settings → engine refuses without `--force`; `~/.claude.json` pre-approval added once.

### Worker B — `src/agents/codex.ts` (+ chatgpt alias) + `test/agents-codex.test.mjs`

23. `managedFiles()` = `[<home>/.codex/config.toml, <home>/.codex/models_cache.json]` (cache is deleted by `on`, so it must be snapshotted). `probe()`: parse TOML text; `active` iff a `[model_providers.aiand]` table exists with `base_url = "https://api.aiand.com/v1"`.
24. TOML surgery — hand-rolled string patcher `src/agents/toml.ts` (no dependency): port `/home/fenil/fireconnect/packages/setup-cli/lib/harnesses/codex/toml-patch.mjs` structure: `patchRouting(raw, {providerId: "aiand", baseUrl, modelId, catalogPath, apiKey})` rewrites root keys `model_provider`, `model`, `model_catalog_json` (insert after `model_provider` when missing; only above the first table header) and replaces/creates the `[model_providers.aiand]` table: `name = "ai&"`, `base_url = "https://api.aiand.com/v1"`, `wire_api = "responses"`, `experimental_bearer_token = "<apiKey>"`, `requires_openai_auth = false`. `stripRouting(raw)` removes exactly those root keys + our table, preserving every other line (including `[[mcp_servers]]` arrays). First-run: if the file is missing or whitespace-only, write `approval_policy = "on-request"`, `sandbox_mode = "workspace-write"` before routing (port relay `codex/user-config.ts` — only when empty).
25. Catalog file `~/.codex/aiand-models.json` from live `/v1/models`: port relay `packages/cli/src/lib/codex/catalog.ts` `codexModelCatalogJson` shape — per model: `slug` = id, `display_name` = name, `default_reasoning_level` = `reasoning_effort_default`, `supported_reasoning_levels` = `reasoning_efforts`, `context_window`, `truncation_policy: {mode: "tokens", limit: floor(context/1.8)}`, `auto_compact_token_limit` same value, `shell_type: "shell_command"`, `visibility: "list"`, `supported_in_api: true`, `priority: index`, `input_modalities` from capabilities (`vision` → `["text","image"]`), `supports_search_tool: false`, `use_responses_lite: false`. After write: delete `~/.codex/models_cache.json` if present (stale OpenAI cache).
26. `disable()`: engine restores manifest; then delete `~/.codex/aiand-models.json`.
27. `aliases: ["chatgpt"]`; status note when routed: `Shared by the Codex CLI and ChatGPT Desktop.` `sessionLaunch(model)`: `args: ["-c", 'model_provider="aiand"', "-c", 'model="…"']`, env `{AIAND_CODEX_AUTH_TOKEN: key}` (session uses `env_key` — permanent uses the baked literal; both shapes supported by the patcher's `providerAuthLines` port).
28. Tests: patch preserves `[[mcp_servers]]` and unrelated root keys; empty-config first-run defaults; round-trip on/off byte-identical; bearer literal present; `chatgpt` alias resolves to this adapter; catalog JSON builds from fixture models.

### Worker C — engine + commands

29. **`src/agents/engine.ts`**: `agentOn(adapter, opts)`: `requireSessionKey` → `adapter.detect()`; if not installed print install hint (`Install it with: <command>` + URL, exit 127) → `adapter.probe()`; if `foreignTool && !opts.force`: TTY `confirm("\`<tool>\` manages <files>. Overwrite it?")` else `CliError("<tool> manages <files>; last writer wins.", {hint: "Pass --force to overwrite it."})` → if no snapshot yet OR not active: `snapshotFiles(adapter.id, adapter.managedFiles())` (idempotency: existing manifest + active probe → keep backup) → `resolveDefault`/`--model`/slots → `adapter.enable(...)` → human/JSON output (`{agent, state: "on", model, files}`).
    `agentOff(adapter)`: `restoreSnapshot` (no manifest → `Already your own config — nothing to turn off.` exit 0) → `adapter.disable()` → output.
    `agentStatus(adapter)`: `detect` + `probe` → `{agent, installed, binary, state: "on"|"off"|"foreign", foreign, model}`.
30. **`src/commands/agent.ts`**: `runAgentCommand(adapter, argv)` — parse verb from first positional (`on|off|status`, default `on`; unknown verb → CliError listing verbs), then flags via existing `parse()`: `model` (string), claude slot flags, `force`, plus globals (`--json`, `--profile`, `--base-url`, `--help` → generated per-agent help text: usage `aiand <id> [on|off|status]`, flags, install hint, config paths).
31. **`src/commands/init.ts`**: bare `aiand init` — detect all registered agents; TTY: numbered list of installed agents + `Which agents should use ai&? (e.g. 1,3 — or "all")` via readline; wire each through `agentOn`. Non-TTY without `--all`: error listing detected agents + hint `Pass --all or name agents: aiand init claude codex`. `aiand init --all` wires all detected. `aiand init --off [agents…]` — no args: `agentOff` for every detected+active agent; with args: off those. `--json` reports per-agent results.
32. **`src/commands/status.ts`**: global status — auth block (signed-in email/org, masked key via `maskKey`, source, storage tier, profile) + per-agent rows from `agentStatus` (id, state, foreign, model, binary or install command). `--json`: `{auth: {...}, agents: [...]}`.
33. **Integration (sequential, after A+B)**: **`src/agents/registry.ts`** `AGENTS = [claudeAdapter, codexAdapter]` (+ later phases append) and `findAgent(name)` matching id/aliases; **`src/commands/index.ts`** register `init`, `status`; **`src/index.ts`**: after `findCommand` miss, try `findAgent(first)` → `runAgentCommand(agent, argv.slice(1))`; extend `suggest()` candidate set with agent ids; extend `USAGE` with an `Agents` section (`aiand <agent> on|off|status` + `init`, `status`, `run-agent` rows).
34. Tests `test/dispatch.test.mjs` (run built `dist/index.js` as subprocess with `AIAND_HOME`/`AIAND_CONFIG_DIR` temp + stub `claude`/`codex` scripts on PATH): `aiand claude` ≡ `on`; `aiand chatgpt status` routes to codex adapter; unknown agent → 127 with suggestion; `aiand init --all` on stubs wires both.

**Phase 1 gate** (live): `npm run build`; then with a real session (`aiand login` or `AIAND_API_KEY`):
- `AIAND_HOME=$(mktemp -d) AIAND_CONFIG_DIR=$AIAND_HOME/cfg node dist/index.js claude on` → inspect `$AIAND_HOME/.claude/settings.json`; `claude off` → `diff` against pre-on copy proves byte-identical restore.
- Same for `codex on`/`off` with `~/.codex/config.toml`.
- Live wire check (PRD Phase 1 exit): `aiand claude on` on the real HOME, then `claude -p "reply with ok"` reaches ai& (spends <1¢). `aiand codex on` then `codex exec "reply with ok"`. Verify AUTH_TOKEN actually reaches the gateway: `curl -s https://api.aiand.com/v1/messages -H "Authorization: Bearer $(grep -o 'sk-[^"]*' ~/.claude/settings.json)" -H 'content-type: application/json' -d '{"model":"zai-org/glm-5.3","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}'` → 200. **Contingency (PRD-locked)**: if Claude Code does not send `ANTHROPIC_AUTH_TOKEN` correctly to this gateway, switch the baked var to `ANTHROPIC_API_KEY` and keep the `customApiKeyResponses` pre-approval; document in the adapter; do not re-open the no-proxy design. If codex rejects `experimental_bearer_token`, fall back to `env_key = "AIAND_CODEX_AUTH_TOKEN"` in the permanent block and print an export instruction. WSL note: `claude`/`codex` on this machine are Windows shims — for the live gate run `npm install -g @anthropic-ai/claude-code @openai/codex` inside WSL first (or set `AIAND_HOME=/mnt/c/Users/<user>` to write the Windows-side config, with the user's consent, since snapshot/restore makes it reversible).

## Approach — Phase 2 (opencode + init polish + run-agent)

35. **`src/agents/opencode.ts`** (+ `test/agents-opencode.test.mjs`) — parallel with 36/37: config `<home>/.config/opencode/opencode.json`. `enable()`: merge (parse existing JSON, error clearly if invalid) `provider.aiand = { npm: "@ai-sdk/openai-compatible", name: "ai&", options: { apiKey: <literal>, baseURL: "https://api.aiand.com/v1" }, models: { <id>: entry } }` where entries build from live `/v1/api.json` (`publicJson`) — fields `name, attachment, reasoning, temperature: true, tool_call, limit: {context, output}, modalities, cost: {input, output, cache_read}` (the gateway already publishes this exact shape; fetch `GET /v1/api.json` and take its `models` map verbatim, injected under our `aiand` provider id). Root `model: "aiand/<defaultOrFlag>"`, `enabled_providers: ["aiand"]`, `disabled_providers: ["opencode"]` (Zen clutter). File written 0600 (contains a literal key). `probe()` active iff `provider.aiand?.options?.baseURL` starts `https://api.aiand.com`. `disable()` = manifest restore only. `sessionLaunch(model)`: env `OPENCODE_CONFIG_CONTENT` = JSON.stringify of the same config (key literal) — highest precedence, nothing on disk (relay `opencode/core.ts` pattern); `clear: []`.
36. **`src/commands/init.ts`** already shipped in Phase 1; here add the numbered multi-select listing **detected** agents only, missing ones printed below with install commands (never auto-installed), and `aiand init --off claude` equivalence with `aiand claude off` (PRD R1 wording).
37. **`src/commands/run-agent.ts`** + launcher core: `aiand run-agent <agent> [--model <id>] [--] [args…]`. Resolve adapter (`launcherOnly` agents allowed), `requireSessionKey`, `detect()` (missing → install hint, exit 127), resolve model (`--model` > adapter default), build `{env, clear, args}` from `adapter.sessionLaunch(model)`, `spawn(adapter.bin, [...args, ...passthrough], {env: {...process.env minus clear, ...env}, stdio: "inherit"})`; propagate `process.exitCode = status ?? (signal ? 1 : 0)`. Passthrough = everything after `--` (and any non-flag positionals before it). Register in `COMMANDS` (`summary: "Run a coding agent on ai& for one session"`). No short aliases (Q3).
38. Tests: stub-agent scripts asserting injected env (dump `env` + argv to a file): claude gets `ANTHROPIC_BASE_URL`/`AUTH_TOKEN` and no `ANTHROPIC_API_KEY` in child env even when set in parent; codex gets `-c` args + `AIAND_CODEX_AUTH_TOKEN`; exit code 42 propagates; `--` passthrough preserved.

**Phase 2 gate**: opencode on/off round-trip on temp HOME (opencode binary absent → install-hint path also exercised); `aiand run-agent claude -- --version` against the real binary works without prior `on` and leaves `~/.claude/settings.json` untouched.

## Approach — Phase 3 (P1: chatgpt guard + cursor)

39. **ChatGPT Desktop quit-guard** in `src/agents/codex.ts`: before writing `config.toml` on darwin/win32, detect a running ChatGPT Desktop (`pgrep -f "ChatGPT"` / `tasklist | findstr ChatGPT.exe`); if running: TTY `confirm("ChatGPT Desktop is running and will overwrite this config. Quit it first — continue anyway?")` else require `--force`. Port FireConnect `lib/io/ide-running.mjs` guard shape. One shared manifest already covers the shared file (no new backup).
40. **`src/agents/cursor.ts`** (+ `test/agents-cursor.test.mjs`): port `/home/fenil/fireconnect/packages/setup-cli/lib/harnesses/cursor/core.mjs` mechanics: `state.vscdb` at `<home>/AppData/Roaming/Cursor/User/globalStorage/state.vscdb` (win32) / `~/Library/Application Support/Cursor/...` (darwin) / `$XDG_CONFIG_HOME/Cursor/...` (linux). DB access via `sqlite3` CLI primary (`sqlite3 <db> "select value from ItemTable where key='…'"`), `node:sqlite` import best-effort secondary. Writes: `secret://cursorAuth/openAIKey` = `JSON.stringify(safeStorage.encryptString(key))`, `cursorAuth/openAIKey` plaintext fallback cell, `openAIBaseUrl = "https://api.aiand.com/v1"` + `aiSettings.modelConfig[composer].modelName = <model>` on the `applicationUser` blob (read/modify/re-serialize compact JSON). safeStorage crypto port `/home/fenil/fireconnect/packages/setup-cli/lib/harnesses/vscode/safestorage.mjs` (macOS AES-128-CBC v10 PBKDF2(saltysalt,1003); Linux v11/v10; Windows DPAPI via Local State). Quit-Cursor-before-write guard (same pattern as 39; `--force` escapes). `off` removes only aiand registrations: restore prior `openAIBaseUrl`/model values tracked in aiand-owned fields on the blob, delete the secret cell we wrote (Cursor's own empty-ciphertext shape `{"type":"Buffer","data":[]}`), never full-file restore. Tests with a fixture `state.vscdb` built via `sqlite3` CLI.
41. Register `cursor` in `AGENTS` + `INSTALL_HINTS` (`https://cursor.com/downloads`).

**Phase 3 gate**: forced-off restore of a fixture DB leaves non-aiand rows untouched; live round-trip if Cursor installed on the Windows side with user consent.

## Approach — Phase 4 (pi, vscode, deepseek, prime, hermes, grok)

Ship order within the phase is free (independent adapters); each is one adapter module + registry line + tests.

42. **`src/agents/pi.ts`** — persistent three-file per PRD (FireConnect `pi/core.mjs` pattern): `~/.pi/agent/settings.json` `{defaultProvider: "aiand", defaultModel, enabledModels: ["aiand/*"]}`; `~/.pi/agent/auth.json` `{aiand: {type: "api_key", key: <literal>, managedBy: "aiand"}}` (0600); `~/.pi/agent/models.json` `{providers: {aiand: {baseUrl: "https://api.aiand.com/v1", api: "openai-completions", models: [{id, name, reasoning, input: ["text"], contextWindow, maxTokens, cost: {input, output, cacheRead, cacheWrite: 0}}]}}}` from live catalog. All three snapshotted. **Verify live**: if system prompts misbehave (developer-role handling), add `compat: {supportsDeveloperRole: false}` (relay learned this for vLLM gateways; aiand gateway behavior unknown until tested).
43. **`src/agents/vscode.ts`** — port FireConnect vscode adapter: `chatLanguageModels.json` + `state.vscdb` `secret://` rows via same sqlite/safeStorage helpers as cursor; quit-before-write; `off` removes only aiand-registered models/keys.
44. **`src/agents/deepseek.ts`** — permanent per FireConnect `deepseek/core.mjs`: hand-rolled flat-YAML read/write (port its `parseYamlMapping`/`serializeYaml`); `~/.dsh/settings.yaml` provider block under `llm-pi-ai`: `{displayName: "ai&", apiKeyEnv: "AIAND_API_KEY", api: "openai-completions", baseURL: "https://api.aiand.com/v1", models: [...]}` + `agent-default-model: {provider, model}`; `~/.dsh/.credentials.yaml` gets `AIAND_API_KEY: <literal>` (0600). `sessionLaunch` uses throwaway `DSH_HOME` with `agent-default-model` stripped from a copied `settings.yaml` (UI-remembered model outranks patches). `DSH_HOME` resolution: `$DSH_HOME || ~/.dsh`.
45. **`src/agents/prime.ts`** — aiand-owned dir `<configDir()/agents/prime/` (0700, never touches `~/.prime/agent` — Prime bootstraps auth/sessions/IPython there; a throwaway dir re-bootstraps every launch): write `models.json` provider (same shape as pi), `launcherOnly: false`, `on` = write dir + `sessionLaunch` env `{PRIME_AGENT_CODING_AGENT_DIR: <dir>, AIAND_API_KEY: key}`; status = dir + models.json present.
46. **`src/agents/hermes.ts`** — `launcherOnly: true` (PRD: home overlay; permanent write into `~/.hermes` is not offered): `sessionLaunch` builds a `mkdtemp` `HERMES_HOME` overlay — symlink user state except credential-shaped entries (`/.env`, `active_profile`, names matching `/auth|credential|token/i`), copy+patch `config.yaml` with aiand provider block, write isolated `.env` (0600) with `AIAND_HERMES_API_KEY`/`AIAND_HERMES_BASE_URL`, cleanup after exit. Port relay `hermes/core.ts`. `aiand hermes on` → CliError pointing at `aiand run-agent hermes`.
47. **`src/agents/grok.ts`** — `launcherOnly: true`: env `{GROK_AUTH_PATH: <tmp>/no-auth.json (empty file), GROK_MODELS_BASE_URL: "https://api.aiand.com/v1", GROK_MODELS_LIST_URL: <localhost catalog>, GROK_DEFAULT_MODEL: <model>, XAI_API_KEY: key, GROK_TELEMETRY_ENABLED: "0", GROK_IMAGE_GEN: "0", GROK_VOICE_MODE: "0"}`; delete `GROK_AUTH` from child env; ephemeral `http.createServer` on 127.0.0.1:0 serving the grok-shaped catalog `{object: "list", data: [{id, model, name, base_url, api_backend: "chat_completions", context_window, max_completion_tokens: min(output, 8192), user_selectable: true}]}` built from `/v1/models`; close after spawn. Port relay `grok/core.ts`.
48. **Hygiene**: extend `scripts/check-public.mjs` `private workspace package` allowlist with `@earendil-works/` and `@deepseek-ai/` (install commands from step 3 now referenced by shipped help text). Register all adapters in `AGENTS`.
49. Tests per adapter following the fixture-HOME pattern (grok catalog server tested against `127.0.0.1` ephemeral port; hermes overlay via temp HOME with planted files).

**Phase 4 gate**: each adapter green on fixture round-trips; `aiand status --json` lists all agents; `npm run check:public` passes with the extended allowlist.

## Final integration & cleanup (root, once)

50. Run the full suite at the integrated head: `npm run lint && npm test && npm run build && npm run check:dist && npm run check:public`.
51. Update `README.md` (commands table + agent-setup section + env vars `AIAND_HOME`, `AIAND_KEY_STORAGE`; drop the "Agent setup" roadmap bullet) and `CHANGELOG.md`. No other doc files.

## Critical files & anchors

- `src/index.ts` — dispatch hook: insert `findAgent` fallback between `findCommand` miss and the 127 return; extend `suggest` + `USAGE`.
- `src/commands/index.ts` — `COMMANDS` registry; add `init`, `status`, `run-agent`.
- `src/config.ts` — credential refactor to metadata + tier store; legacy migration inside `loadAllCredentials`.
- `src/api/client.ts:37-64` — `openSession`/`refresh`: skip rotation for pasted keys; 401-retry guard at line 106.
- `src/commands/login.ts:45-49` — already-signed-in guard becomes TTY confirm.
- `/home/fenil/fireconnect/packages/setup-cli/lib/harnesses/codex/toml-patch.mjs` — port target for `src/agents/toml.ts` (read before writing).
- `/home/fenil/fireconnect/packages/setup-cli/lib/keys/builtin-file-secret-store.mjs` — port target for `src/secrets.ts` file tier.
- `/home/fenil/nebius-tf-relay/packages/cli/src/lib/codex-app.ts:234-342` — port target for `src/agents/snapshot.ts`.
- `aiand-init-prd.md` — locked product decisions; re-read per phase.

## Verification (end-to-end, beyond unit gates)

Prereqs: `npm ci && npm run build`; temp sandbox per scenario: `S=$(mktemp -d); export AIAND_HOME=$S/home AIAND_CONFIG_DIR=$S/cfg AIAND_API_KEY=sk-test-not-real` (key validation is skipped for env keys; adapters bake whatever the session resolves).

1. **Claude round-trip**: `mkdir -p $AIAND_HOME/.claude && printf '{"permissions":{"allow":["Bash*"]}}' > $AIAND_HOME/.claude/settings.json`; `cp` it; `node dist/index.js claude on` → settings.json now has the env block AND still has `permissions.allow`; `node dist/index.js claude status --json` → `{"agent":"claude","state":"on",...}`; `node dist/index.js claude off` → `cmp` with the pre-on copy → identical; backup dir removed.
2. **Idempotence**: `claude on` twice → `off` → still identical to the original (second `on` must not re-snapshot).
3. **Foreign refusal**: plant `{"env":{"ANTHROPIC_BASE_URL":"https://api.fireworks.ai/v1","X-Fireworks-Api-Key":"x"}}` in settings.json → `claude on` exits 1 with the `--force` hint (non-TTY); with `--force` succeeds; `off` restores the fireconnect bytes.
4. **Codex surgical patch**: plant a config with `[[mcp_servers]]` + `trusted = 5` → `codex on` → both survive alongside `[model_providers.aiand]`; `codex off` → byte-identical to the planted file. `chatgpt status` == `codex status`.
5. **Not signed in**: unset `AIAND_API_KEY`, empty config dir → `claude on` exits 2 with the login hint (non-TTY).
6. **Auth matrix**: `login --api-key sk-invalid` → 401 error, nothing stored; with a stubbed/local validation server (unit test) valid paste → `whoami --json` shows `source: "pasted-key"` + storage tier; `logout` prints local-only message and does NOT call revoke (stub assert); legacy `credentials.json` migrates and still authenticates.
7. **Launcher**: stub `claude` script (`#!/bin/sh; env > "$CAPTURE"; exit 42`) on PATH → `aiand run-agent claude -- --version` → capture shows `ANTHROPIC_BASE_URL=https://api.aiand.com` + `ANTHROPIC_AUTH_TOKEN` and (with `ANTHROPIC_API_KEY=leak` exported) no `ANTHROPIC_API_KEY`; process exits 42; `~/.claude` untouched.
8. **Detection honesty**: `aiand status --json | jq '.agents[] | select(.id=="claude")'` reflects on/off/foreign after each command above.
9. **Live gates** (real key, real binaries — see Phase 1 gate): `claude -p` and `codex exec` reach ai& after `on`; `curl` Bearer check on `/v1/messages` returns 200.
10. **CI parity**: `npm run lint && npm test && npm run build && npm run check:dist && npm run check:public` all green at the end of every phase.

## Assumptions & contingencies

- **Scope**: all phases planned (user request); P0→P4 ship in order, each phase independently green. Phases 3–4 may land in later releases — the plan stays valid; registry growth is append-only.
- **Launcher spelling**: `aiand run-agent <agent>` (user-locked); no `--session` flag, no short aliases.
- **Zero runtime deps** (user-locked): TOML/YAML surgery, keychain via OS CLIs, `node:crypto` AES-256-GCM, `node:sqlite`/`sqlite3` CLI for IDE DBs. `scripts/check-dist.mjs` stays untouched.
- **Claude base URL** = `https://api.aiand.com` (routes verified live; Claude Code appends `/v1/messages`). Codex/OpenCode = `.../v1`. If the gateway later moves paths, only `src/agents/{claude,codex,opencode}.ts` constants change.
- **`ANTHROPIC_AUTH_TOKEN` fallback** and **codex `experimental_bearer_token` fallback** are pre-decided in the Phase 1 gate — execute the fallback, do not redesign.
- **Keychain tier**: macOS + Linux (Secret Service) only in v1; Windows uses the encrypted-file tier. Plaintext tier only via `AIAND_KEY_STORAGE=plaintext` (tests/CI).
- **OpenCode provider id `aiand`**, not the `opencode` id published in `/v1/api.json` — that id collides with the Zen provider we must disable. api.json's `models` map is still consumed verbatim.
- **Hermes/Grok are launcher-only** (PRD gives them overlay/env strategies that cannot survive a permanent stock-binary launch); `on` explains this instead of writing config.
- **Default-model preference list** (`zai-org/glm-5.3` first) is a pinned curated default filtered through the live catalog, so retired ids are never written (R6); users override with `--model` or `aiand config set model`.
- **Live e2e on this machine**: `claude`/`codex` are Windows npm shims; install Linux copies inside WSL for the live gate, or (with user consent) target the Windows config via `AIAND_HOME=/mnt/c/Users/<user>` — snapshot/restore makes it reversible.
- **Zero-mention rule** (user-locked): the words fireworks / fireconnect / nebius never appear in shipped text — `src/`, `dist/`, `test/`, `README.md`, `CHANGELOG.md`, help/error/status strings. The sole carrier is `src/agents/foreign.ts`, which assembles probe strings, display labels, and test fixtures from runtime fragments (detection still matches real on-disk markers, PRD Q5); `test/hygiene.test.mjs` enforces it. Planning docs (the PRD and this plan) are excluded from the grep.
