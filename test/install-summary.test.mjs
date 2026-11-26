// The installers print this summary after a successful install. The hint text
// is the adapter's install.command, not a second copy in the shell scripts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { formatAgentSummary } from "../dist/agents/install-summary.js";
import { AGENTS } from "../dist/agents/registry.js";

const pathAgents = AGENTS.filter((agent) => agent.configOnly !== true);
const hintLine = (agent) => `  ${agent.id}  Install it with: ${agent.install.command}`;

test("summary with nothing on PATH names every PATH agent's install command", () => {
  const text = formatAgentSummary(AGENTS, () => false);
  assert.match(text, /^No coding agents detected on this machine\.\n/);
  assert.match(text, /Install one, then run 'aiand init'\.\n$/);
  assert.equal(text.includes("Detected agents:"), false);
  for (const agent of pathAgents) {
    assert.ok(text.includes(hintLine(agent)), agent.id);
  }
  for (const agent of AGENTS) {
    if (!agent.configOnly) continue;
    assert.equal(text.includes(`  ${agent.id}  Install it with:`), false, agent.id);
  }
});

test("summary marks agents on PATH and prints hints only for the rest", () => {
  const present = new Set(["opencode", "jouzu"]);
  const text = formatAgentSummary(AGENTS, (bin) => present.has(bin));
  assert.match(text, /^Detected agents:\n/);
  assert.ok(text.includes("  + opencode\n"));
  assert.ok(text.includes("  + jouzu\n"));
  assert.match(text, /Next: run 'aiand init' to wire them to ai&\.\n$/);
  for (const agent of pathAgents) {
    if (present.has(agent.bin)) assert.equal(text.includes(hintLine(agent)), false, agent.id);
    else assert.ok(text.includes(hintLine(agent)), agent.id);
  }
});

test("running the summary script prints a summary and exits 0", () => {
  const script = fileURLToPath(new URL("../dist/agents/install-summary.js", import.meta.url));
  const run = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", script], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /aiand init/);
  assert.match(run.stdout, /Detected agents:|No coding agents detected/);
});

test("summary with every PATH agent present prints no install hints", () => {
  const bins = new Set(pathAgents.map((agent) => agent.bin));
  const text = formatAgentSummary(AGENTS, (bin) => bins.has(bin));
  assert.match(text, /^Detected agents:\n/);
  assert.equal(text.includes("Not installed:"), false);
  assert.equal(text.includes("Install it with:"), false);
  for (const agent of pathAgents) assert.ok(text.includes(`  + ${agent.id}\n`), agent.id);
  assert.match(text, /Next: run 'aiand init' to wire them to ai&\.\n$/);
});

test("the Copilot desktop app stays out of the summary when the copilot CLI is on PATH", () => {
  const text = formatAgentSummary(AGENTS, (bin) => bin === "copilot");
  assert.equal(text.includes("copilot-app"), false);
  assert.ok(text.includes("  + copilot\n"));
  assert.equal(text.includes("  copilot  Install it with:"), false);
});
