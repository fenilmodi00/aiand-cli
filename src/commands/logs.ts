import { openSession, type Session } from "../api/client.js";
import { getLogs, getLogsPaged, LOG_PAGE_MAX, LOG_RANGES, type LogEntry } from "../api/logs.js";
import { modelLabel } from "../api/models.js";
import { bool, int, oneOf, parse, str } from "../cli/args.js";
import { CliError } from "../cli/errors.js";
import {
  type CellValue,
  currencySymbol,
  err,
  json,
  num,
  out,
  relativeTime,
  renderCell,
  type Styled,
  style,
  styled,
  table,
} from "../cli/output.js";
import { resolveProfile } from "../config.js";
import { storeBudgetWarning } from "../obs/forecast.js";
import { requestTps } from "../obs/tps.js";
import { SECOND_MS } from "../time.js";

const DEFAULT_LIMIT = 20;
const FOLLOW_INTERVAL_SECONDS = 5;

export const help = `${style.bold("aiand logs")} -- recent inference requests

Usage
  aiand logs
  aiand logs --errors --range 1h
  aiand logs --follow

Options
  --range <window>    15m, 1h, 6h, 24h (default), 7days, 30days
  --errors            only non-2xx requests
  --limit <n>         rows to fetch, paging as needed (default ${DEFAULT_LIMIT})
  --follow            poll for new requests until interrupted
  --interval <s>      poll interval for --follow (default ${FOLLOW_INTERVAL_SECONDS})
  --no-warn           suppress the budget-threshold warning (also AIAND_NO_WARN=1)
  --json              machine-readable output`;

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    range: { type: "string" },
    errors: { type: "boolean", default: false },
    limit: { type: "string" },
    follow: { type: "boolean", default: false },
    interval: { type: "string" },
    "no-warn": { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  if (parsed.positionals.length > 0) {
    throw new CliError(`Unknown argument "${parsed.positionals[0]}".`, {
      hint: "Run `aiand logs --help` to see the subcommands and flags.",
    });
  }

  const session = await openSession(resolveProfile(str(parsed, "profile")));
  const range = oneOf(parsed, "range", LOG_RANGES, "24h");
  const errorsOnly = bool(parsed, "errors");

  if (bool(parsed, "follow")) {
    return follow(session, {
      range,
      errorsOnly,
      intervalMs: Math.max(1, int(parsed, "interval") ?? FOLLOW_INTERVAL_SECONDS) * SECOND_MS,
      asJson: bool(parsed, "json"),
    });
  }

  const { entries, truncated } = await getLogsPaged(session, {
    range,
    errorsOnly,
    limit: Math.max(1, int(parsed, "limit") ?? DEFAULT_LIMIT),
  });

  if (bool(parsed, "json"))
    return json(
      entries.map((e) => ({ ...e, tps: requestTps(e.output_tokens, e.ttft_ms, e.latency_ms) })),
    );

  if (entries.length === 0) {
    out(style.dim(`No ${errorsOnly ? "failed " : ""}requests in the last ${range}.`));
    return;
  }

  printTable(entries);

  // The budget-threshold warning (ticket #74): stderr when monthly spend
  // crosses budget.warn-pct, suppressible via --no-warn / AIAND_NO_WARN=1.
  const budgetWarning = storeBudgetWarning(bool(parsed, "no-warn"));
  if (budgetWarning) err(style.yellow(budgetWarning));

  out();
  const noun = `request${entries.length === 1 ? "" : "s"}`;
  out(
    style.dim(
      truncated
        ? `showing ${entries.length} ${noun} in the last ${range} (use --limit to see more).`
        : `${entries.length} ${noun} in the last ${range}.`,
    ),
  );
}

/**
 * A numeric log field for a cell. The gateway's value is untrusted until it
 * has been through Number(), so a string or object where a number belongs
 * prints `-` instead of reaching the terminal.
 */
function metric(value: unknown, format: (n: number) => string = String): string {
  if (value === null || value === undefined || value === "") return "-";
  const n = Number(value);
  return Number.isFinite(n) ? format(n) : "-";
}

