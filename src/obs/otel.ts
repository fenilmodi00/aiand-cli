import { agentForMaskedKey } from "../api/agent-keys.js";
import { VERSION } from "../api/client.js";
import { LOG_RANGES } from "../api/logs.js";
import { listEnvelopesFromDb } from "../store/envelopes.js";
import { listImportedArtifactsFromDb } from "../store/imported-artifacts.js";
import { createdSince, createdUntilIncl, openStore, storePath } from "../store/index.js";
import { listSessions, type SessionRow } from "../store/sessions.js";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "../time.js";
import { buildHarnessStats, type HarnessStats } from "./harness-stats.js";

/**
 * OTel metrics export (feature catalog G2, ticket #72).
 *
 * Hand-emitted OTLP/HTTP JSON (the /v1/metrics protobuf-JSON shape) plus the
 * Prometheus text exposition — no OTel SDK dependency (zero-runtime-deps
 * rule). One metric family from one read of the local store:
 *
 *   - `gen_ai.*` — vendor-neutral OpenTelemetry GenAI semconv.
 *
 * Values are verbatim gateway-billed sums: `input_tokens` INCLUDES
 * `cached_tokens` (the gateway's and ai&'s convention), with cache read
 * tokens as their own series per semconv. Cost is the gateway-computed
 * per-request cost, emitted only where the store has a value.
 *
 * Collision safety (claude-code#56317): every cost/token series carries the
 * masked key AND the agent name, so two agent processes never fold into one
 * counter series.
 *
 * Honesty annotations: `session.id` is the heuristic time-gap id (#66 — see
 * sessions.ts); real gateway session ids are OBS-GW-1/#80 ask 4.
 * Cache-write and reasoning token series are NOT emitted: the store has no
 * such columns, and the exporter never fabricates zeros for metrics that
 * would read as real measurements (emit-only-where-data-exists rule).
 *
 * Privacy: attributes are metadata only — masked keys, agent ids, model ids.
 * No prompt or completion content exists in the store and none is emitted.
 */

// ---------------------------------------------------------------------------
// Provider mapping
// ---------------------------------------------------------------------------

/**
 * Maps a gateway upstream model id to a well-known `gen_ai.provider.name`.
 * First substring match wins; an id matching no entry maps to its FAMILY
 * string (the segment before "/"), never a per-name guess — an unknown
 * vendor's model must not masquerade as a known provider.
 */
const PROVIDER_MAP: readonly { match: string; provider: string }[] = [
  { match: "claude", provider: "anthropic" },
  { match: "gpt", provider: "openai" },
  { match: "codex", provider: "openai" },
  { match: "o1", provider: "openai" },
  { match: "o3", provider: "openai" },
  { match: "o4", provider: "openai" },
  { match: "deepseek", provider: "deepseek" },
  { match: "kimi", provider: "moonshot_ai" },
  { match: "moonshot", provider: "moonshot_ai" },
  { match: "grok", provider: "x_ai" },
  { match: "glm", provider: "zai" },
  { match: "zai", provider: "zai" },
];

export function providerForModel(model: string): string {
  const id = model.toLowerCase();
  for (const entry of PROVIDER_MAP) {
    if (id.includes(entry.match)) return entry.provider;
  }
  const slash = model.indexOf("/");
  return slash === -1 ? model : model.slice(0, slash);
}

/** Documented mapping table for the docs page and tests. */
export const PROVIDER_MAP_DOC: readonly { match: string; provider: string }[] = PROVIDER_MAP;

// ---------------------------------------------------------------------------
// Range window
// ---------------------------------------------------------------------------

/** `--range` windows, same vocabulary as `aiand logs`. */
export const EXPORT_RANGES = LOG_RANGES;

function rangeToSince(range: string, now: number): number {
  const table: Record<string, number> = {
    "15m": 15 * MINUTE_MS,
    "1h": HOUR_MS,
    "6h": 6 * HOUR_MS,
    "24h": DAY_MS,
    "7days": 7 * DAY_MS,
    "30days": 30 * DAY_MS,
  };
  const span = table[range];
  if (span === undefined) {
    throw new Error(`Unknown range "${range}" (expected one of: ${EXPORT_RANGES.join(", ")}).`);
  }
  return now - span;
}

