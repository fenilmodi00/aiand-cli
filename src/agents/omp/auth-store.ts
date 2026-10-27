import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { ompAgentDir } from "./launch.js";

/**
 * omp 0.21.x keeps its own credential store at `<agent dir>/agent.db`
 * (same dir as models.yml — `ompAgentDir()` honors PI_CODING_AGENT_DIR
 * and PI_CONFIG_DIR). Schema verified on a real `~/.omp/agent/agent.db`:
 * table `auth_credentials(id INTEGER PK, provider TEXT, credential_type
 * TEXT, data TEXT, disabled_cause TEXT, identity_key TEXT, created_at
 * INTEGER, updated_at INTEGER)`; rows with provider='aiand',
 * credential_type='api_key', disabled_cause IS NULL carry `data` =
 * JSON `{"key": "sk-..."}`. Reading those keys lets the harness attribute
 * traffic the agent sends with a key the CLI never baked.
 */

const require = createRequire(import.meta.url);

/** Raw keys from omp's own store. Missing/corrupt/unreadable state (including
 *  a missing `~/.omp` or a Node without node:sqlite) returns []. Never throws,
 *  never masks — recordNativeAgentKeys fingerprints what it gets. */
export async function ompNativeAiandKeys(): Promise<string[]> {
  const dbPath = join(ompAgentDir(), "agent.db");
  if (!existsSync(dbPath)) return [];
  let Database: typeof DatabaseSync | null;
  try {
    Database = (require("node:sqlite") as { DatabaseSync: typeof DatabaseSync }).DatabaseSync;
  } catch {
    return [];
  }
  if (!Database) return [];
  let db: DatabaseSync | null = null;
  try {
    db = new Database(dbPath);
    const rows = db
      .prepare(
        "SELECT data FROM auth_credentials " +
          "WHERE provider = 'aiand' AND credential_type = 'api_key' AND disabled_cause IS NULL",
      )
      .all();
    const keys: string[] = [];
    for (const row of rows) {
      if (typeof row?.data !== "string") continue;
      try {
        const key = (JSON.parse(row.data) as { key?: unknown }).key;
        if (typeof key === "string" && key !== "") keys.push(key);
      } catch {
        // malformed data JSON — skip the row
      }
    }
    return keys;
  } catch {
    // corrupt db, missing table, or an open/prepare failure — unreadable state
    return [];
  } finally {
    db?.close();
  }
}
