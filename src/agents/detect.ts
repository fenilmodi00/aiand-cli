import { spawnSync } from "node:child_process";

import type { DetectResult } from "./types.js";

/**
 * Probe whether a coding-agent binary is on PATH. `which`/`where` exit 0 only
 * when the binary resolves, and the first output line is the resolved path.
 */
export function detectBinary(bin: string): DetectResult {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [bin], {
    encoding: "utf8",
  });
  if (probe.error || probe.status !== 0) return { installed: false, path: null };
  const firstLine = probe.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return { installed: true, path: firstLine ?? null };
}

/**
 * Per-agent install commands and docs, shown when `detectBinary` misses.
 * Keyed by agent id; Wave 2+ adapters read their entry from here.
 */
export const INSTALL_HINTS: Record<string, { command: string; url: string }> = {
  claude: {
    command: "npm install -g @anthropic-ai/claude-code",
    url: "https://docs.anthropic.com/en/docs/claude-code/setup",
  },
  codex: {
    command: "npm install -g @openai/codex",
    url: "https://github.com/openai/codex",
  },
  cursor: {
    command: "Download Cursor from cursor.com/downloads",
    url: "https://cursor.com/downloads",
  },
  opencode: {
    command: "npm install -g opencode-ai@latest",
    url: "https://opencode.ai",
  },
  pi: {
    command: "npm install -g @earendil-works/pi-coding-agent",
    url: "https://pi.dev/docs/latest/quickstart",
  },
  deepseek: {
    command: "npm install -g @deepseek-ai/dsh",
    url: "https://github.com/deepseek-ai/deepseek-harness",
  },
  prime: {
    command: "curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh",
    url: "https://github.com/PrimeIntellect-ai/prime-agent",
  },
  hermes: {
    command: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
    url: "https://hermes-agent.nousresearch.com/docs/",
  },
  grok: {
    command: "curl -fsSL https://x.ai/cli/install.sh | bash",
    url: "https://github.com/xai-org/grok-build",
  },
};
