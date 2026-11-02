# OTel metrics export

`aiand export` turns the local request store (see `aiand store`) into metrics
in **one vendor-neutral family from one read of the store**:

- **`gen_ai.*`** — the vendor-neutral
  [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/).

## Usage

```sh
aiand export --format otel                       # OTLP/HTTP JSON to stdout
aiand export --format prometheus --file metrics.prom
aiand export --format otel --endpoint http://localhost:4318/v1/metrics
aiand export --format otel --range 24h --temporality cumulative
```

| Flag | Meaning |
| --- | --- |
| `--format otel\|prometheus` | OTLP/HTTP JSON (protobuf-JSON encoding) or Prometheus text exposition. Default `otel`. |
| `--range <window>` | `15m`, `1h`, `6h`, `24h`, `7days` (default), `30days` — the same windows as `aiand logs`. `--since`/`--until` (ISO, UTC) override the window edges. |
| `--temporality delta\|cumulative` | OTLP aggregation temporality. **Delta is the default** (each export covers its window; safe to push repeatedly). `cumulative` marks the sums as cumulative-from-window-start. |
| `--endpoint <url>` | POST the payload here instead of stdout (one shot per invocation). |
| `--header <h>` | Extra endpoint header, repeatable (`"Name: value"` or `Name=value`). |
| `--file <path>` | Write the payload to a file instead of stdout. |
| `--no-sync` | Skip the best-effort store sync first (also `AIAND_NO_SYNC=1`). A failed sync warns and exports local data — it never blocks. |

Prometheus is a **push** here (file or endpoint), not a `:9464` pull endpoint:
the CLI is a short-lived process and cannot stay up to be scraped. Point a
Prometheus `pushgateway`, or scrape a file with `file_sd`/`textfile`-style
tooling, at the exported text.

## What is emitted

