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

**Wire format** - the request/response dialect an agent speaks: OpenAI-compatible chat.
The CLI points the agent at the gateway in its own dialect; it never translates between dialects.

**Org** - the account scope a key is minted against and spend is reported
for. `logs` and `usage` are org-scoped.

## Agents (the setup domain)

The three verbs - `on`, `off`, `status` - are the primary product surface;
`init` and the launcher are conveniences layered over the same adapters.

**Agent** - a local coding-agent CLI identified by its short id, one of the agents
shipped, currently opencode. One adapter per agent. _Avoid:_ harness, integration, connector.

**Adapter** - the module that knows one agent: how to detect its binary,
which config files it owns, and how to enable, disable, and probe it. Adding
an agent is one adapter module plus one registry line.

**Registry** - the single ordered list in `registry.ts` every adapter ships
in; agent lookup walks it by id and alias. The one place the agent matrix is
enumerated.

**on** - the primary verb: wire the agent permanently so the stock
binary reaches the gateway afterwards, with no wrapper process required. The
adapter writes the agent's own native config.
The default verb - `aiand opencode` means `aiand opencode on`.

**off** - restore the agent's pre-aiand state byte for byte from its
snapshot, including the case where a managed file did not exist before.

**status** - report an agent's actual routing state by probing its real
config files. Never trusts the CLI's own bookkeeping. _Avoid:_ flag check.

**Reachable** - whether the gateway could be contacted to verify the key.
`aiand status` reports three auth states — signed in, signed out,
unreachable — and keeps them distinct so a script gating on the exit code
never mistakes an outage for a sign-out. `whoami` treats unreachable as a
hard failure instead.

**Managed file** - a config file an adapter reads or writes. Edits are
surgical: unrelated keys and sections always survive an aiand write.

**Snapshot** - the byte-for-byte capture of an agent's managed files,
restored by `off`. A re-`on` while still active keeps the first capture; an
inactive `on` re-captures. _Avoid:_ backup, checkpoint.

**Marker** - a recognizable ownership signature inside a managed file. aiand
stamps its own so `off` can strip surgically.

**uninstall** - `bash install.sh uninstall`: restore every aiand-routed agent
(`init --off`), then remove the launcher and the `~/.aiand/cli` checkout.
Aborts before deleting anything if a restore fails; profiles, credentials,
and snapshots are always kept. The removal target must canonicalize to a
path strictly inside HOME.

**Launcher** - `aiand run-agent <agent>`: run one agent process with routing
injected into its environment or a throwaway overlay, leaving user files
untouched. Works without a prior `on`; an optional convenience beside
permanent `on`, never a replacement. _Avoid:_ wrapper, session alias.

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

**Browser sign-in** - the default interactive sign-in: authorization code
+ PKCE against the gateway, redirect caught on a loopback port. A preflight
`GET /auth/authorize` decides the path: 404/501 (no browser flow) falls
back to device login, any other answer attempts the browser. A recoverable
browser failure falls back to device login too (browser-side cancels and
Ctrl-C still abort); a missing browser opener only prints the authorization
URL and waits.

**Device login** - the fallback sign-in for unsupported gateways,
recoverable browser failures, and non-interactive terminals: the OAuth
device authorization grant against the gateway, which mints an org-scoped
key for this machine.

**Minted key** - a key this CLI itself created (device login). Logout may
revoke a minted key server-side by posting its refresh token. _Avoid:_
generated key.

**Pasted key** - a key the user supplied (`--paste`, `--with-token`) and
the CLI validated before storing. Logout clears it
locally and never revokes it - the CLI did not mint it. A multi-org
account picks its organization just as a minted sign-in does. _Avoid:_
manual key, console key.

**Env key** - `AIAND_API_KEY`: a key supplied per-process, never stored, that
takes precedence over any credential until unset. The CI escape hatch.

**Storage tier** - where a profile's secret actually lives: OS keychain,
encrypted file, or protected plaintext file. Selected by availability, never
silently downgraded to plaintext.

**Session key** - the active session's resolved key, baked into agent config
at `on` time and printed raw by `key export`. Agent flows never prompt for a
raw key - pasting belongs to `aiand login`.

**Rebake** - the sign-in follow-through: storing a fresh credential swaps the
key literal in every active agent config. Adapters with no plaintext key to
swap are skipped, with a re-run-`on` note where one applies. _Avoid:_ rewire, resync.

## Models

**Catalog** - the live, priced model list served by the gateway. Defaults resolve
through it so a retired model id is never written into agent
config. _Avoid:_ model list.

**Vision** - whether a catalog model accepts image input (`vision`) or text
only (`text-only`).

**Native** - the literal `native` passed as `--model` to leave
the model unpinned, so the agent's own default wins instead of a gateway
model.

## Sources of truth

- Product surface: `README.md`; shipped decisions: `CHANGELOG.md`.
- Agent matrix: `src/agents/registry.ts`, one adapter per agent.
- ADRs: none yet - create `docs/adr/` when a decision is load-bearing.
- This file is the domain model; update it as terms crystallise.
