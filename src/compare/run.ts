import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { getCatalog, resolveDefault, validateCatalogModel } from "../agents/catalog.js";
import { notInstalledError } from "../agents/launch.js";
import { findAgent } from "../agents/registry.js";
import type { AgentAdapter, SessionLaunchInput } from "../agents/types.js";
import { maskKey, recordAgentKey } from "../api/agent-keys.js";
import { openSession, type Session } from "../api/client.js";
import type { Model } from "../api/models.js";
import { findHarnessLayout, HARNESS_LAYOUTS } from "../benchmark/harness-layouts.js";
import { PINNED_MODEL, runRecordedBenchmark } from "../benchmark/recorded.js";
import { bool, int, list, parse, str } from "../cli/args.js";
import { CliError } from "../cli/errors.js";
import { err, heading, json, out, style } from "../cli/output.js";
import { resolveWindowsCommand } from "../cli/win-spawn.js";
import { configDir, type ResolvedProfile, resolveProfile } from "../config.js";
import { oneShotRetry } from "../model-efficiency.js";
import { listEnvelopes } from "../store/envelopes.js";
import { openStore, storePath, syncStore } from "../store/index.js";
import { type CompareRunRow, isRecordedRow, runsPath } from "./run-rows.js";
import { runVerify, taskPath, taskStatus } from "./tasks.js";

/**
 * `aiand compare run` (ticket #131, plan §2.2/§5 P2): drive each requested
 * harness headless on a task pack's instruction with one pinned model, verify
 * the workspace with the task's own script, and append one JSONL run row per
 * (harness, model, task, trial) under `<config dir>/compare-runs/<task>.jsonl`
 * (dry-run rows land in `<task>.recorded.jsonl`, kept apart from live rows).
 *
 * Success is the verify script's exit code — never the harness's own claim.
 * `completed` records whether the harness binary exited cleanly and is kept
 * separate from success. Cost and tokens are gateway-metered: requests.id IS
 * the gateway /logs row id, but a live response's X-Request-ID is not echoed
 * into those rows today, so the join is the per-run ledger the contracts
 * notes landed on: the run records its masked key + time window, syncs the
 * store, and matches /logs rows in that window. Missing usage ⇒ null, never
 * 0; the basis labels say which.
 */

const INSTRUCTION_FILE = "instruction.md";
const VERIFY_FILE = "verify.sh";

/** Headless one-shot recipe per adapter (lane-b contracts §3). Absent = not drivable. */
const HEADLESS_PROMPT: Record<string, (instruction: string) => string[]> = {
  claude: (instruction) => ["-p", instruction],
  codex: (instruction) => ["exec", instruction],
  opencode: (instruction) => ["run", instruction],
};

const DEFAULT_HARNESSES = ["claude", "codex", "opencode"];

/** Gateway /logs rows are matched to the run by masked key + time window. */
const JOIN_TOLERANCE_MS = 2 * 60_000;
/** Hard cap on one harness invocation; a kill lands as agent_timeout. */
const DEFAULT_AGENT_TIMEOUT_S = 900;
/** Hard cap on one verify invocation; a kill lands as verify_timeout. */
const VERIFY_TIMEOUT_MS = 120_000;

/** Gateway /logs phrasing for an over-long prompt, across dialects. */
const CONTEXT_RE =
  /context (?:window|length|limit)|exceeds the context|prompt is too long|token limit/i;

const help = `${style.bold("aiand compare run")} -- replay a task pack across harnesses

Usage
  aiand compare run --task <id> [--harness a,b] [--model m] [--trials 3]
                    [--timeout <seconds>] [--dry-run] [--force]

Options
  --task <id>         task pack to run (required)
  --harness a,b       adapters to drive (default: ${DEFAULT_HARNESSES.join(", ")});
                      with --dry-run these are bench layout ids instead
  --model <id>        one model pinned across every harness (default: the
                      profile's model, else the catalog's pick)
  --trials <n>        runs per harness (default 3)
  --timeout <seconds> per-run harness cap (default ${DEFAULT_AGENT_TIMEOUT_S})
  --dry-run           replay the recorded simulated lane instead of live
                      drivers — zero gateway spend; rows carry the
                      "recorded" basis labels, the pinned bench model, and
                      land in <task>.recorded.jsonl (kept apart from live
                      rows and never ranked with them)
  --force             run even when the task is not validated
  --json              machine-readable output

Every run gets a fresh copy of the task's workspace; the verify script (in
the task pack, outside the workspace) decides success by its exit code, and
its hash is checked before/after each run so an agent that edits the grader
is flagged integrity_violation instead of scored. Cost and tokens join the
gateway's /logs by masked key + time window; missing usage stays null.`;

