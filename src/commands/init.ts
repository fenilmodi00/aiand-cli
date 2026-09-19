import { bool, parse, str } from "../cli/args.js";
import { err, json, out, style } from "../cli/output.js";
import { CliError } from "../cli/errors.js";
import { isInteractive } from "../cli/prompt.js";
import { promptCheckbox } from "../cli/select.js";
import { AGENTS, findAgent } from "../agents/registry.js";
import { agentOn, agentOff } from "../agents/setup.js";
import type { AgentAdapter } from "../agents/types.js";

export const help = `${style.bold("aiand init")} -- detect agents and wire them to ai&

Usage
  aiand init                     detect installed agents and choose (interactive)
  aiand init --all               wire every detected (installed) agent to ai&
  aiand init <agent> [...]       wire specific agents
  aiand init --off               turn off every aiand-routed agent
  aiand init --off <agent> [...] turn off specific agents
  aiand init --json              machine-readable per-agent results
  aiand init --profile <name>    wire using a stored profile's key

Wiring an agent is the same as \`aiand <agent> on\`: it snapshots the current
config and points the agent at ai&. Pass --force when the app holds config
in memory (quit-guard escape). \`off\` subtracts aiand routing; it does not restore the snapshot.`;

type InitResult = {
  agent: string;
  state: "on" | "off";
  note?: string;
  model?: string;
  failed?: boolean;
};


function noteFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function isolateWire(
  agent: string,
  fallbackState: "on" | "off",
  work: () => Promise<InitResult>,
): Promise<InitResult> {
  try {
    return await work();
  } catch (error) {
    return { agent, state: fallbackState, note: noteFromError(error), failed: true };
  }
}

function failBatchIfNeeded(results: InitResult[]): void {
  if (results.some((result) => result.failed)) process.exitCode = 1;
}

function emitInitLine(result: InitResult, okLine: string): void {
  const line = result.note ? `  ${style.dim(result.agent)} — ${result.note}` : okLine;
  if (result.failed) err(line);
  else out(line);
}

async function wireOn(adapter: AgentAdapter, opts: { profile?: string; force?: boolean } = {}): Promise<InitResult> {
  const result = await agentOn(adapter, { profile: opts.profile, force: opts.force });
  return { agent: result.agent, state: result.state, model: result.model };
}

async function wireOff(adapter: AgentAdapter, force: boolean): Promise<InitResult> {
  const result = await agentOff(adapter, { force });
  return { agent: result.agent, state: result.state, note: result.note };
}

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    all: { type: "boolean", default: false },
    off: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  const jsonOut = bool(parsed, "json");
  const profile = str(parsed, "profile");

  if (bool(parsed, "off")) return runOff(parsed.positionals, jsonOut, bool(parsed, "force"));

  const named = parsed.positionals;
  const force = bool(parsed, "force");
  if (bool(parsed, "all") || named.length > 0) {
    if (named.length > 0) return runOnAll(resolveNames(named), jsonOut, [], profile, force);
    // Batch wiring skips launcher-only adapters: `on` is
    // refused for them by the engine, so including them would abort the
    // whole batch. They are reported, not wired.
    const detected = (await detectedInstalled()).map((row) => row.adapter);
    return runOnAll(
      detected.filter((adapter) => !adapter.launcherOnly),
      jsonOut,
      detected.filter((adapter) => adapter.launcherOnly),
      profile,
      force
    );
  }

  // Bare `aiand init` (interactive): pick from installed agents.
  return runInteractive(jsonOut, profile, force);
}

function resolveNames(names: string[]): AgentAdapter[] {
  const resolved: AgentAdapter[] = [];
  const unknown: string[] = [];
  for (const name of names) {
    const adapter = findAgent(name);
    if (!adapter) {
      unknown.push(name);
    } else if (!resolved.includes(adapter)) {
      resolved.push(adapter);
    }
  }
  if (unknown.length > 0) {
    throw new CliError(`Unknown agent(s): ${unknown.join(", ")}.`, {
      hint: `Valid agents: ${AGENTS.map((a) => a.id).join(", ")}`,
    });
  }
  return resolved;
}

/** Installed registered agents, in registration order. */
async function detectedInstalled(): Promise<{ adapter: AgentAdapter; installed: boolean }[]> {
  const rows = await Promise.all(
    AGENTS.map(async (adapter) => ({ adapter, installed: adapter.detect().installed }))
  );
  return rows.filter((row) => row.installed);
}

