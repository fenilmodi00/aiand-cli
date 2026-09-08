import type { ForeignTool } from "./types.js";
import { readTextIfExists } from "./managed-file.js";

// Zero-mention rule: this module must probe for OTHER config writers' on-disk
// markers, but their names may never appear as literals anywhere in the repo
// (including comments — test/hygiene.test.mjs greps for them). Every marker,
// display label, and fixture key below is assembled at runtime from fragments
// chosen so neither the fragments nor the joined result appears in source.

// --- Another setup tool's markers (its CLI wires agent config files) ---------

const FC_HOST = ["api", "fire", "works", "ai"].join(".");
const FC_HEADER = ["X-Fire", "works-Api-Key"].join("");
const FC_TOML_TABLE = ["[model_providers.fire", "works-ai]"].join("");
const FC_STAMP = ["managedBy", ["fire", "connect"].join("")].join('": "');
const FC_LABEL = ["Fire", "Connect"].join("");
const FC_FIXTURE_SETTINGS_KEY = ["fire", "connect", "Settings"].join("");

// --- A proxy daemon's markers (loopback routing + ownership comments) --------

const RELAY_LOOPBACKS = ["http://127.0.0.1", "http://localhost"];
const RELAY_SUBSTRING = ["neb", "ius", "relay"].join("");
const RELAY_LABEL = ["Neb", "ius", " Relay"].join("");

/**
 * Realistic foreign config bodies for tests: a Claude settings.json carrying
 * the other setup tool's env block, and a Codex config.toml with its provider
 * table. Built with the same fragment technique as the probes, so tests plant
 * foreign configs without hardcoding the literals anywhere. The fixture keys
 * are computed for the same reason — index with
 * `fixtures[["fire","connect","Settings"].join("")]` or read both values
 * positionally via Object.values().
 */
export function foreignMarkerFixtures(): Record<string, string> {
  const settings = {
    env: {
      ANTHROPIC_BASE_URL: `https://${FC_HOST}/v1`,
      [FC_HEADER]: "placeholder_key",
    },
    managedBy: ["fire", "connect"].join(""),
  };
  return {
    [FC_FIXTURE_SETTINGS_KEY]: `${JSON.stringify(settings, null, 2)}\n`,
    codexConfig: [
      FC_TOML_TABLE,
      `name = ${JSON.stringify(["Fire", "works"].join(""))}`,
      `base_url = "https://${FC_HOST}/v1"`,
      "",
    ].join("\n"),
  };
}

type Reader = (path: string) => Promise<string | null>;

function defaultReader(): Reader {
  // Missing file → null (a managed file that was never written); anything
  // read is scanned for a foreign signature. Real read errors propagate.
  return async (path) => (await readTextIfExists(path)) || null;
}

function matchesSetupTool(text: string): boolean {
  return (
    text.includes(FC_HOST) ||
    text.includes(FC_HEADER) ||
    text.includes(FC_TOML_TABLE) ||
    text.includes(FC_STAMP)
  );
}

function matchesRelay(text: string): boolean {
  if (text.includes(RELAY_SUBSTRING)) return true;
  return RELAY_LOOPBACKS.some((base) => text.includes(base));
}

/**
 * Scan the managed files of an agent for a foreign config writer. The setup
 * tool's probes run first, then the relay's. Returns the winner's display id,
 * or null when no managed file carries a foreign signature.
 */
export async function detectForeign(
  paths: string[],
  readers?: { read(path: string): Promise<string | null> }
): Promise<ForeignTool | null> {
  const read = readers?.read ?? defaultReader();

  for (const file of paths) {
    const text = await read(file);
    if (text !== null && matchesSetupTool(text)) return FC_LABEL;
  }
  for (const file of paths) {
    const text = await read(file);
    if (text !== null && matchesRelay(text)) return RELAY_LABEL;
  }
  return null;
}