All values are sums over the export window of gateway-billed `/logs` fields
(nothing is recomputed), split per `model`, per agent (`agent.name`, from the
masked-key → agent mapping), and per masked key (`aiand.key.masked`). The
key/agent attributes are deliberate: distinct series per agent + key mean two
agent processes exporting concurrently can never fold into one counter
(the claude-code
[#56317](https://github.com/anthropics/claude-code/issues/56317) failure
mode).

### `gen_ai.*` family

- Counters (unit `{token}`): `gen_ai.client.inference.usage.{input,output,cache_read}_tokens`.
  `input_tokens` is the **verbatim gateway sum** (includes cache, which is the
  GenAI semconv billing convention); `cache_read_tokens` = cached tokens.
  Cache-write and reasoning token counters are **not emitted**: the gateway
  has no cache-write split and the store has no reasoning-token column, and
  the exporter never fabricates zeros for metrics that would read as real
  measurements (emit-only-where-data-exists).
- Cost: `gen_ai.client.inference.usage.cost` (unit `USD`) — the
  gateway-computed per-request cost summed over the window; attributed agent
  rides on `query.source`.
- Required attributes on every gen_ai series: `gen_ai.operation.name`
  (`chat`), `gen_ai.provider.name`, `gen_ai.token.modality` (`text`),
  `gen_ai.request.model`, `gen_ai.response.model`.
- Histograms (explicit buckets): `gen_ai.client.inference.operation.{input,output}_tokens`,
  `gen_ai.client.inference.duration` (s), `gen_ai.server.request.duration` (s),
  `gen_ai.server.time_to_first_token` (s — the gateway's `ttft_ms`).
- Failures: rows with a non-2xx status form their own series carrying
  `error.type` = the HTTP status as a string; **tokens recorded on failed
  operations are still exported**, per the semconv.

### `gen_ai.provider.name` mapping

Gateway upstream model ids map to well-known providers; first match wins:

| Model id contains | `gen_ai.provider.name` |
| --- | --- |
| `claude` | `anthropic` |
| `gpt`, `codex`, `o1`, `o3`, `o4` | `openai` |
| `deepseek` | `deepseek` |
| `kimi`, `moonshot` | `moonshot_ai` |
| `grok` | `x_ai` |
| `glm`, `zai` | `zai` |

A model matching nothing maps to its **family string** (the segment before
`/`, or the whole id) — never a per-name guess.

### `aiand.harness.*` gauges (per harness, ticket #149)

One series **per harness**, with `agent.name` as the **only** attribute —
no masked key, no model, no session id: a gauge per harness is the
aggregation `aiand harness compare` already shows, and a stable label set
keeps the series foldable. These are point-in-time readings over the
export window, not monotonic sums (Prometheus `# TYPE ... gauge`):

| Metric | Meaning | Omitted when |
| --- | --- | --- |
| `aiand.harness.sessions` | Heuristic time-gap sessions attributed to the harness (#66 sessionization). | Never (0 is a real count). |
| `aiand.harness.cost_per_session_usd` | Median (p50) cost per session, USD. | No cost rows, or the store's cost rows carry a non-USD currency. |
| `aiand.harness.ttft_p95_ms` | 95th-percentile time to first token (ms). | No ttft samples. |
| `aiand.harness.cache_hit_ratio` | `cached_tokens / input_tokens` (estimated). | No requests. |
| `aiand.harness.error_rate` | Non-2xx excluding 429 / requests (estimated). | No requests. |
| `aiand.harness.clean_rate` | Clean terminal sessions / all terminal sessions. | No terminal information (behavioral source uncovered). |
| `aiand.harness.tool_error_rate` | Errored tool outcomes / captured tool outcomes. | Behavioral source does not cover tool outcomes. |
| `aiand.harness.behavioral_coverage_ratio` | Behaviorally covered requests / total requests in the window. | No requests in the window. |

Behavioral cells ride the same source precedence as `aiand harness stats`
(#146): envelope turns (≥ `MIN_BEHAVIORAL_TURNS`), else imported markers
(`aiand harness import`), else the gauge is **omitted — never a fabricated
zero** for an uncovered cell. The same emit-only-where-data-exists rule as
the gen_ai family applies throughout: absent data is omitted, zeros are
only emitted when the store genuinely measured zero.

### `aiand.store.*` gauges (no attributes, ticket #149)

| Metric | Meaning | Omitted when |
| --- | --- | --- |
| `aiand.store.sync_lag_seconds` | Seconds since the local store's **last successful sync** (`now − last_sync_at`). | The store has never synced (`last_sync_at` null) — never zeroed. |
| `aiand.store.requests_total` | Request rows the local store holds in the export window. | Never (emitted whenever the store opened; 0 rows is a measurement). |

**Sync-lag semantics:** `aiand.store.sync_lag_seconds` measures **local
store freshness** — how long ago *this machine's* store last completed a
successful sync (its `last_sync_at` watermark). It says nothing about how
fresh the gateway's data is: a store that synced a minute ago can still
hold hours-old data if the gateway lags, and `--no-sync` exports make the
lag grow until the next successful sync.

## Metric families at a glance

| Family | Kind | HELP / TYPE / UNIT |
| --- | --- | --- |
| `gen_ai.client.inference.usage.{input,output,cache_read}_tokens` | counter (`sum`) | Yes / `counter` / `{token}` |
| `gen_ai.client.inference.usage.cost` | counter (`sum`) | Yes / `counter` / `USD` |
| `gen_ai.client.inference.operation.{input,output}_tokens` | histogram | Yes / `histogram` / `{token}` |
| `gen_ai.client.inference.duration`, `gen_ai.server.request.duration`, `gen_ai.server.time_to_first_token` | histogram | Yes / `histogram` / `s` |
| `aiand.harness.*` (table above) | gauge | Yes / `gauge` / varies (`{session}`, `USD`, `ms`, `1`) |
| `aiand.store.sync_lag_seconds` | gauge | Yes / `gauge` / `s` |
| `aiand.store.requests_total` | gauge | Yes / `gauge` / `{request}` |

Every emitted family carries a **`# HELP` line printed before its `# TYPE`**
line; `# UNIT` is kept (except for ratio unit `1`, which Prometheus exposes
without a unit line). A test pins that no emitted metric lacks HELP.

## Honesty notes

- **Session ids are heuristic.** The gateway provides no server-side session
  ids, so `session.id` is ai&'s time-gap derived id (default 10-minute idle
  gap). Boundaries are approximate; a gateway-provided session id is tracked
  for the gateway backlog.
- **Cache-write and reasoning tokens are not emitted.** The gateway exposes
  no cache-write split and the store has no reasoning-token column; the
  exporter emits only where data exists.
- **Harness gauges carry `agent.name` only.** The gen_ai counters need the
  masked key + model + session labels for concurrent-export collision
  safety; the gauges do not — they are per-harness aggregates, and extra
  labels would shatter them into unfoldable fragments.
- **No content, ever.** Attributes are metadata only (masked keys, agent ids,
  model ids). The store holds no prompt/completion content and the exporter
  cannot emit any.

## Grafana: point any OTel-capable dashboard at the export

1. Run an OTel collector with an HTTP receiver on `:4318` and a Prometheus
   exporter (or Grafana Alloy's `otlp` receiver).
2. Push on a schedule (cron):
   `aiand export --format otel --endpoint http://localhost:4318/v1/metrics --range 30days`
   — with default **delta** temporality each push contributes exactly its
   window, so a repeated 30-day delta push is idempotent-safe.
3. Point the dashboard's datasource at the collector's Prometheus endpoint.
   Series such as
   `gen_ai_client_inference_usage_input_tokens_total{gen_ai_request_model="zai-org/glm-5.3"}`
   appear under the vendor-neutral GenAI semconv names.
