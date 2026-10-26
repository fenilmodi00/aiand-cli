import { AGENTS } from "../agents/registry.js";
import { type AgentStatusResult, agentStatus } from "../agents/setup.js";
import { openSession } from "../api/client.js";
import { authStatus } from "../auth/identity.js";
import { bool, parse, str } from "../cli/args.js";
import { CliError, EXIT } from "../cli/errors.js";
import { err, fields, json, out, style, table } from "../cli/output.js";
import { resolveProfile } from "../config.js";
import { writeFileAtomic } from "../fsutil.js";
import {
  computeStatusline,
  SCHEMA_VERSION,
  type StatuslineResult,
  WATCH_DEFAULT_INTERVAL_MS,
  WATCH_MIN_INTERVAL_MS,
  WATCH_STALE_FACTOR,
} from "../obs/statusline.js";
import { syncStore } from "../store/index.js";
import { stateLabel } from "./agent.js";

export const help = `${style.bold("aiand status")} -- sign-in state and spend at a glance

Usage
  aiand status [options]

Two surfaces share this command:

Auth surface (default): who you are signed in as, which agents are wired
  to ai&, plus the one-line spend statusline from the local store.

Options
  --json              machine-readable output ({auth, agents})
  --local             read the cached identity without calling the API
  --profile <name>    inspect a specific profile

Observability surface (statusline / automation, ticket #71): reads the local
request store only — never a blocking gateway call. Empty or unsynced store
degrades to verdict "no-data", never a network attempt.

  --format line       the one-line statusline, exactly one line, no box
                      drawing; safe for statusline hooks when piped
  --format json       the snapshot object plus session context (superset)
  --write-state <p>   write the versioned machine snapshot to <p> (atomic)
                      and exit; prints nothing on stdout unless --print
  --print             also print the line with --write-state
  --watch [seconds]   refresh in place (default ${WATCH_DEFAULT_INTERVAL_MS / 1000}s, min
                      ${WATCH_MIN_INTERVAL_MS / 1000}s); data older than
                      ${WATCH_STALE_FACTOR}x the interval renders a dim "stale HH:MM"
                      suffix; Ctrl-C exits 0
  --sync-first        chain one explicit gateway sync before rendering
                      (otherwise status never touches the network)

The statusline (block segment omitted in v1 — no block pricing yet):

  💰 $2.10 session / $8.40 today | 🔥 $1.85/hr 🟢 | 45%→72% of budget | ttft p50 320ms

Session and today spend are gateway-billed sums from the store ("session" is
the most recent time-gap session — its boundary is a heuristic, its cost is
verbatim); the burn rate and the projected side of the pacing segment are
heuristic(burn-rate v1). Full provenance labels are in --format json and the
snapshot. The pacing segment appears only when budget.monthly is set.

Snapshot contract (--write-state): a JSON object with schema_version
(currently ${SCHEMA_VERSION}), generated_at (ISO 8601 UTC), source, spend
{session, today, currency}, burn {per_hour, currency}, budget
{monthly, used, remaining, projected_pct} or null, verdict, ttft {p50_ms},
stale, and provenance labels. Written atomically (temp file in the same
directory, then rename). Versioning policy: ADDITIVE changes (new optional
fields) keep schema_version 1; BREAKING changes (removing or re-typing
fields) bump it — consumers must refuse unknown major versions.

Automation exit codes (set on every observability-surface run, including the
same run as --write-state):

  0   ok
  10  near-limit  (at/above the near-limit threshold of the budget, or
                   projected to exceed it this month)
  11  limit-hit   (the budget is fully used)
  20  indeterminate (a budget is set but the data behind the verdict is
                   incomplete or untrustworthy — too little history for a
                   rate, or mixed currencies in the store)
  30  no-data     (the store is empty or has never synced)

Plain \`aiand status\` (auth surface) keeps its documented exit codes: 0
signed in (or the gateway is merely unreachable), 1 signed out.`;

/**
 * Expand a bare `--watch` to the default interval before parsing: node's
 * parseArgs has no optional-value flags, and `--watch 10` (value form) and
 * `--watch=10` must both work alongside the flag-only spelling.
 */