/**
 * Append one run row to its lane's JSONL: recorded (dry-run) rows go to
 * `<task>.recorded.jsonl`, live rows to `<task>.jsonl` — the recorded
 * simulated lane never mixes into the observed run rows that `compare
 * table` and `compare cohorts` aggregate.
 */
function appendRow(task: string, row: CompareRunRow): void {
  mkdirSync(runsPath(), { recursive: true, mode: 0o700 });
  const file = isRecordedRow(row) ? `${task}.recorded.jsonl` : `${task}.jsonl`;
  appendFileSync(join(runsPath(), file), `${JSON.stringify(row)}\n`);
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Parse a gateway created_at (ISO or wire `… …+00`) to an instant. */
function instant(value: string): number | null {
  const normalized = value.includes(" ") ? value.replace(" ", "T").replace(/\+00$/, "Z") : value;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

/** Best-effort `bin --version`, first line; null when it cannot be probed. */
function harnessVersion(bin: string): string | null {
  const proc = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 10_000 });
  const line = `${proc.stdout ?? ""}`.split("\n")[0]?.trim();
  return proc.status === 0 && line ? line : null;
}

/** Metered usage joined from the gateway, or why none applies. */
type GatewayUsage = {
  tokensIn: number | null;
  tokensCached: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  requestIds: string[];
};

type StoreRow = {
  id: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  cost_value: number | null;
  created_at: string;
};

/** Sum a column over matched rows; all-null stays null, never 0. */
function sumColumn(rows: StoreRow[], pick: (row: StoreRow) => number | null): number | null {
  const values = rows.map(pick);
  if (rows.length === 0 || values.every((v) => v === null)) return null;
  return values.reduce<number>((acc, v) => acc + (v ?? 0), 0);
}

/**
 * Sync the store, then match this run's gateway traffic by masked key +
 * time window. A sync that failed at the network/auth layer is infra (the
 * agent could not reach its model), never a solve-rate datum; a store that
 * merely cannot open degrades to null usage.
 */
async function joinGatewayUsage(
  session: Session,
  maskedKey: string,
  startMs: number,
  endMs: number,
): Promise<{ infra: true } | ({ infra: false } & GatewayUsage)> {
  const sync = await syncStore(session);
  if (!sync.ok && (sync.code === "network" || sync.code === "auth")) return { infra: true };

  const opened = openStore(storePath());
  if (!opened.ok) {
    return {
      infra: false,
      tokensIn: null,
      tokensCached: null,
      tokensOut: null,
      costUsd: null,
      requestIds: [],
    };
  }
  try {
    const rows = opened.db
      .prepare(
        "SELECT id, input_tokens, output_tokens, cached_tokens, cost_value, created_at " +
          "FROM requests WHERE api_key = ?",
      )
      .all(maskedKey) as StoreRow[];
    const matched = rows.filter((row) => {
      const at = instant(row.created_at);
      return at !== null && at >= startMs - JOIN_TOLERANCE_MS && at <= endMs + JOIN_TOLERANCE_MS;
    });
    return {
      infra: false,
      tokensIn: sumColumn(matched, (r) => r.input_tokens),
      tokensCached: sumColumn(matched, (r) => r.cached_tokens),
      tokensOut: sumColumn(matched, (r) => r.output_tokens),
      costUsd: sumColumn(matched, (r) => r.cost_value),
      requestIds: matched.map((r) => r.id).sort(),
    };
  } finally {
    try {
      opened.db.close();
    } catch {
      // already closed
    }
  }
}