// ---------------------------------------------------------------------------
// Store rows
// ---------------------------------------------------------------------------

type RequestRow = {
  id: string;
  model: string;
  api_key: string | null;
  endpoint: string | null;
  status_code: number;
  ttft_ms: number | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  cost: string | null;
  cost_value: number | null;
  currency: string | null;
  created_at: string;
};

function costOf(row: RequestRow): number | null {
  if (typeof row.cost_value === "number" && Number.isFinite(row.cost_value)) return row.cost_value;
  if (row.cost === null) return null;
  const parsed = Number(row.cost);
  return Number.isFinite(parsed) ? parsed : null;
}

/** One metric series with its OTel identity: name + sorted attributes. */
type Series = {
  name: string;
  kind: "sum" | "gauge" | "histogram";
  unit: string;
  attrs: [string, string][]; // sorted by key, insertion-stable order
  value?: number;
  /** Histograms: explicit bounds + per-bucket counts (+Inf implied). */
  bounds?: number[];
  counts?: number[];
  histSum?: number;
  histCount?: number;
};

export type Temporality = "delta" | "cumulative";

const TEMPORALITY_ENUM: Record<Temporality, number> = { delta: 1, cumulative: 2 };

export type ExportOptions = {
  range?: string;
  since?: string;
  until?: string;
  temporality?: Temporality;
};

export type ExportPayload = {
  temporality: Temporality;
  /** Inclusive window start (ISO) the sums cover. */
  windowStart: string;
  windowEnd: string;
  rows: number;
  otlp: string;
  prometheus: string;
  /** Metric names emitted, sorted — the test/docs contract. */
  metricNames: string[];
};

// ---------------------------------------------------------------------------
// Series construction
// ---------------------------------------------------------------------------

function attrsOf(entries: Record<string, string | undefined>): [string, string][] {
  return Object.entries(entries)
    .filter((pair): pair is [string, string] => typeof pair[1] === "string")
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
}

const TOKEN_BUCKETS_INPUT = [
  128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576,
];
const TOKEN_BUCKETS_OUTPUT = [
  16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536,
];
/** Latency histograms in seconds. */
const DURATION_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

function bucketize(values: number[], bounds: number[]): { counts: number[]; sum: number } {
  // Counts are CUMULATIVE (bucket i = values <= bounds[i], +Inf last), as
  // both OTLP Histogram and Prometheus exposition require.
  const per = new Array<number>(bounds.length + 1).fill(0);
  let sum = 0;
  for (const value of values) {
    let bucket = bounds.findIndex((b) => value <= b);
    if (bucket === -1) bucket = bounds.length;
    per[bucket] = (per[bucket] ?? 0) + 1;
    sum += value;
  }
  const counts: number[] = [];
  let running = 0;
  for (const count of per) {
    running += count;
    counts.push(running);
  }
  return { counts, sum };
}

function terminalType(): string {
  return process.env.TERM ?? "unknown";
}

/**
 * Map each request row to its heuristic session (#66): the session with the
 * same api_key whose [started_at, ended_at] contains the row's created_at.
 * Sessions cover every row by construction, so the lookup always matches.
 */
function sessionForRow(row: RequestRow, sessions: readonly SessionRow[]): SessionRow | undefined {
  const at = Date.parse(row.created_at);
  return sessions.find(
    (session) =>
      session.api_key === row.api_key &&
      Date.parse(session.started_at) <= at &&
      at <= Date.parse(session.ended_at),
  );
}

/**
 * Build the gen_ai metric family from one read of the local store.
 * Pure over the rows: same rows + same options → byte-identical series
 * (timestamps are applied at serialization, so golden fixtures are stable
 * modulo timestamps).
 */
