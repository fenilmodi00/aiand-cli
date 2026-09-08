import { bool, parse } from "../cli/args.js";
import { json, out, style } from "../cli/output.js";
import { CliError } from "../cli/errors.js";
import { isInteractive } from "../cli/prompt.js";
import { promptCheckbox } from "../cli/select.js";
import { AGENTS, findAgent } from "../agents/registry.js";
import { agentOn, agentOff } from "../agents/setup.js";
import { hasSnapshot as hasSnapshotFor } from "../agents/snapshot.js";
import type { AgentAdapter } from "../agents/types.js";

export const help = `${style.bold("aiand init")} -- detect agents and wire them to ai&

Usage
  aiand init                     detect installed agents and choose (interactive)
  aiand init --all               wire every detected (installed) agent to ai&
  aiand init <agent> [...]       wire specific agents
  aiand init --off               turn off every aiand-routed agent
  aiand init --off <agent> [...] turn off specific agents
  aiand init --json              machine-readable per-agent results

Wiring an agent is the same as \`aiand <agent> on\`: it backs up the current
config, refuses configs another tool manages (pass --force to overwrite),
and points the agent at ai&.`;

type InitResult = { agent: string; state: "on" | "off"; note?: string; model?: string };

async function wireOn(adapter: AgentAdapter): Promise<InitResult> {
  const result = await agentOn(adapter, {});
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

  if (bool(parsed, "off")) return runOff(parsed.positionals, jsonOut, bool(parsed, "force"));

  const named = parsed.positionals;
  if (bool(parsed, "all") || named.length > 0) {
    if (named.length > 0) return runOnAll(resolveNames(named), jsonOut);
    // Batch wiring skips launcher-only agents (hermes, grok): `on` is
    // refused for them by the engine, so including them would abort the
    // whole batch. They are reported, not wired.
    const detected = (await detectedInstalled()).map((row) => row.adapter);
    return runOnAll(
      detected.filter((adapter) => !adapter.launcherOnly),
      jsonOut,
      detected.filter((adapter) => adapter.launcherOnly)
    );
  }

  // Bare `aiand init` (interactive): pick from installed agents.
  return runInteractive(jsonOut);
}

function resolveNames(names: string[]): AgentAdapter[] {
  const resolved: AgentAdapter[] = [];
  const unknown: string[] = [];
  for (const name of names) {
    const adapter = findAgent(name);
    if (adapter && !resolved.includes(adapter)) resolved.push(adapter);
    else unknown.push(name);
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
  skipped: AgentAdapter[] = []
): Promise<void> {
  if (targets.length === 0 && skipped.length === 0) {
    if (jsonOut) return json({ agents: [], message: "No coding agents detected on this machine." });
    out("No coding agents detected on this machine.");
    out(style.dim("Install one, then re-run `aiand init --all`."));
    return;
  }

  const results: InitResult[] = [];
  for (const adapter of targets) {
    results.push(await wireOn(adapter));
  }
  for (const adapter of skipped) {
    results.push({
      agent: adapter.id,
      state: "off",
      note: `launcher-only — use aiand run-agent ${adapter.id}`,
    });
  }
  if (jsonOut) return json({ agents: results });
  for (const result of results) {
    out(
      result.note
        ? `  ${style.dim(result.agent)} — ${result.note}`
        : `  ${style.green(result.agent)}  ${style.bold(result.model ?? "on")}`
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
    results.push(await wireOff(adapter, force));
  }
  if (jsonOut) return json({ agents: results });
  for (const result of results) {
    out(result.note ? `  ${style.dim(result.agent)} — ${result.note}` : `  ${style.dim(result.agent)} — off`);
  }
}

/** Registered agents that probe active or already have a snapshot. */
async function registeredRouted(): Promise<AgentAdapter[]> {
  const routed: AgentAdapter[] = [];
  for (const adapter of AGENTS) {
    const probe = await adapter.probe();
    if (probe.active || (await hasSnapshotFor(adapter.id))) routed.push(adapter);
  }
  return routed;
}

async function runInteractive(jsonOut: boolean): Promise<void> {
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
  for (const adapter of targets) {
    const result = await wireOn(adapter);
    out(`  ${style.green(result.agent)}  ${style.bold(result.model ?? "on")}`);
  }
}