async function runOnAll(
  targets: AgentAdapter[],
  jsonOut: boolean,
  skipped: AgentAdapter[] = [],
  profile?: string,
  force?: boolean
): Promise<void> {
  if (targets.length === 0 && skipped.length === 0) {
    if (jsonOut) return json({ agents: [], message: "No coding agents detected on this machine." });
    out("No coding agents detected on this machine.");
    out(style.dim("Install one, then re-run `aiand init --all`."));
    return;
  }

  const results: InitResult[] = [];
  for (const adapter of targets) {
    results.push(await isolateWire(adapter.id, "off", () => wireOn(adapter, { profile, force })));
  }
  for (const adapter of skipped) {
    results.push({
      agent: adapter.id,
      state: "off",
      note: `launcher-only — use aiand run-agent ${adapter.id}`,
    });
  }
  failBatchIfNeeded(results);
  if (jsonOut) return json({ agents: results });
  for (const result of results) {
    emitInitLine(
      result,
      `  ${style.green(result.agent)}  ${style.bold(result.model ?? "on")}`,
    );
  }
}
async function runOff(names: string[], jsonOut: boolean, force: boolean): Promise<void> {
  const targets = names.length > 0 ? resolveNames(names) : await registeredRouted();
  if (targets.length === 0 && names.length === 0) {
    if (jsonOut) return json({ agents: [] });
    out("No agents are currently wired to ai&.");
    return;
  }
  const results: InitResult[] = [];
  for (const adapter of targets) {
    results.push(await isolateWire(adapter.id, "on", () => wireOff(adapter, force)));
  }
  failBatchIfNeeded(results);
  if (jsonOut) return json({ agents: results });
  for (const result of results) {
    emitInitLine(result, `  ${style.dim(result.agent)} — off`);
  }
}

/** Registered agents that currently probe as aiand-routed. Snapshots stay
 * for `restore --force`; leftover snapshots must not make `init --off` treat
 * an already-off agent as still wired. */
async function registeredRouted(): Promise<AgentAdapter[]> {
  const routed: AgentAdapter[] = [];
  for (const adapter of AGENTS) {
    const probe = await adapter.probe();
    if (probe.active) routed.push(adapter);
  }
  return routed;
}

async function runInteractive(jsonOut: boolean, profile?: string, force?: boolean): Promise<void> {
  const detected = await detectedInstalled();
  const missingNames = AGENTS.filter((a) => !detected.some((d) => d.adapter.id === a.id)).map(
    (a) => a.id
  );

  if (!isInteractive()) {
    // With nothing installed there is no list of names to pass, so the hint
    // becomes a single actionable sentence instead of `aiand init ` (empty).
    if (detected.length === 0) {
      const msg = "No coding agents detected on this machine. Install one and re-run aiand init.";
      if (jsonOut) return json({ agents: [], message: msg });
      throw new CliError("Non-interactive init needs explicit agents.", { hint: msg });
    }
    if (jsonOut) {
      return json({
        agents: [],
        message: "Non-interactive: pass --all or name agents.",
        detected: detected.map((d) => d.adapter.id),
      });
    }
    throw new CliError("Non-interactive init needs explicit agents.", {
      hint: `Pass --all or name agents: aiand init ${detected.map((d) => d.adapter.id).join(" ")}`,
    });
  }

  if (detected.length === 0) {
    out("No coding agents detected on this machine.");
    for (const id of missingNames) {
      const a = AGENTS.find((adapter) => adapter.id === id);
      if (a) out(style.dim(`  ${id}  Install it with: ${a.install.command}`));
    }
    return;
  }

  // Even when something is installed, list the rest so a user knows what
  // exists to install — never auto-installed, just told how.
  if (missingNames.length > 0) {
    out("");
    out("Not installed:");
    for (const id of missingNames) {
      const a = AGENTS.find((adapter) => adapter.id === id);
      if (a) out(style.dim(`  ${id}  Install it with: ${a.install.command}`));
    }
  }
  out("");

  const picked = await promptCheckbox({
    message: "Which agents should use ai&?",
    choices: detected.map((row) => ({
      value: row.adapter.id,
      label: `${row.adapter.label} (${row.adapter.id})`,
    })),
  });

  const targets = picked
    .map((id) => findAgent(id))
    .filter((adapter): adapter is AgentAdapter => Boolean(adapter));

  if (targets.length === 0) {
    throw new CliError("No agents selected.", {
      hint: "Use space to toggle agents, then Enter to confirm.",
    });
  }
  const results: InitResult[] = [];
  for (const adapter of targets) {
    const result = await isolateWire(adapter.id, "off", () => wireOn(adapter, { profile, force }));
    results.push(result);
    emitInitLine(
      result,
      `  ${style.green(result.agent)}  ${style.bold(result.model ?? "on")}`,
    );
  }
  failBatchIfNeeded(results);
}