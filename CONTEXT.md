# Domain Glossary - aiand CLI

The ubiquitous language for the `@aiand/cli` command line interface: sign-in,
inference, usage, and agent setup. Terms here are the canonical names for
concepts in the codebase; architecture review and code discussion should use
these words exactly. Architecture vocabulary (module, interface, depth, seam,
adapter, leverage, locality) comes from the `codebase-design` skill glossary.

## The gateway

**Gateway** - api.aiand.com, the ai& inference endpoint. It speaks every
agent's native wire format, so the CLI never runs a local proxy, translator,
or daemon to serve one. _Avoid:_ relay, proxy.

**Wire format** - the request/response dialect an agent speaks: Anthropic
Messages (Claude Code), OpenAI Responses (Codex), or OpenAI-compatible chat
(everything else). The CLI points each agent at the gateway in its own
dialect; it never translates between dialects.

**Org** - the account scope a key is minted against and spend is reported
for. `logs` and `usage` are org-scoped.

## Agents (the setup domain)

The three verbs - `on`, `off`, `status` - are the primary product surface;
`init` and the launcher are conveniences layered over the same adapters.

**Agent** - a local coding-agent CLI (claude, codex, opencode, ...) that this
CLI can wire to the gateway, identified by its short id. One adapter per
agent. _Avoid:_ harness, integration, connector.

**Adapter** - the module that knows one agent: how to detect its binary,
which config files it owns, and how to enable, disable, and probe it. Adding
an agent is one adapter module plus one registry line.

**on** - the primary verb: write the agent's own native config so the stock
binary reaches the gateway afterwards, with no wrapper process required. The
default verb - `aiand claude` means `aiand claude on`.

**off** - restore the agent's pre-aiand state byte for byte from its
snapshot, including the case where a managed file did not exist before.

**status** - report an agent's actual routing state by probing its real
config files. Never trusts the CLI's own bookkeeping. _Avoid:_ flag check.

**Managed file** - a config file an adapter reads or writes. Edits are
surgical: unrelated keys and sections always survive an aiand write.

**Snapshot** - the byte-for-byte capture of an agent's managed files, taken
before the first aiand write and restored by `off`. Idempotent by design: a
second `on` never re-captures over the original. _Avoid:_ backup, checkpoint.

**Foreign tool** - another config-writing tool whose markers are present in a
managed file. Its presence blocks `on` until the user explicitly forces an
overwrite; last writer must never win silently. _Avoid:_ conflicting writer,
rival tool.

**Marker** - a recognizable ownership signature inside a managed file. aiand
stamps its own so `off` can strip surgically, and so other tools can detect
aiand the same way aiand detects them.

**Launcher** - `aiand run-agent <agent>`: run one agent process with routing
injected through its environment, leaving user files untouched. An optional
convenience beside permanent `on`, never a replacement. _Avoid:_ wrapper,
session alias.

**Launcher-only agent** - an agent whose routing cannot survive a permanent
stock-binary launch (it needs an overlay or ephemeral auth), so `on` is not
offered for it; only the launcher is.

**Install hint** - the official install command and docs URL printed for a
missing agent binary. Detection never installs agents.

**init** - the batch wrapper over the adapters: detect installed agents, wire
the chosen subset, or restore them. Discovery and batch only - never the
primary setup path.

## Auth

**Profile** - a named credential slot (work, personal, ...) selected with
`--profile` or `AIAND_PROFILE`. Each profile keeps its own credential and can
be wired to agents separately.

**Credential** - the stored sign-in material for a profile: the identity
(user, org) plus the secret, held in the active storage tier. _Avoid:_ token
pair.

**Session** - an authenticated request context opened from the env key or the
active profile's credential. Every API call goes through one.

**Device login** - the default sign-in: the OAuth device authorization grant
against the gateway, which mints an org-scoped key for this machine.

**Minted key** - a key this CLI itself created (device login). Logout may
revoke a minted key server-side. _Avoid:_ generated key.

**Pasted key** - a key the user supplied (`--paste`, `--api-key`,
`--with-token`) and the CLI validated before storing. Logout clears it
locally and never revokes it - the CLI did not mint it. _Avoid:_ manual key,
console key.

**Env key** - `AIAND_API_KEY`: a key supplied per-process, never stored, that
takes precedence over any credential until unset. The CI escape hatch.

**Storage tier** - where a profile's secret actually lives: OS keychain,
encrypted file, or protected plaintext file. Selected by availability, never
silently downgraded to plaintext.

**Session key** - the key an adapter bakes into agent config at `on` time:
the active session's resolved key. Agent flows never prompt for a raw key -
pasting belongs to `aiand login`.

## Models

**Catalog** - the live, priced model list served by the gateway. Defaults and
slots resolve through it so a retired model id is never written into agent
config. _Avoid:_ model list.

**Slot** - a Claude Code model tier (opus, sonnet, haiku) mapped to a catalog
id at `on` time; overridable with per-slot flags.

## Sources of truth

- Locked product decisions (Q1-Q8): `aiand-init-prd.md`.
- Implementation plan: `aiand-agent-setup-plan.md`.
- ADRs: none yet - create `docs/adr/` when a decision is load-bearing.
- This file is the domain model; update it as terms crystallise.