/** The adapter's ephemeral launch wiring, resolved once per run batch. */
async function resolveLaunch(
  adapter: AgentAdapter,
  input: SessionLaunchInput,
): Promise<{ env: Record<string, string>; args: string[]; cleanup?: () => Promise<void> }> {
  if (!adapter.sessionLaunch) {
    throw new CliError(`${adapter.label} does not support session launches.`, {
      hint: `Run \`aiand ${adapter.id} on\` for permanent wiring.`,
    });
  }
  const launch = await adapter.sessionLaunch(input);
  return { env: launch.env, args: launch.args ?? [], cleanup: launch.cleanup };
}

type SpawnOutcome = {
  status: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  spawnError: string | null;
};

/** One headless harness invocation, output captured, hard-capped. */
function spawnHeadless(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
): SpawnOutcome {
  let command = bin;
  let finalArgs = args;
  if (process.platform === "win32") {
    const resolved = resolveWindowsCommand(bin, args, env);
    if (!resolved) {
      return { status: null, signal: null, output: "", spawnError: `spawn ${bin} ENOENT` };
    }
    command = resolved.command;
    finalArgs = resolved.args;
  }
  const proc = spawnSync(command, finalArgs, {
    cwd,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    // cmd.exe .cmd shims: the escaped line only parses verbatim (launch.ts).
    ...(process.platform === "win32" && command !== bin ? { windowsVerbatimArguments: true } : {}),
  });
  return {
    status: proc.status,
    signal: proc.signal,
    output: `${proc.stdout ?? ""}${proc.stderr ?? ""}`,
    spawnError: proc.error ? proc.error.message : null,
  };
}

type LiveOptions = {
  model: string;
  trials: number;
  timeoutMs: number;
  session: Session;
  catalog: Model[] | null;
  profile: ResolvedProfile;
};

function parseHarnessIds(raw: string[]): string[] {
  return raw
    .flatMap((value) => value.split(","))
    .map((id) => id.trim())
    .filter(Boolean);
}

function freshWorkspace(taskDir: string): string {
  const runDir = mkdtempSync(join(tmpdir(), `aiand-compare-${basename(taskDir)}-`));
  cpSync(join(taskDir, "workspace"), runDir, { recursive: true });
  cpSync(join(taskDir, INSTRUCTION_FILE), join(runDir, INSTRUCTION_FILE));
  return runDir;
}

/** The base row before grading: identity + metering fields at their nulls. */
function baseRow(
  harness: string,
  model: string,
  task: string,
  trial: number,
  version: string | null,
): CompareRunRow {
  return {
    run_id: `${harness}:${model}:${task}:trial${trial}`,
    ts: new Date().toISOString(),
    harness,
    harness_version: version,
    model,
    task,
    success: null,
    score: null,
    failure_mode: null,
    completed: false,
    wall_ms: 0,
    turns: null,
    retries: null,
    tokens_in: null,
    tokens_cached: null,
    tokens_out: null,
    cost_usd: null,
    token_basis: "none",
    cost_basis: "none",
    request_ids: [],
    verify_exit: null,
  };
}

/**
 * Turn count + retry count for one run, from the envelope rows the run's
 * agent recorded (masked key + time window, the same join as the cost
 * ledger). Opt-in capture: rows absent → both null, never 0.
 */
function envelopeWalk(
  token: string,
  startMs: number,
  endMs: number,
): { count: number | null; retries: number | null } {
  const masked = maskKey(token);
  const since = new Date(startMs - JOIN_TOLERANCE_MS).toISOString();
  const until = new Date(endMs + JOIN_TOLERANCE_MS).toISOString();
  const rows = listEnvelopes({ since, until }).filter((row) => row.api_key === masked);
  if (rows.length === 0) return { count: null, retries: null };
  const turns = rows.map((row) => ({
    tools: row.envelope?.tools ?? [],
    editTargets: row.envelope?.edit_targets ?? [],
    toolOutcomes: row.envelope?.toolOutcomes ?? null,
    terminal: row.envelope?.terminal ?? null,
  }));
  return { count: turns.length, retries: oneShotRetry(turns).stats.value.retries };
}

