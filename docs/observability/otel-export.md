# OTel metrics export

`aiand export` turns the local request store (see `aiand store`) into metrics
in **two families from one read of the store**:

- **`claude_code.*`** — the same metric names, units, and attribute names
  Claude Code's own OTel output uses, so dashboards built for
  [Claude Code's monitoring-usage contract](https://code.claude.com/docs/en/monitoring-usage)
  work against ai& with zero changes.
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

### `claude_code.*` family

| Metric | Kind | Notes |
| --- | --- | --- |
| `claude_code.session.count` | counter | 1 per session, `start_type="derived"` — sessions come from ai&'s time-gap heuristic, not the gateway, so the value names that honestly instead of borrowing a Claude Code-native start type. |
| `claude_code.cost.usage` | counter (USD) | Sum of gateway-computed per-request cost; attrs `model`, `query_source` (the attributed agent). |
| `claude_code.token.usage` | counter | attr `type` ∈ `input \| output \| cacheRead \| cacheCreation`. **Conversion:** the gateway's `input_tokens` includes `cached_tokens`, but this contract's `type=input` excludes cache — ai& emits `input − cached`. `cacheRead` = `cached_tokens`. `cacheCreation` is **0** until the gateway splits cache writes. |

`claude_code.lines_of_code.count`, `claude_code.commit.count`,
`claude_code.pull_request.count`, and `claude_code.active_time.total` are
**omitted**: the store carries no envelope data for them, and the exporter
never fabricates zeros for metrics that would read as real measurements.

### `gen_ai.*` family

- Counters: `gen_ai.client.inference.usage.{input,output,cache_read,cache_write,reasoning}_tokens`
  (unit `{token}`). `input_tokens` is the **verbatim gateway sum** (includes
  cache, which is the GenAI semconv billing convention — note this differs
  from `claude_code.token.usage type=input`, which excludes cache by design).
  `cache_read_tokens` = cached tokens; `cache_write_tokens` and
  `reasoning_tokens` are **0** (gateway cache-write split pending; the store
  has no reasoning-token column).
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

## Honesty notes

- **Session ids are heuristic.** The gateway provides no server-side session
  ids, so `session.id` is ai&'s time-gap derived id (default 10-minute idle
  gap). Boundaries are approximate; a gateway-provided session id is tracked
  for the gateway backlog.
- **`cacheCreation` / cache-write tokens are 0** until the gateway exposes a
  cache-write split.
- **No content, ever.** Attributes are metadata only (masked keys, agent ids,
  model ids). The store holds no prompt/completion content and the exporter
  cannot emit any.

## Grafana: import a Claude Code dashboard unchanged

Because the `claude_code.*` names, units, and attribute keys match Claude
Code's OTel output, a dashboard built for it works against ai&:

1. Run an OTel collector with an HTTP receiver on `:4318` and a Prometheus
   exporter (or Grafana Alloy's `otlp` receiver).
2. Push on a schedule (cron):
   `aiand export --format otel --endpoint http://localhost:4318/v1/metrics --range 30days`
   — with default **delta** temporality each push contributes exactly its
   window, so a repeated 30-day delta push is idempotent-safe.
3. Import any Claude Code usage dashboard and point its datasource at the
   collector's Prometheus endpoint. Series such as
   `claude_code_token_usage_total{type="input",model="zai-org/glm-5.3"}`
   appear exactly as the dashboard expects.

> Note the one semantic difference a dashboard cannot see: panels that sum
> `type="input"` and `type="cacheRead"` to get total tokens billed are
> correct against ai& — the same expression against a Claude Code emitter
> would double-count, because Claude Code's input excludes cache and ours
> (post-conversion) matches Claude Code's convention.