function buildSeries(rows: readonly RequestRow[], sessions: readonly SessionRow[]): Series[] {
  const series: Series[] = [];

  // --- gen_ai usage counters -------------------------------------------------
  const genUsage = new Map<string, { attrs: [string, string][]; values: Record<string, number> }>();
  // --- gen_ai histograms -----------------------------------------------------
  const genHist = new Map<
    string,
    {
      attrs: [string, string][];
      tokens: number[];
      latencies: number[];
      ttfts: number[];
      outTokens: number[];
    }
  >();

  for (const row of rows) {
    const session = sessionForRow(row, sessions);

    const input = row.input_tokens ?? 0;
    const cached = row.cached_tokens ?? 0;
    const output = row.output_tokens ?? 0;

    // gen_ai: provider + required semconv attrs. error.type groups failed
    // rows separately; usage is recorded on failed operations too (semconv).
    const failed = row.status_code >= 400;
    const model = row.model;
    const genBase = attrsOf({
      "aiand.key.masked": row.api_key ?? "unknown",
      "agent.name": row.api_key
        ? (agentForMaskedKey(row.api_key, row.endpoint) ?? "unknown")
        : "unknown",
      "app.version": VERSION,
      "error.type": failed ? String(row.status_code) : undefined,
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": providerForModel(model),
      "gen_ai.request.model": model,
      "gen_ai.response.model": model,
      "gen_ai.token.modality": "text",
      "query.source": session ? session.agent : "unknown",
      "session.id": session?.session_id, // heuristic (#66) until the gateway provides real ids
      "terminal.type": terminalType(),
    });
    const genKey = JSON.stringify(genBase);
    const gen = genUsage.get(genKey) ?? { attrs: genBase, values: {} };
    // Gateway-verbatim sums: input includes cache; cache read is its own
    // series per semconv.
    gen.values.input_tokens = (gen.values.input_tokens ?? 0) + input;
    gen.values.output_tokens = (gen.values.output_tokens ?? 0) + output;
    gen.values.cache_read_tokens = (gen.values.cache_read_tokens ?? 0) + cached;

    const cost = costOf(row);
    if (cost !== null) gen.values.cost = (gen.values.cost ?? 0) + cost;

    genUsage.set(genKey, gen);

    const histKey = genKey;
    const hist = genHist.get(histKey) ?? {
      attrs: genBase,
      tokens: [],
      latencies: [],
      ttfts: [],
      outTokens: [],
    };
    if (input > 0 || output > 0) {
      hist.tokens.push(input);
      hist.outTokens.push(output);
    }
    if (row.latency_ms !== null) hist.latencies.push(row.latency_ms / 1000);
    if (row.ttft_ms !== null) hist.ttfts.push(row.ttft_ms / 1000);
    genHist.set(histKey, hist);
  }

  const GEN_TOKEN_NAMES: readonly { key: string; name: string; unit: string }[] = [
    { key: "cost", name: "gen_ai.client.inference.usage.cost", unit: "USD" },
    { key: "input_tokens", name: "gen_ai.client.inference.usage.input_tokens", unit: "{token}" },
    { key: "output_tokens", name: "gen_ai.client.inference.usage.output_tokens", unit: "{token}" },
    {
      key: "cache_read_tokens",
      name: "gen_ai.client.inference.usage.cache_read_tokens",
      unit: "{token}",
    },
  ];
  for (const group of genUsage.values()) {
    for (const entry of GEN_TOKEN_NAMES) {
      const value = group.values[entry.key];
      if (value === undefined) continue; // emit-only-where-data-exists
      series.push({
        name: entry.name,
        kind: "sum",
        unit: entry.unit,
        attrs: group.attrs,
        value,
      });
    }
  }

  for (const hist of genHist.values()) {
    const inputH = bucketize(hist.tokens, TOKEN_BUCKETS_INPUT);
    series.push({
      name: "gen_ai.client.inference.operation.input_tokens",
      kind: "histogram",
      unit: "{token}",
      attrs: hist.attrs,
      bounds: TOKEN_BUCKETS_INPUT,
      counts: inputH.counts,
      histSum: inputH.sum,
      histCount: hist.tokens.length,
    });
    const outputH = bucketize(hist.outTokens, TOKEN_BUCKETS_OUTPUT);
    series.push({
      name: "gen_ai.client.inference.operation.output_tokens",
      kind: "histogram",
      unit: "{token}",
      attrs: hist.attrs,
      bounds: TOKEN_BUCKETS_OUTPUT,
      counts: outputH.counts,
      histSum: outputH.sum,
      histCount: hist.outTokens.length,
    });
    const dur = bucketize(hist.latencies, DURATION_BUCKETS);
    series.push({
      name: "gen_ai.client.inference.duration",
      kind: "histogram",
      unit: "s",
      attrs: hist.attrs,
      bounds: DURATION_BUCKETS,
      counts: dur.counts,
      histSum: dur.sum,
      histCount: hist.latencies.length,
    });
    // The gateway's latency_ms IS the server-side request duration.
    series.push({
      name: "gen_ai.server.request.duration",
      kind: "histogram",
      unit: "s",
      attrs: hist.attrs,
      bounds: DURATION_BUCKETS,
      counts: dur.counts,
      histSum: dur.sum,
      histCount: hist.latencies.length,
    });
    const ttft = bucketize(hist.ttfts, DURATION_BUCKETS);
    series.push({
      name: "gen_ai.server.time_to_first_token",
      kind: "histogram",
      unit: "s",
      attrs: hist.attrs,
      bounds: DURATION_BUCKETS,
      counts: ttft.counts,
      histSum: ttft.sum,
      histCount: hist.ttfts.length,
    });
  }

  return series.sort(
    (a, b) =>
      a.name.localeCompare(b.name) ||
      JSON.stringify(a.attrs).localeCompare(JSON.stringify(b.attrs)),
  );
}

