import { createInterface } from "node:readline/promises";
import { stdin } from "node:process";

import { bool, parse } from "../cli/args.js";
import { json, out, style } from "../cli/output.js";
import { CliError } from "../cli/errors.js";
import { isInteractive } from "../cli/prompt.js";
import { AGENTS, findAgent } from "../agents/registry.js";
import { agentOn, agentOff } from "../agents/engine.js";
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

async function wireOff(adapter: AgentAdapter): Promise<InitResult> {
  const result = await agentOff(adapter);
  return { agent: result.agent, state: result.state, note: result.note };
}

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    all: { type: "boolean", default: false },
    off: { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  const jsonOut = bool(parsed, "json");

  if (bool(parsed, "off")) return runOff(parsed.positionals, jsonOut);

  const named = parsed.positionals;
  if (bool(parsed, "all") || named.length > 0) {
    const targets = named.length > 0 ? resolveNames(named) : (await detectedInstalled()).map((a) => a.adapter);
    return runOnAll(targets, jsonOut);
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

async function runOnAll(targets: AgentAdapter[], jsonOut: boolean): Promise<void> {
  if (targets.length === 0) {
    if (jsonOut) return json({ agents: [], message: "No coding agents detected on this machine." });
    out("No coding agents detected on this machine.");
    out(style.dim("Install one, then re-run `aiand init --all`."));
    return;
  }

  const results: InitResult[] = [];
  for (const adapter of targets) {
    results.push(await wireOn(adapter));
  }
  if (jsonOut) return json({ agents: results });
  for (const result of results) {
    out(`  ${style.green(result.agent)}  ${style.bold(result.model ?? "on")}`);
  }
}

async function runOff(names: string[], jsonOut: boolean): Promise<void> {
  const targets = names.length > 0 ? resolveNames(names) : await registeredRouted();
  if (targets.length === 0 && names.length === 0) {
    if (jsonOut) return json({ agents: [] });
    out("No agents are currently wired to ai&.");
    return;
  }
  const results: InitResult[] = [];
  for (const adapter of targets) {
    results.push(await wireOff(adapter));
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

  const rl = createInterface({ input: stdin });
  try {
    out("Installed agents:");
    detected.forEach((row, index) => {
      out(`  ${index + 1}. ${row.adapter.label} (${row.adapter.id})`);
    });
    const answer = await rl.question("Which agents should use ai&? (e.g. 1,3 — or \"all\") ");
    const targets = pickTargets(answer, detected);
    for (const adapter of targets) {
      const result = await wireOn(adapter);
      out(`  ${style.green(result.agent)}  ${style.bold(result.model ?? "on")}`);
    }
  } finally {
    rl.close();
  }
}

/** Parse the interactive answer into selected detected adapters. */
function pickTargets(
  answer: string,
  detected: { adapter: AgentAdapter }[]
): AgentAdapter[] {
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === "" || trimmed === "all") return detected.map((d) => d.adapter);
  const parts = trimmed.split(/[,\s]+/).filter(Boolean);
  const picked: AgentAdapter[] = [];
  for (const part of parts) {
    if (/^\d+$/.test(part)) {
      const index = Number(part) - 1;
      const row = detected[index];
      if (row && !picked.includes(row.adapter)) picked.push(row.adapter);
      continue;
    }
    const adapter = findAgent(part);
    if (adapter && !picked.includes(adapter)) picked.push(adapter);
  }
  if (picked.length === 0) {
    throw new CliError("No agents selected.", {
      hint: "Answer with numbers (1,3), names, or \"all\".",
    });
  }
  return picked;
}