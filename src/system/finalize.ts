import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { configDir } from "../config.js";
import { writeFileAtomic } from "../io/atomic.js";
import { VERSION } from "../api/client.js";

export type Migration = {
  id: string;
  run: () => Promise<string | void>;
};

type FinalizeState = {
  lastVersion: string;
};

const DEFAULT_MIGRATIONS: Migration[] = [];

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
 * `## [` header), condensed to at most 4 non-empty lines. Returns [] when the
 * section is missing or unreadable.
 */
async function releaseNotesForVersion(): Promise<string[]> {
  try {
    const changelog = await readFile(packageRootPath("CHANGELOG.md"), "utf8");
    const lines = changelog.split("\n");
    const headerRe = new RegExp(`^## \\[${escapeRe(VERSION)}\\]`);
    const startIndex = lines.findIndex((line) => headerRe.test(line));
    if (startIndex < 0) return [];
    const block: string[] = [];
    for (
      let index = startIndex + 1;
      index < lines.length && !/^## \[/.test(lines[index] ?? "");
      index += 1
    ) {
      block.push((lines[index] ?? "").trim());
    }
    return block.filter(Boolean).slice(0, 4);
  } catch {
    return [];
  }
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Run version-gated housekeeping when the installed version changed since the
 * last run: best-effort forward migrations (each failure becomes a note, never
 * aborts), then a "what's new" note from the changelog for the current
 * version. Returns the collected notes; never throws.
 */
export async function finalizeOnVersionChange(opts: { migrations?: Migration[] } = {}): Promise<string[]> {
  const migrations = opts.migrations ?? DEFAULT_MIGRATIONS;
  const lastVersion = readState();
  if (lastVersion === VERSION) return [];

  const notes: string[] = [];

  for (const migration of migrations) {
    try {
      const note = await migration.run();
      if (note) notes.push(note);
    } catch {
      notes.push(`Warning: migration "${migration.id}" failed and was skipped.`);
    }
  }

  try {
    const whatsNew = await releaseNotesForVersion();
    notes.push(...whatsNew);
  } catch {
    // best-effort — a changelog hiccup never fails finalize
  }

  await writeState(VERSION).catch(() => {});
  return notes;
}