// ---------------------------------------------------------------------------
// # HELP text (ticket #149): every emitted family gets one, printed before
// its # TYPE. Canonical metric name → help text.
// ---------------------------------------------------------------------------

export const HELP: Record<string, string> = {
  "gen_ai.client.inference.duration":
    "Time per inference operation (server latency), in seconds — gateway latency_ms.",
  "gen_ai.client.inference.operation.input_tokens":
    "Distribution of input tokens per inference operation (gateway-verbatim sums; input includes cached).",
  "gen_ai.client.inference.operation.output_tokens":
    "Distribution of output tokens per inference operation.",
  "gen_ai.client.inference.usage.cache_read_tokens":
    "Cache-read (cached) tokens summed over the window — its own series per semconv, never subtracted from input.",
  "gen_ai.client.inference.usage.cost":
    "Gateway-computed per-request cost summed over the window (USD).",
  "gen_ai.client.inference.usage.input_tokens":
    "Input tokens summed over the window — verbatim gateway sum, INCLUDES cached tokens.",
  "gen_ai.client.inference.usage.output_tokens": "Output tokens summed over the window.",
  "gen_ai.server.request.duration":
    "Server-side request duration in seconds — the gateway's latency_ms.",
  "gen_ai.server.time_to_first_token":
    "Time to first token in seconds — the gateway's ttft_ms; rows without ttft are excluded from the histogram, not zeroed.",
  "aiand.harness.sessions":
    "Number of heuristic time-gap sessions attributed to the harness in the window (#66 sessionization).",
  "aiand.harness.cost_per_session_usd":
    "Median (p50) cost per session in USD — only when the store's cost rows are USD or currency-less.",
  "aiand.harness.ttft_p95_ms":
    "95th percentile time to first token in milliseconds across the harness's window rows.",
  "aiand.harness.cache_hit_ratio":
    "cached_tokens / input_tokens for the harness's window rows (estimated heuristic).",
  "aiand.harness.error_rate":
    "Non-2xx excluding 429 requests / all requests for the harness (estimated heuristic).",
  "aiand.harness.clean_rate":
    "Clean-terminal sessions / all terminal sessions (clean+aborted+errored); omitted when no terminal information.",
  "aiand.harness.tool_error_rate":
    "Errored tool outcomes / captured tool outcomes; omitted when the behavioral source does not cover tool outcomes.",
  "aiand.harness.behavioral_coverage_ratio":
    "Behaviorally covered requests / total requests in the window; omitted when there are no requests.",
  "aiand.store.sync_lag_seconds":
    "Seconds since the local store's last successful sync (local store freshness, NOT gateway freshness); omitted when the store has never synced.",
  "aiand.store.requests_total": "Request rows in the export window held by the local store.",
};

// ---------------------------------------------------------------------------
// Harness + store gauges (#149)
// ---------------------------------------------------------------------------

