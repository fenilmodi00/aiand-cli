import { bool, parse } from "../cli/args.js";
import { CliError } from "../cli/errors.js";
import { heading, json, out } from "../cli/output.js";
import { IMPORT_HARNESSES, type ImportHarness, importArtifacts } from "../store/artifact-import.js";
import { openStore, storePath } from "../store/index.js";

const help = `${"aiand harness import"} -- backfill behavioral markers from harness session files

Usage
  aiand harness import [--harness <name>]... [--json]

Options
  --harness <name>   only this harness: claude, codex, or opencode
                     (repeatable; default: all three)
  --json             machine-readable summary

Opt-in by construction: nothing is read until you run this command, and the
store receives markers only — tool outcomes (name + ok), terminal states,
compaction counts. No prompts, completions, or tool arguments are ever
imported. Re-running is idempotent: the same files import zero new rows.

Reported rates derived from these rows are labeled heuristic(...) per the
provenance discipline (src/obs/provenance.ts) — harness markers, not
gateway-billed data.`;

function parseHarnesses(argv: string[]): ImportHarness[] {
  const parsed = parse(argv, {
    harness: { type: "string", multiple: true },
  });
  if (bool(parsed, "help")) return [];
  const requested = parsed.values.harness;
  const names =
    typeof requested === "string"
      ? [requested]
      : Array.isArray(requested)
        ? requested.filter((v): v is string => typeof v === "string")
        : [];
  if (names.length === 0) return [...IMPORT_HARNESSES];
  for (const name of names) {
    if (!(IMPORT_HARNESSES as readonly string[]).includes(name)) {
      throw new CliError(`Unknown harness "${name}".`, {
        hint: `Known harnesses: ${IMPORT_HARNESSES.join(", ")}.`,
      });
    }
  }
  return names as ImportHarness[];
}

export async function run(argv: string[]): Promise<void> {
  const harnesses = parseHarnesses(argv);
  if (harnesses.length === 0) return out(help);

  const opened = openStore(storePath());
  if (!opened.ok) {
    throw new CliError(`Could not open the local store: ${opened.reason}`);
  }
  const result = await importArtifacts(opened.db, harnesses);

  if (bool(parse(argv, { harness: { type: "string", multiple: true } }), "json")) {
    return json(result);
  }
  heading("harness import");
  out(`  files read:    ${result.filesRead}`);
  out(`  markers read:  ${result.markersRead}`);
  out(`  rows inserted: ${result.inserted}`);
  for (const harness of harnesses) {
    out(`  ${harness}: ${result.sessions[harness] ?? 0} session(s) covered`);
  }
  if (result.inserted === 0 && result.markersRead > 0) {
    out("  (already imported — idempotent re-run)");
  }
}