async function runLive(task: string, id: string, options: LiveOptions): Promise<CompareRunRow[]> {
  const adapter = findAgent(id);
  if (!adapter) {
    throw new CliError(`Unknown harness "${id}".`, {
      hint: `Known harnesses: ${DEFAULT_HARNESSES.join(", ")}.`,
    });
  }
  const prompt = HEADLESS_PROMPT[adapter.id];
  if (!prompt) {
    throw new CliError(`${adapter.label} has no headless driver yet.`, {
      hint: `compare run drives: ${DEFAULT_HARNESSES.join(", ")}.`,
    });
  }

  const session = options.session;
  const taskDir = taskPath(task);
  const instruction = readFileSync(join(taskDir, INSTRUCTION_FILE), "utf8");
  const verifyScript = join(taskDir, VERIFY_FILE);
  const version = harnessVersion(adapter.bin);
  const maskedKey = maskKey(session.token);
  const rows: CompareRunRow[] = [];

  // Best-effort attribution, same as agentSession: without it the sync sweep
  // self-records this key as aiand-cli instead of the agent.
  await recordAgentKey(adapter.id, session.token).catch(() => {});

  const launch = await resolveLaunch(adapter, {
    apiKey: session.token,
    model: options.model,
    profileModel: options.profile.model,
    profileName: options.profile.name,
    catalog: options.catalog ?? [],
    baseUrl: options.profile.apiUrl,
  });

  for (let trial = 1; trial <= options.trials; trial++) {
    const runDir = freshWorkspace(taskDir);
    const row = baseRow(adapter.id, options.model, task, trial, version);
    try {
      // Child env = inherited, scrubbed like agentSession: the adapter's own
      // injection carries the key; a leaked AIAND_API_KEY would hand it to
      // every process the agent spawns.
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.AIAND_API_KEY;
      for (const key of adapter.shadowEnv ?? []) delete env[key];
      Object.assign(env, launch.env);

      const hashBefore = sha256File(verifyScript);
      const startMs = Date.now();
      // cmd.exe batch shims cannot carry newline args; flatten to one line.
      const spawned = spawnHeadless(
        adapter.bin,
        [...launch.args, ...prompt(instruction.replace(/\s*\r?\n\s*/g, " "))],
        env,
        runDir,
        options.timeoutMs,
      );
      row.wall_ms = Date.now() - startMs;
      row.completed =
        spawned.spawnError === null && spawned.signal === null && spawned.status === 0;

      const usage = await joinGatewayUsage(session, maskedKey, startMs, Date.now());

      if (spawned.spawnError !== null || usage.infra) {
        // Spawn failure or unreachable gateway: infra, reported separately,
        // never folded into the solve rate.
        row.failure_mode = "infra";
      } else if (spawned.signal !== null) {
        row.failure_mode = "agent_timeout";
      } else if (sha256File(verifyScript) !== hashBefore) {
        // The agent edited its own grader: the verify result would be
        // untrustworthy, so it is not taken.
        row.failure_mode = "integrity_violation";
      } else if (spawned.output.trim() === "") {
        // The harness exited cleanly but produced nothing to grade: its
        // output could not be parsed into a run.
        row.failure_mode = "parse_error";
      } else {
        const verify = runVerify(taskDir, runDir, VERIFY_TIMEOUT_MS);
        row.verify_exit = verify.exitCode;
        if (verify.signal !== null) {
          row.failure_mode = "verify_timeout";
        } else {
          row.success = verify.ok;
          row.score = verify.ok ? verify.score : null;
          if (!verify.ok && CONTEXT_RE.test(spawned.output)) {
            row.failure_mode = "context_exceeded";
          }
        }
      }

      // Behavioral columns from this run's own envelope walk (same masked
      // key + time window as the cost join). Read-only: capture stays
      // opt-in, and rows without envelopes leave turns/retries null.
      if (!usage.infra) {
        const turns = envelopeWalk(session.token, startMs, Date.now());
        row.turns = turns.count;
        row.retries = turns.retries;
      }

      if (!usage.infra) {
        row.request_ids = usage.requestIds;
        row.tokens_in = usage.tokensIn;
        row.tokens_cached = usage.tokensCached;
        row.tokens_out = usage.tokensOut;
        row.cost_usd = usage.costUsd;
        const metered = usage.requestIds.length > 0;
        row.token_basis = metered ? "gateway" : "none";
        row.cost_basis = metered ? "gateway" : "none";
      }

      appendRow(task, row);
    } finally {
      rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      await launch.cleanup?.().catch(() => {});
    }
    rows.push(row);
  }
  return rows;
}

