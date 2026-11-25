import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../api/client.js";
import { configDir, writeFileAtomic } from "../config.js";

type FinalizeState = {
  lastVersion: string;
};

function finalizePath(): string {
  return join(configDir(), "finalize.json");
}

function readState(): string | null {
  try {
    const parsed = JSON.parse(readFileSync(finalizePath(), "utf8")) as Partial<FinalizeState>;
    return typeof parsed.lastVersion === "string" ? parsed.lastVersion : null;
  } catch {
    return null;
  }
}

async function writeState(lastVersion: string): Promise<void> {
  const state: FinalizeState = { lastVersion };
  await writeFileAtomic(finalizePath(), `${JSON.stringify(state)}\n`);
}

/**
 * Run version-gated housekeeping when the installed version changed since the
 * last run: a "what's new" note linking to the current version's release notes.
 * Returns the collected notes; never throws.
 */
export async function finalizeOnVersionChange(): Promise<string[]> {
  const lastVersion = readState();
  if (lastVersion === VERSION) return [];
  // First install: record the current version without a "what's new" dump.
  if (lastVersion === null) {
    await writeState(VERSION).catch(() => {});
    return [];
  }

  await writeState(VERSION).catch(() => {});
  return [
    `What's new in v${VERSION}: https://github.com/aiandlabs/aiand-cli/releases/tag/v${VERSION}`,
  ];
}
