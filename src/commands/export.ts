import { openSession } from "../api/client.js";
import { bool, list, oneOf, parse, str } from "../cli/args.js";
import { CliError } from "../cli/errors.js";
import { err, out, style } from "../cli/output.js";
import { resolveProfile } from "../config.js";
import { writeFileAtomic } from "../fsutil.js";
import { buildExportPayload, EXPORT_RANGES, type Temporality } from "../obs/otel.js";
import { noSyncRequested, syncStore } from "../store/index.js";

/**
 * `aiand export` (feature catalog G2, ticket #72): metrics export from the
 * local request store in two families — `claude_code.*` (drop-in dashboard
 * compatibility) and `gen_ai.*` (vendor-neutral OTel GenAI semconv) — in one
 * store read. See src/obs/otel.ts for the metric contract.
 *
 * Destinations: stdout (default), `--file`, or a push to `--endpoint`
 * (OTLP/HTTP JSON per protobuf-JSON encoding; the Prometheus format pushes
 * text/plain). Prometheus pull (`:9464` scrape endpoint) is deliberately NOT
 * implemented: the CLI is short-lived, so a scrape target would have to stay
 * running — push-file is the documented choice (docs/observability/otel-export.md).
 */

const FORMAT_ONE_OF = ["otel", "prometheus"] as const;
const TEMPORALITY_ONE_OF = ["delta", "cumulative"] as const;

export const help = `${style.bold("aiand export")} -- export usage metrics (OTel / Prometheus)

Usage
  aiand export --format otel
  aiand export --format prometheus --file metrics.prom
  aiand export --format otel --endpoint http://localhost:4318/v1/metrics

Options
  --format <f>        otel (OTLP/HTTP JSON) or prometheus (text exposition);
                      default otel
  --range <window>    15m, 1h, 6h, 24h, 7days (default), 30days
  --since <iso>       window start override (ISO timestamp, UTC)
  --until <iso>       window end override (ISO timestamp, UTC)
  --temporality <t>   delta (default) or cumulative
  --endpoint <url>    POST the payload to this URL instead of stdout
  --header <h>        extra request header with --endpoint, repeatable
                      ("Name: value" or "Name=value")
  --file <path>       write the payload to this file instead of stdout
  --no-sync           skip the store sync first (also AIAND_NO_SYNC=1)

Both metric families are emitted from one read of the local store:
claude_code.* for Claude Code dashboard compatibility and gen_ai.* per the
OpenTelemetry GenAI semantic conventions. Session ids are heuristic (time-gap
derived); cacheCreation/cache-write tokens are 0 until the gateway splits
cache writes. No prompt or completion content is ever exported.`;

function parseHeader(raw: string): [string, string] {
  const sep =
    raw.includes(":") && (!raw.includes("=") || raw.indexOf(":") < raw.indexOf("=")) ? ":" : "=";
  const idx = raw.indexOf(sep);
  const name = raw.slice(0, idx).trim();
  const value = raw.slice(idx + 1).trim();
  if (name.length === 0 || value.length === 0 || !/^[\w-]+$/.test(name)) {
    throw new CliError(`Invalid --header value: "${raw}".`, {
      hint: 'Use "Name: value" (or "Name=value"), e.g. --header "x-api-key: secret".',
    });
  }
  return [name, value];
}

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    format: { type: "string" },
    range: { type: "string" },
    since: { type: "string" },
    until: { type: "string" },
    temporality: { type: "string" },
    endpoint: { type: "string" },
    header: { type: "string", multiple: true },
    file: { type: "string" },
    "no-sync": { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  const format = oneOf(parsed, "format", FORMAT_ONE_OF, "otel");
  const range = oneOf(parsed, "range", EXPORT_RANGES, "30days");
  const temporality = oneOf<Temporality>(parsed, "temporality", TEMPORALITY_ONE_OF, "delta");
  const since = str(parsed, "since");
  const until = str(parsed, "until");
  for (const [value, flag] of [
    [since, "--since"],
    [until, "--until"],
  ] as const) {
    if (value !== undefined && Number.isNaN(Date.parse(value))) {
      throw new CliError(`Invalid ${flag} value: ${value}.`, {
        hint: "Use an ISO timestamp, e.g. 2026-10-25T00:00:00Z.",
      });
    }
  }
  // #87: an inverted --since/--until pair exports an empty window; reject it.
  if (since !== undefined && until !== undefined && Date.parse(since) > Date.parse(until)) {
    throw new CliError(`--since ${since} is after --until ${until}.`, {
      hint: "Pass an earlier --since or a later --until.",
    });
  }
  const endpoint = str(parsed, "endpoint");
  const file = str(parsed, "file");
  if (endpoint !== undefined && file !== undefined) {
    throw new CliError("--endpoint and --file are mutually exclusive.");
  }
  const headers = list(parsed, "header").map(parseHeader);

  // Pre-command sync, best-effort (the observability commands' convention):
  // a failure warns and the export serves local data, never fails.
  if (!bool(parsed, "no-sync") && !noSyncRequested()) {
    try {
      const session = await openSession(resolveProfile(str(parsed, "profile")));
      const result = await syncStore(session, { range });
      if (!result.ok) {
        err(style.yellow(`Warning: sync failed (${result.error}). Serving local data.`));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "sync failed");
      err(style.yellow(`Warning: sync failed (${message}). Serving local data.`));
    }
  }

  const payload = buildExportPayload({ range, since, until, temporality });
  const body = format === "otel" ? payload.otlp : payload.prometheus;
  const contentType = format === "otel" ? "application/json" : "text/plain; version=0.0.4";

  if (endpoint !== undefined) {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": contentType, ...Object.fromEntries(headers) },
        body,
      });
    } catch (error) {
      throw new CliError(
        `Could not reach the export endpoint: ${
          error instanceof Error ? error.message : String(error ?? "")
        }`,
      );
    }
    if (!response.ok) {
      throw new CliError(
        `Export endpoint returned HTTP ${response.status} ${response.statusText}.`,
      );
    }
    err(
      style.green(
        `Exported ${payload.rows} request${payload.rows === 1 ? "" : "s"} ` +
          `(${format}, ${temporality}) to ${endpoint}.`,
      ),
    );
    return;
  }

  if (file !== undefined) {
    await writeFileAtomic(file, body);
    err(
      style.green(
        `Wrote ${format} metrics for ${payload.rows} request${
          payload.rows === 1 ? "" : "s"
        } (${temporality}) to ${file}.`,
      ),
    );
    return;
  }

  // Payload on stdout; the summary goes to stderr so piping stays clean.
  process.stdout.write(body);
  err(
    style.dim(
      `${payload.rows} request${payload.rows === 1 ? "" : "s"} in ` +
        `${payload.windowStart} .. ${payload.windowEnd} (${temporality})`,
    ),
  );
}