/** The recorded simulated lane: zero gateway spend, pinned prices. */
async function runDry(task: string, layoutIds: string[], trials: number): Promise<CompareRunRow[]> {
  const layouts = layoutIds.map((id) => {
    const layout = findHarnessLayout(id);
    if (!layout) {
      throw new CliError(`Unknown bench layout "${id}".`, {
        hint: `With --dry-run, --harness names bench layouts: ${HARNESS_LAYOUTS.map((l) => l.id).join(", ")}.`,
      });
    }
    return layout;
  });

  const report = await runRecordedBenchmark({
    scenarios: ["multi-turn-refactor"],
    layouts: layouts.map((layout) => layout.id),
  });
  const byLayout = new Map(report.rows.map((row) => [row.layout, row]));

  const taskDir = taskPath(task);
  const rows: CompareRunRow[] = [];
  for (const layout of layouts) {
    const bench = byLayout.get(layout.id);
    if (!bench) continue;
    // The simulated lane cannot solve your task: it replays a fixed bench
    // scenario. Verify runs on an untouched workspace copy — the same
    // fail-before control `compare validate` applies, so a dry-run row
    // honestly reports success=false (or the task's untouched score).
    const runDir = freshWorkspace(taskDir);
    const verify = runVerify(taskDir, runDir, VERIFY_TIMEOUT_MS);
    rmSync(runDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    for (let trial = 1; trial <= trials; trial++) {
      rows.push({
        ...baseRow(layout.id, PINNED_MODEL, task, trial, null),
        success: verify.ok,
        score: verify.ok ? verify.score : null,
        completed: true,
        turns: bench.requests,
        retries: bench.retries,
        tokens_in: bench.inputTokens,
        tokens_cached: bench.cachedTokens,
        tokens_out: bench.outputTokens,
        cost_usd: bench.effective_cost_units,
        token_basis: "recorded",
        cost_basis: "recorded",
        verify_exit: verify.exitCode,
      });
    }
  }
  for (const row of rows) appendRow(task, row);
  return rows;
}

function printRowLine(row: CompareRunRow): void {
  const status =
    row.failure_mode === "infra"
      ? style.yellow("infra")
      : row.success === true
        ? style.green("✓ solved")
        : style.red(`✗ ${row.failure_mode ?? "verify failed"}`);
  const cost = row.cost_usd === null ? "cost —" : `$${row.cost_usd.toFixed(4)} (${row.cost_basis})`;
  out(
    `  ${row.harness.padEnd(12)} ${row.run_id.split(":").at(-1)?.padEnd(7)} ${status}  ` +
      `wall ${(row.wall_ms / 1000).toFixed(1)}s  ${cost}`,
  );
}

function reportResults(
  task: string,
  model: string,
  dryRun: boolean,
  rows: CompareRunRow[],
  wantsJson: boolean,
): boolean {
  if (wantsJson) {
    json({ task, model, dryRun, rows });
  } else {
    heading(`compare run · ${task} · ${model}${dryRun ? " · dry-run" : ""}`);
    for (const row of rows) printRowLine(row);
    const graded = rows.filter((row) => row.failure_mode !== "infra");
    const solved = graded.filter((row) => row.success === true).length;
    const totalCost = rows.reduce((acc, row) => acc + (row.cost_usd ?? 0), 0);
    out(
      `${solved}/${graded.length} solved` +
        (rows.length > graded.length ? ` · ${rows.length - graded.length} infra (excluded)` : "") +
        ` · total $${totalCost.toFixed(4)}` +
        style.dim(
          ` · rows: ${join(runsPath(), dryRun ? `${task}.recorded.jsonl` : `${task}.jsonl`)}`,
        ),
    );
  }
  // Infra failures are reported (never folded into the solve rate) but still
  // fail the command so scripts notice.
  return rows.some((row) => row.failure_mode === "infra");
}

export async function runCompareRun(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    task: { type: "string" },
    harness: { type: "string", multiple: true },
    model: { type: "string" },
    trials: { type: "string" },
    timeout: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  const task = str(parsed, "task");
  if (!task) {
    throw new CliError("--task is required.", { hint: "Usage: aiand compare run --task <id>" });
  }
  const taskDir = taskPath(task);
  if (!existsSync(taskDir)) {
    throw new CliError(`Task "${task}" does not exist.`, {
      hint: `Known tasks live under ${join(configDir(), "tasks")}; scaffold one with \`aiand compare add ${task} --verify "<cmd>"\`.`,
    });
  }

  const dryRun = bool(parsed, "dry-run");
  if (!bool(parsed, "force")) {
    const { status } = taskStatus(task);
    if (status !== "validated") {
      throw new CliError(`Task "${task}" is not validated (status: ${status}).`, {
        hint: "Run `aiand compare validate --golden <dir>` first, or pass --force to run anyway.",
      });
    }
  }

  const trials = int(parsed, "trials") ?? 3;
  if (trials < 1) throw new CliError("--trials must be at least 1.");
  const timeoutMs = (int(parsed, "timeout") ?? DEFAULT_AGENT_TIMEOUT_S) * 1000;
  const harnessIds = parseHarnessIds(list(parsed, "harness"));

  if (dryRun) {
    const layoutIds = harnessIds.length > 0 ? harnessIds : HARNESS_LAYOUTS.map((l) => l.id);
    const rows = await runDry(task, layoutIds, trials);
    reportResults(task, PINNED_MODEL, true, rows, bool(parsed, "json"));
    return;
  }

  // Capability checks BEFORE any session/catalog work: a harness that
  // cannot be driven fails loudly without touching the network.
  const ids = harnessIds.length > 0 ? harnessIds : DEFAULT_HARNESSES;
  for (const id of ids) {
    const adapter = findAgent(id);
    if (!adapter) {
      throw new CliError(`Unknown harness "${id}".`, {
        hint: `Known harnesses: ${DEFAULT_HARNESSES.join(", ")}.`,
      });
    }
    // copilot-app is a GUI app: refuse loudly, never silently skip.
    if (adapter.configOnly) {
      throw new CliError(
        `${adapter.label} is a desktop app; aiand wires it but cannot drive it headless.`,
        { hint: `Use one of: ${DEFAULT_HARNESSES.join(", ")}.` },
      );
    }
    if (!HEADLESS_PROMPT[adapter.id]) {
      throw new CliError(`${adapter.label} has no headless driver yet.`, {
        hint: `compare run drives: ${DEFAULT_HARNESSES.join(", ")}.`,
      });
    }
    if (!adapter.detect().installed) throw notInstalledError(adapter);
  }

  const profile = resolveProfile(str(parsed, "profile"));
  const session = await openSession(profile);
  // A catalog failure is not fatal when --model pins the id explicitly.
  const catalog = await getCatalog(profile.apiUrl).catch(() => null);
  let model = str(parsed, "model") ?? profile.model;
  if (!model) {
    if (!catalog) {
      throw new CliError("--model is required: the model catalog is unreachable.", {
        hint: "Pass --model <id> to pin the model explicitly.",
      });
    }
    model = resolveDefault(catalog, profile.model);
  }
  if (catalog) validateCatalogModel(catalog, model);

  // Cost estimate BEFORE any spend, from the price catalog when available.
  const price = catalog?.find((entry) => entry.id === model);
  if (price) {
    err(
      style.dim(
        `metered: ${model} — input $${price.input_per_1m}/1M · cached $${price.cached_input_per_1m ?? "0"}/1M · ` +
          `output $${price.output_per_1m}/1M · ${trials} trial(s)/harness; actual cost joined from /logs per run`,
      ),
    );
  } else {
    err(style.yellow(`no catalog prices for ${model} — cost columns may read null`));
  }

  const selectedIds = harnessIds.length > 0 ? harnessIds : DEFAULT_HARNESSES;
  const rows: CompareRunRow[] = [];
  for (const id of selectedIds) {
    rows.push(
      ...(await runLive(task, id, { model, trials, timeoutMs, session, catalog, profile })),
    );
  }
  if (reportResults(task, model, false, rows, bool(parsed, "json"))) {
    process.exitCode = 1;
  }
}
