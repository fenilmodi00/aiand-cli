import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { commandName } from "../config.js";
import { detectBinary } from "./detect.js";
import { AGENTS } from "./registry.js";
import type { AgentAdapter } from "./types.js";

// ASCII on purpose. The summary is printed by node from install.ps1, and
// Windows PowerShell 5.1's console is often not UTF-8, so a checkmark mojibakes.
const PRESENT = "+";

/**
 * The post-install summary. `onPath` is the PATH probe (`detectBinary` when
 * the installers run this file); it is called once per agent. Each hint is
 * that adapter's own `install.command` for this process, so the omp and
 * Hermes lines are the platform-specific ones the CLI already prints. A GUI
 * app (`configOnly`) has no PATH binary and is left out.
 */
export function formatAgentSummary(
  agents: readonly AgentAdapter[],
  onPath: (bin: string) => boolean,
): string {
  const detected: AgentAdapter[] = [];
  const missing: AgentAdapter[] = [];
  for (const agent of agents) {
    if (agent.configOnly === true) continue;
    if (onPath(agent.bin)) detected.push(agent);
    else missing.push(agent);
  }
  const cli = commandName();
  const hint = (agent: AgentAdapter): string =>
    `  ${agent.id}  Install it with: ${agent.install.command}`;
  if (detected.length === 0) {
    return [
      "No coding agents detected on this machine.",
      ...missing.map(hint),
      `Install one, then run '${cli} init'.`,
      "",
    ].join("\n");
  }
  const lines = ["Detected agents:", ...detected.map((agent) => `  ${PRESENT} ${agent.id}`)];
  if (missing.length > 0) lines.push("Not installed:", ...missing.map(hint));
  lines.push(`Next: run '${cli} init' to wire them to ai&.`, "");
  return lines.join("\n");
}

function runningAsScript(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (runningAsScript()) {
  process.stdout.write(formatAgentSummary(AGENTS, (bin) => detectBinary(bin).installed));
}
