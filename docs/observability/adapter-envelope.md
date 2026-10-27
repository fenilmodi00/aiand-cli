# Adapter envelope (`aiand-envelope/v1`)

Ticket #78 (OBS-P3-6) · feature catalog C3, C5, B4 · part of the
[harness-observability epic](https://github.com/fenilmodi00/aiand-cli/issues/59).

The adapter envelope is a compact per-request metadata record that adapters can
capture and forward. Until the gateway forwards envelopes server-side
(OBS-GW-1, gateway ask #2 in #80), the CLI captures them locally and reports
the offline metrics they unlock — one-shot/retry rate, deterministic task
classification, and project/branch spend attribution — with explicit coverage.

## Schema

```json
{
  "schema_version": "aiand-envelope/v1",
  "tools": ["Read", "Edit", "Bash"],
  "edit_targets": ["config.ts#a1b2c3d4e5f60718"],
  "project_root_id": "9f86d081884c7d65",
  "git_branch": "feat/harness-observability"
}
```

| Field | Meaning | Privacy |
| --- | --- | --- |
| `schema_version` | Always `aiand-envelope/v1`; recorded per row. Unknown fields are dropped on read (forward-compatible). | — |
| `tools` | Ordered tool names used this turn — names only, never arguments. Capped at 32 entries. | metadata only |
| `edit_targets` | Files edited this turn, as `<basename>#<hash16>` — sha256 of the resolved full path, first 16 hex chars. **Never a full path.** Capped at 16 entries. | hashed |
| `project_root_id` | Stable pseudonymous id of the project root: sha256 of the resolved root path, first 16 hex chars. **Never the path or a configured name in clear.** | hashed |
| `git_branch` | Current branch name; `null` on detached HEAD, outside a repo, or unknown. | branch name only |

Size bound: an envelope must serialize to **≤ 2048 bytes** (the 2 KiB class, so
it can travel as an HTTP header). Normalization applies the caps first and then
drops trailing `tools` / `edit_targets` entries (ordered truncation, never
reordering) until the record fits — the same input always yields the same
output.

Versioning: `src/agents/envelope.ts` pins the schema, the caps, and the
round-trip (`normalizeEnvelope` → `envelopeJson` → `parseEnvelope`); a schema
test pins the size bound and idempotent re-normalization.

## Privacy posture

Metadata only. No prompts, no completions, no file contents, no full file
paths — ever. The capture API (`src/agents/envelope-capture.ts`) accepts only
tool names, edit-target paths (hashed at normalization), the project root
(hashed), and the branch name; nothing else has a place in the schema.

## Capture

Capture is **opt-in and default off**: enable with `AIAND_ENVELOPE_CAPTURE=1`
or `"envelopeCapture": true` in config.json. A disabled recorder is a silent
no-op — callers may create one unconditionally.

```ts
import { createEnvelopeRecorder } from "../agents/envelope-capture.js";

const recorder = createEnvelopeRecorder({ agent: "opencode", model, apiKey });
recorder.tool("Edit");
recorder.edit("/repo/src/config.ts"); // hashed at flush time
const result = recorder.flush({ projectRoot: "/repo", gitBranch: "main" });
// result.recorded === true → one row in the local store's `envelopes` table
```

Envelopes are stored in the local store (`migration 0003`, table `envelopes`),
linked to the gateway request rows by the same masked `api_key` plus
`created_at`; `session_id` / `request_id` are best-effort nullable links.

Local capture is the only envelope path today. Forwarding envelopes through
the gateway (which would populate `request_id`) is a tracked gateway ask
(ticket #80); no schema change is needed when it lands.

## Metrics unlocked (offline, local-capture only)

- **One-shot/retry (`src/model-efficiency.ts`, C5):** a *retry* is the same
  file re-edited after a shell command ran in between (CodeBurn definition).
  The metric is the share of edit events that succeeded first try, reported
  per harness and per model.
- **Task classification (`src/obs/classifier.ts`, C3):** 13 deterministic
  categories — Coding / Debugging / Feature / Refactoring / Testing /
  Exploration / Planning / Delegation / Git Ops / Build-Deploy / Brainstorming
  / Conversation / General. Pure function of the envelope sequence; zero LLM
  or network calls; golden-fixture tested.
- **Project/branch attribution (`src/branch-spend.ts`, B4):** gateway-billed
  request costs joined to the most recent same-key envelope within the turn
  window. Three-way coverage split, never silently collapsed: **named-branch /
  pre-recording / no-branch**.

## Coverage honesty

Every envelope-derived report states what fraction of requests carry envelope
data — e.g. `local-capture only, 34% coverage (12 of 35 requests have envelope
data) — server-side envelope forwarding is a tracked gateway ask` — and
carries a provenance label (`heuristic(...)` / `estimated(...)`, see
`aiand usage --audit`). Until OBS-GW-1 lands, classification and attribution
describe captured turns only, never the whole request log.