/**
 * The per-harness and store-level gauges: point-in-time readings from one
 * store read, NOT windowed sums. Attributes are `agent.name` only — the
 * collision safety the gen_ai counters need (masked key + model + session)
 * does not apply: a gauge per harness is the aggregation the compare surface
 * already shows, and a stable label set keeps the series foldable in
 * Prometheus. Absent data is omitted (no cost → no cost gauge; no terminal
 * info → no clean-rate gauge); zeros are never fabricated for uncovered
 * cells. Non-finite values (p95 over an empty set) are likewise omitted.
 */
function buildGauges(stats: HarnessStats): Series[] {
  const series: Series[] = [];

  for (const harness of stats.harnesses) {
    const attrs: [string, string][] = [["agent.name", harness.harness]];

    series.push({
      name: "aiand.harness.sessions",
      kind: "gauge",
      unit: "{session}",
      attrs,
      value: harness.sessions,
    });

    // Cost gauge: emit-only-where-data-exists, and only in the store's
    // single currency (usd or currency-less).
    if (
      harness.costPerSession.p50 !== null &&
      (harness.currency === null || harness.currency.toLowerCase() === "usd")
    ) {
      series.push({
        name: "aiand.harness.cost_per_session_usd",
        kind: "gauge",
        unit: "USD",
        attrs,
        value: harness.costPerSession.p50,
      });
    }

    if (harness.ttft.p95 !== null) {
      series.push({
        name: "aiand.harness.ttft_p95_ms",
        kind: "gauge",
        unit: "ms",
        attrs,
        value: harness.ttft.p95,
      });
    }

    if (harness.requests > 0) {
      series.push({
        name: "aiand.harness.cache_hit_ratio",
        kind: "gauge",
        unit: "1",
        attrs,
        value: harness.cacheHitRatio,
      });
      series.push({
        name: "aiand.harness.error_rate",
        kind: "gauge",
        unit: "1",
        attrs,
        value: harness.errorRate,
      });
    }

    // Behavioral cells ride the #146 source precedence: envelope turns ≥
    // MIN_BEHAVIORAL_TURNS, else imported markers, else uncovered (omitted).
    const behavioral = harness.behavioral;
    if (behavioral.cleanRate !== null) {
      series.push({
        name: "aiand.harness.clean_rate",
        kind: "gauge",
        unit: "1",
        attrs,
        value: behavioral.cleanRate,
      });
    }
    if (behavioral.toolErrorRate !== null) {
      series.push({
        name: "aiand.harness.tool_error_rate",
        kind: "gauge",
        unit: "1",
        attrs,
        value: behavioral.toolErrorRate,
      });
    }
  }

  // Window-level behavioral coverage: covered requests / total requests;
  // a requestless window omits the gauge rather than asserting 0.
  const coverage = stats.behavioralCoverage;
  if (coverage.total > 0) {
    series.push({
      name: "aiand.harness.behavioral_coverage_ratio",
      kind: "gauge",
      unit: "1",
      attrs: [],
      value: coverage.ratio ?? 0,
    });
  }

  return series;
}

/**
 * Store freshness gauges, no attributes. sync_lag is local store freshness
 * (now − last_sync_at) — NOT gateway freshness — and is omitted entirely when
 * the store has never synced, never zeroed.
 */
function buildStoreGauges(lastSyncAt: string | null): Series[] {
  const series: Series[] = [];
  if (lastSyncAt !== null) {
    const parsed = Date.parse(lastSyncAt);
    if (!Number.isNaN(parsed)) {
      series.push({
        name: "aiand.store.sync_lag_seconds",
        kind: "gauge",
        unit: "s",
        attrs: [],
        value: Math.max(0, (Date.now() - parsed) / 1000),
      });
    }
  }
  return series;
}

// ---------------------------------------------------------------------------
// Serialization: OTLP/HTTP JSON (protobuf-JSON shape)
// ---------------------------------------------------------------------------

function attrJson(attrs: [string, string][]): unknown {
  return attrs.map(([key, value]) => ({ key, value: { stringValue: value } }));
}

/** OTLP int64 data points are integers; non-integer sums (USD) use asDouble. */
function valuePoint(value: number): Record<string, string | number> {
  return Number.isInteger(value) ? { asInt: String(value) } : { asDouble: value };
}

