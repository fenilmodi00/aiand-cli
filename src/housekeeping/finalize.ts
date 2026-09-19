import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { configDir, writeFileAtomic } from "../config.js";
import { VERSION } from "../api/client.js";


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
  await writeFileAtomic(finalizePath(), JSON.stringify({ lastVersion } as FinalizeState) + "\n");
}

/**
 * Resolve a file path relative to the package root exactly the way
 * src/api/client.ts resolves package.json for VERSION.
 */
function packageRootPath(name: string): string {
  const require = createRequire(import.meta.url);
  const packagePath = require.resolve("../../package.json");
  return join(dirname(packagePath), name);
}

/**
 * Read a "what's new" block from CHANGELOG.md for {@link VERSION}: the
 * `## [<VERSION>]` section (its header line through the line before the next
 * `## [` header), condensed to at most 4 `- ` bullets. Returns `null` when the
 * section is missing or unreadable so a first install can stay silent.
 */
async function releaseNotesForVersion(): Promise<string[] | null> {
  try {
    const changelog = await readFile(packageRootPath("CHANGELOG.md"), "utf8");
    const lines = changelog.split("\n");
    const headerRe = new RegExp(`^## \\[${escapeRe(VERSION)}\\]`);
    const startIndex = lines.findIndex((line) => headerRe.test(line));
    if (startIndex < 0) return null;
    const bullets: string[] = [];
    for (
      let index = startIndex + 1;
      index < lines.length && !/^## \[/.test(lines[index] ?? "");
      index += 1
    ) {
      const line = (lines[index] ?? "").trim();
      if (line.startsWith("- ")) bullets.push(line);
    }
    return bullets.slice(0, 4);
  } catch {
    return null;
  }
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Run version-gated housekeeping when the installed version changed since the
 * last run: a "what's new" note from the changelog for the current version.
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

  const whatsNew = await releaseNotesForVersion();
  if (whatsNew === null) {
    // Missing/unreadable changelog: keep the one-shot for a later run.
    return [];
  }

  await writeState(VERSION).catch(() => {});
  return whatsNew;
}