function expandBareWatch(argv: string[]): string[] {
  return argv.map((arg, i) => {
    if (arg !== "--watch") return arg;
    const next = argv[i + 1];
    return next === undefined || next.startsWith("-")
      ? `--watch=${WATCH_DEFAULT_INTERVAL_MS / 1000}`
      : arg;
  });
}

export async function run(argv: string[]): Promise<void> {
  const args = expandBareWatch(argv);
  const parsed = parse(args, {
    local: { type: "boolean", default: false },
    format: { type: "string" },
    watch: { type: "string" },
    "write-state": { type: "string" },
    print: { type: "boolean", default: false },
    "sync-first": { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  // The observability surface is explicitly requested; it never calls the
  // gateway (except --sync-first) and never changes the auth exit codes.
  const format = str(parsed, "format");
  const writeState = str(parsed, "write-state");
  const watch = str(parsed, "watch");
  if (format !== undefined || writeState !== undefined || watch !== undefined) {
    return runObservability(parsed, { format, writeState, watch });
  }

  const [auth, agents] = await Promise.all([
    authStatus({
      profile: str(parsed, "profile"),
      local: bool(parsed, "local"),
    }),
    Promise.all(AGENTS.map((adapter) => agentStatus(adapter))),
  ]);

  if (bool(parsed, "json")) {
    json({ auth, agents });
    // Set the exit code and return rather than throw, so stdout stays pure
    // JSON. Only a reachable signed-out profile exits 1.
    if (!auth.signed_in && auth.reachable) process.exitCode = EXIT.ERROR;
    return;
  }

  if (!auth.reachable) {
    // Present-but-unreachable: exit 0 so scripts gating on this command do
    // not false-fail during an outage. The key is unverified, not absent.
    out(style.yellow("Gateway unreachable."));
    err(style.dim("Check your network and retry."));
    printAgents(agents);
    return;
  }

  if (!auth.signed_in) {
    out(style.yellow("Not signed in."));
    err(style.dim("Run `aiand login` first."));
    printAgents(agents);
    process.exitCode = EXIT.ERROR;
    return;
  }

  fields([
    ["email", auth.email ?? style.dim("unknown")],
    ["org", auth.org ?? style.dim("none")],
    ["profile", auth.profile],
    ["key", style.dim(auth.key ?? "unknown")],
    ["source", style.dim(auth.source ?? "unknown")],
    ["storage", style.dim(auth.storage ?? "unknown")],
  ]);

  printStatusline();
  printAgents(agents);
}

/**
 * The one-line statusline in the prose auth view (ticket #71 req 1): store
 * only, fail-open — a broken store prints nothing here, the dedicated
 * observability surface is where verdicts are loud.
 */
function printStatusline(): void {
  try {
    out("");
    out(computeStatusline().line);
  } catch {
    // the auth surface must not fail because the store did
  }
}

// ---------------------------------------------------------------------------
// Observability surface: --format / --write-state / --watch
// ---------------------------------------------------------------------------

type ObsOptions = {
  format?: string;
  writeState?: string;
  watch?: string;
};

async function runObservability(parsed: ReturnType<typeof parse>, opts: ObsOptions): Promise<void> {
  const format = opts.format;
  if (format !== undefined && format !== "line" && format !== "json") {
    throw new CliError(`Invalid --format value: ${format}.`, {
      hint: "Use --format line (the one-line statusline) or --format json (the snapshot superset).",
    });
  }

  const intervalMs = parseWatchInterval(opts.watch);
  const writeState = opts.writeState ?? null;

  if (bool(parsed, "sync-first")) await syncFirst(parsed);

  if (intervalMs === null) {
    const result = computeStatusline();
    await emit(result, format, writeState, bool(parsed, "print"));
    process.exitCode = result.exitCode;
    return;
  }

  await watchLoop(intervalMs, format, writeState, bool(parsed, "print"));
}

/** `--watch <seconds>`: default interval, floor 2s, invalid values are user errors. */
function parseWatchInterval(value: string | undefined): number | null {
  if (value === undefined) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new CliError(`Invalid --watch interval: ${value}.`, {
      hint: `Pass a number of seconds (>= ${WATCH_MIN_INTERVAL_MS / 1000}), e.g. --watch 5, or --watch alone for the ${WATCH_DEFAULT_INTERVAL_MS / 1000}s default.`,
    });
  }
  const ms = seconds * 1000;
  if (ms < WATCH_MIN_INTERVAL_MS) {
    throw new CliError(`--watch interval must be at least ${WATCH_MIN_INTERVAL_MS / 1000}s.`, {
      hint: `Faster refresh burns the gateway for no insight — use --watch ${WATCH_MIN_INTERVAL_MS / 1000} or slower.`,
    });
  }
  return ms;
}

/** The explicit --sync-first chain (the only network path status can take). */
async function syncFirst(parsed: ReturnType<typeof parse>): Promise<void> {
  try {
    const session = await openSession(resolveProfile(str(parsed, "profile")));
    const result = await syncStore(session);
    if (!result.ok) {
      err(style.yellow(`Warning: sync failed (${result.error}).`));
      err(style.dim("Serving local data; it may be stale."));
    } else if (result.error) {
      err(style.yellow(`Warning: sync stopped early (stuck cursor) — history may be incomplete: ${result.error}`)); // #85
    }
  } catch (error) {
    err(
      style.yellow(
        `Warning: sync failed (${error instanceof Error ? error.message : String(error)}).`,
      ),
    );
    err(style.dim("Serving local data; it may be stale."));
  }
}

/** Emit one run: snapshot write, line, or JSON — then the exit code stands. */
async function emit(
  result: StatuslineResult,
  format: string | undefined,
  writeState: string | null,
  print: boolean,
): Promise<void> {
  if (writeState !== null) {
    await writeFileAtomic(writeState, `${JSON.stringify(result.snapshot, null, 2)}\n`);
    err(style.dim(`Snapshot written to ${writeState} (schema v${SCHEMA_VERSION}).`));
  }
  if (writeState !== null && !print && format === undefined) return;
  if (format === "json") {
    json(superset(result));
    return;
  }
  out(result.line);
}

/** The --format json payload: the snapshot plus session context (additive). */
function superset(result: StatuslineResult): unknown {
  return {
    ...result.snapshot,
    session: result.extras.session,
    burn_span_hours: result.extras.burn_span_hours,
    store_rows: result.extras.store_rows,
  };
}

/**
 * --watch: render immediately, then refresh every interval (stale-while-
 * refresh — the render never waits on anything but the local store). On a
 * TTY the line is redrawn in place; piped, every tick is a new line. Ctrl-C
 * exits 0 cleanly. Returns the last computed result so the exit code lands.
 */
async function watchLoop(
  intervalMs: number,
  format: string | undefined,
  writeState: string | null,
  print: boolean,
): Promise<void> {
  process.once("SIGINT", () => {
    if (process.stdout.isTTY) process.stdout.write("\n");
    process.exit(EXIT.OK);
  });

  const isTty = process.stdout.isTTY === true;
  for (;;) {
    const result = computeStatusline({ staleThresholdMs: WATCH_STALE_FACTOR * intervalMs });
    if (writeState !== null) {
      await writeFileAtomic(writeState, `${JSON.stringify(result.snapshot, null, 2)}\n`);
      if (!isTty) err(style.dim(`Snapshot written to ${writeState} (schema v${SCHEMA_VERSION}).`));
    }
    if (format === "json") {
      json(superset(result));
    } else if (isTty && !(writeState !== null && print)) {
      // Redraw in place; --print opts out of the redraw for loggable output.
      process.stdout.write(`\r\x1b[2K${result.line}`);
    } else {
      out(result.line);
    }
    process.exitCode = result.exitCode;
    await sleep(intervalMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Do not hold the process open on top of the interval timer itself.
    timer.unref();
  });
}

function printAgents(agents: AgentStatusResult[]): void {
  if (agents.length === 0) return;
  out("");
  table(agents, [
    { header: "agent", value: (a) => a.agent },
    { header: "state", value: (a) => stateLabel(a.state) },
    { header: "model", value: (a) => a.model ?? "—" },
    {
      header: "binary",
      value: (a) => (a.installed ? (a.binary ?? "yes") : style.dim(`install: ${installCmd(a)}`)),
    },
  ]);
}

function installCmd(a: AgentStatusResult): string {
  const adapter = AGENTS.find((entry) => entry.id === a.agent);
  return adapter?.install.command ?? "";
}