const milliseconds = (value: unknown): string => metric(value, (n) => `${n}ms`);

function printTable(entries: LogEntry[]): void {
  table<LogEntry>(entries, [
    { header: "when", value: (e) => relativeTime(e.created_at) },
    { header: "status", value: (e) => statusCell(e.status_code), align: "right" },
    { header: "model", value: (e) => modelLabel(e.model) },
    { header: "in", value: (e) => metric(e.input_tokens, num), align: "right" },
    { header: "out", value: (e) => metric(e.output_tokens, num), align: "right" },
    {
      header: "cached",
      value: (e) =>
        Number(e.cached_tokens) ? metric(e.cached_tokens, num) : styled(style.dim, "-"),
      align: "right",
    },
    { header: "ttft", value: (e) => milliseconds(e.ttft_ms), align: "right" },
    { header: "latency", value: (e) => milliseconds(e.latency_ms), align: "right" },
    {
      header: "tok/s",
      value: (e) => {
        const tps = requestTps(e.output_tokens, e.ttft_ms, e.latency_ms);
        return tps === null ? "-" : tps.toFixed(1);
      },
      align: "right",
    },
    { header: "cost", value: (e) => costCell(e), align: "right" },
    { header: "key", value: (e) => styled(style.dim, e.api_key) },
  ]);
}

function statusCell(value: unknown): Styled {
  if (value === null || value === undefined || value === "") return styled(style.dim, "-");
  const status = Number(value);
  if (!Number.isFinite(status)) return styled(style.dim, "-");
  if (status >= 500) return styled(style.red, String(status));
  if (status >= 400) return styled(style.yellow, String(status));
  return styled(style.green, String(status));
}

function costCell(entry: LogEntry): CellValue {
  if (!entry.cost) return styled(style.dim, "-");
  return `${currencySymbol(entry.currency)}${entry.cost}`;
}

async function follow(
  session: Session,
  options: {
    range: (typeof LOG_RANGES)[number];
    errorsOnly: boolean;
    intervalMs: number;
    asJson: boolean;
  },
): Promise<void> {
  const seen = new Set<string>();
  const controller = new AbortController();
  let running = true;
  const stop = () => {
    running = false;
    controller.abort();
  };
  process.once("SIGINT", stop);
  try {
    if (!options.asJson) {
      err(style.dim(`Following ${options.errorsOnly ? "failed " : ""}requests. Ctrl-C to stop.`));
    }

    const seed = await getLogs(session, {
      range: options.range,
      errorsOnly: options.errorsOnly,
      limit: LOG_PAGE_MAX,
    });
    for (const entry of seed.data) seen.add(entry.id);

    while (running) {
      await sleep(options.intervalMs, controller.signal);
      if (!running) break;

      const page = await getLogs(session, {
        range: options.range,
        errorsOnly: options.errorsOnly,
        limit: LOG_PAGE_MAX,
      });
      const fresh = page.data.filter((entry) => !seen.has(entry.id)).reverse();
      for (const entry of fresh) seen.add(entry.id);
      if (fresh.length === 0) continue;

      for (const entry of fresh) {
        // #155: follow rows carry the same derived `tps` key as --json's
        // one-shot path — never the raw entry without it.
        out(
          options.asJson
            ? JSON.stringify({
                ...entry,
                tps: requestTps(entry.output_tokens, entry.ttft_ms, entry.latency_ms),
              })
            : followRow(entry),
        );
      }
    }
  } finally {
    process.removeListener("SIGINT", stop);
  }
}

function followRow(entry: LogEntry): string {
  const tokens = `${metric(entry.input_tokens)}/${metric(entry.output_tokens)}`;
  return [
    styled(style.dim, String(entry.created_at).slice(11, 19)),
    statusCell(entry.status_code),
    modelLabel(entry.model),
    styled(style.dim, `${tokens} tok`),
    styled(style.dim, milliseconds(entry.latency_ms)),
    costCell(entry),
  ]
    .map(renderCell)
    .join("  ");
}

// Abortable sleep that resolves (never rejects) on abort, so --follow treats
// Ctrl-C as a clean stop instead of an error.
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