function serializeOtlp(series: readonly Series[], temporality: Temporality): unknown {
  const nowNs = String(BigInt(Date.now()) * 1_000_000n);
  const startNs = nowNs;
  const metrics = new Map<string, Series[]>();
  for (const s of series) {
    const list = metrics.get(s.name) ?? [];
    list.push(s);
    metrics.set(s.name, list);
  }

  const metricJson = [...metrics.entries()].map(([name, list]) => {
    const first = list[0];
    if (!first) return {};
    if (first.kind === "gauge") {
      return {
        name,
        unit: first.unit,
        gauge: {
          dataPoints: list.map((s) => ({
            attributes: attrJson(s.attrs),
            ...valuePoint(s.value ?? 0),
            timeUnixNano: nowNs,
          })),
        },
      };
    }
    if (first.kind === "sum") {
      return {
        name,
        unit: first.unit,
        sum: {
          aggregationTemporality: TEMPORALITY_ENUM[temporality],
          isMonotonic: true,
          dataPoints: list.map((s) => ({
            attributes: attrJson(s.attrs),
            ...valuePoint(s.value ?? 0),
            timeUnixNano: nowNs,
            startTimeUnixNano: startNs,
          })),
        },
      };
    }
    return {
      name,
      unit: first.unit,
      histogram: {
        aggregationTemporality: TEMPORALITY_ENUM[temporality],
        dataPoints: list.map((s) => ({
          attributes: attrJson(s.attrs),
          count: String(s.histCount ?? 0),
          sum: s.histSum ?? 0,
          bucketCounts: (s.counts ?? []).map((c) => String(c)),
          explicitBounds: s.bounds ?? [],
          timeUnixNano: nowNs,
          startTimeUnixNano: startNs,
        })),
      },
    };
  });

  return {
    resourceMetrics: [
      {
        resource: {
          attributes: attrJson([
            ["service.name", "aiand"],
            ["service.version", VERSION],
          ]),
        },
        scopeMetrics: [
          {
            scope: { name: "aiand.otel", version: VERSION },
            metrics: metricJson,
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Serialization: Prometheus text exposition
// ---------------------------------------------------------------------------

function promName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, "_");
}

function promLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function promLabels(attrs: [string, string][]): string {
  if (attrs.length === 0) return "";
  const parts = attrs.map(([k, v]) => `${promName(k)}="${promLabelValue(v)}"`);
  return `{${parts.join(",")}}`;
}

function serializePrometheus(series: readonly Series[]): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  const names = [...new Set(series.map((s) => s.name))].sort();
  for (const name of names) {
    const metric = promName(name);
    const list = series.filter((s) => s.name === name);
    const first = list[0];
    if (!first) continue;
    if (!seen.has(metric)) {
      seen.add(metric);
      // #149: every emitted family carries a HELP line, before its TYPE.
      const help = HELP[name];
      if (help !== undefined) lines.push(`# HELP ${metric} ${help}`);
      const type =
        first.kind === "sum" ? "counter" : first.kind === "gauge" ? "gauge" : "histogram";
      lines.push(`# TYPE ${metric} ${type}`);
      if (first.unit !== "1") lines.push(`# UNIT ${metric} ${first.unit}`);
    }
    if (first.kind === "sum") {
      for (const s of list) {
        lines.push(`${metric}${promLabels(s.attrs)} ${s.value ?? 0}`);
      }
    } else if (first.kind === "gauge") {
      for (const s of list) {
        lines.push(`${metric}${promLabels(s.attrs)} ${s.value ?? 0}`);
      }
    } else {
      for (const s of list) {
        const labels = s.attrs;
        const bounds = s.bounds ?? [];
        const counts = s.counts ?? [];
        for (let i = 0; i < bounds.length; i += 1) {
          const le = bounds[i];
          const bucketLabels: [string, string][] = [...labels, ["le", String(le)]];
          lines.push(`${metric}_bucket${promLabels(bucketLabels)} ${counts[i] ?? 0}`);
        }
        lines.push(
          `${metric}_bucket${promLabels([...labels, ["le", "+Inf"]])} ${s.histCount ?? 0}`,
        );
        lines.push(`${metric}_sum${promLabels(labels)} ${s.histSum ?? 0}`);
        lines.push(`${metric}_count${promLabels(labels)} ${s.histCount ?? 0}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Store read + payload assembly
// ---------------------------------------------------------------------------

/**
 * Read the window's rows from the local store in one pass, sessionize, build
 * the gen_ai family plus the #149 harness/store gauges, and serialize both
 * wire formats. Never throws at the caller for a degraded store — an
 * unavailable store exports an empty payload.
 */
export function buildExportPayload(opts: ExportOptions = {}): ExportPayload {
  const temporality = opts.temporality ?? "delta";
  const now = Date.now();
  const defaultSince = rangeToSince(opts.range ?? "30days", now);
  const sinceMs = opts.since !== undefined ? Date.parse(opts.since) : defaultSince;
  const untilMs = opts.until !== undefined ? Date.parse(opts.until) : now;

  const sinceIso = new Date(sinceMs).toISOString();
  const untilIso = new Date(untilMs).toISOString();

  const opened = openStore(storePath());
  let rows: RequestRow[] = [];
  let sessions: readonly SessionRow[] = [];
  let harnessStats: HarnessStats | null = null;
  let lastSyncAt: string | null = null;
  if (opened.ok) {
    const db = opened.db;
    try {
      rows = db
        .prepare(
          "SELECT id, model, api_key, endpoint, status_code, ttft_ms, latency_ms, input_tokens, " +
            "output_tokens, cached_tokens, cost, cost_value, currency, created_at FROM requests " +
            `WHERE ${createdSince()} AND ${createdUntilIncl()} ORDER BY created_at, id`,
        )
        .all(sinceIso, untilIso) as unknown as RequestRow[];
      const listed = listSessions({
        since: sinceIso,
        until: untilIso,
      });
      sessions = listed.sessions;

      // #149: the behavioral sources ride the SAME db handle — envelopes and
      // imported markers join the one-read discipline; obs never imports
      // from commands/, the window mapping happens here.
      const envelopes = listEnvelopesFromDb(db, { since: sinceIso, until: untilIso }).map(
        (row) => ({ agent: row.agent, model: row.model, envelope: row.envelope }),
      );
      const importedMarkers = listImportedArtifactsFromDb(db, {
        since: sinceIso,
        until: untilIso,
      });
      // Harness gauges read the same rows the gen_ai family reads; the
      // window's range/gap default (10-minute time-gap sessionization) and
      // the store watermark ride along for provenance.
      harnessStats = buildHarnessStats(rows, {
        gapMinutes: 10,
        storeWatermark: null,
        range: { since: sinceIso, until: untilIso },
        envelopes,
        importedMarkers,
      });
      // Local store freshness (not gateway freshness) for sync_lag_seconds —
      // read inside the SAME handle; a missing sync_meta row means the store
      // has never synced and the gauge is omitted, never zeroed.
      const syncRow = db.prepare("SELECT value FROM sync_meta WHERE key = 'last_sync_at'").get() as
        | Record<string, unknown>
        | undefined;
      lastSyncAt = typeof syncRow?.value === "string" ? syncRow.value : null;
    } finally {
      try {
        db.close();
      } catch {
        // already closed
      }
    }
  }

  // Sessions whose window intersects the filter are included whole
  // (listSessions semantics); a session may span rows outside `rows` when
  // until/since clips mid-session — cost/token series then cover only the
  // window's rows, which is the documented window semantics.
  const series = buildSeries(rows, sessions);
  if (harnessStats !== null) {
    series.push(...buildGauges(harnessStats));
    series.push(...buildStoreGauges(lastSyncAt));
    // requests_total: window rows the store holds — a gauge reading, present
    // whenever the store opened (even at zero rows: the store answered, 0 is
    // a measurement, not a fabrication).
    series.push({
      name: "aiand.store.requests_total",
      kind: "gauge",
      unit: "{request}",
      attrs: [],
      value: rows.length,
    });
  }
  const otlp = serializeOtlp(series, temporality);
  return {
    temporality,
    windowStart: sinceIso,
    windowEnd: untilIso,
    rows: rows.length,
    otlp: `${JSON.stringify(otlp, null, 2)}\n`,
    prometheus: serializePrometheus(series),
    metricNames: [...new Set(series.map((s) => s.name))].sort(),
  };
}
