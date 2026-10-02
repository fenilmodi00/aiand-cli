import { existsSync } from "node:fs";
import { join } from "node:path";
import { agentHome, writeFileAtomic } from "../../config.js";
import { PRIVATE_FILE_MODE } from "../../fsutil.js";
import { resolveDefault } from "../catalog.js";
import { createSessionOverlay, readTextIfExists } from "../managed-file.js";
import type { SessionLaunchInput } from "../types.js";
import {
  buildOmpProviderBlock,
  editOmpProviderBlock,
  OMP_PROVIDER_ID,
  type OmpProviderOwnership,
  readOmpProviderBlock,
} from "./provider.js";
import { yamlRender } from "./yaml.js";

/** The agent config dir: ~/.omp/agent/, or $PI_CODING_AGENT_DIR when set. */
function ompAgentDir(): string {
  if (process.env.PI_CODING_AGENT_DIR) return process.env.PI_CODING_AGENT_DIR;
  return join(agentHome(), process.env.PI_CONFIG_DIR || ".omp", "agent");
}

/** Where omp keeps session history: the agent dir's `sessions/`, or the
 *  XDG data dir omp migrated to (`$XDG_DATA_HOME/omp/sessions`) when the
 *  user ran `omp config init-xdg`. Mirrors DirResolver (dirs.ts:365-399):
 *  XDG applies only on linux/darwin, only when the agent dir is the
 *  default one, and only when the XDG dir exists. */
function ompSessionsDir(): string {
  if (process.env.PI_CODING_AGENT_DIR) return join(ompAgentDir(), "sessions");
  if (process.platform === "linux" || process.platform === "darwin") {
    const xdg = process.env.XDG_DATA_HOME || join(agentHome(), ".local", "share");
    const migrated = join(xdg, "omp");
    if (existsSync(migrated)) return join(migrated, "sessions");
  }
  return join(ompAgentDir(), "sessions");
}

export function ompModelsPath(): string {
  return join(ompAgentDir(), "models.yml");
}
export function ompConfigPath(): string {
  return join(ompAgentDir(), "config.yml");
}

/**
 * Works with no prior `on`: a throwaway overlay becomes
 * PI_CODING_AGENT_DIR holding only a generated models.yml (the same
 * override block `on` writes) and config.yml pinning modelRoles.default
 * at 0600. The key never rides the child env — the overlay file is how
 * omp reads it — and cleanup removes the overlay after the child exits.
 * Real session history survives in the user's own session dir — omp's
 * default agent dir, its XDG location when migrated, or an explicit
 * PI_CODING_AGENT_SESSION_DIR — pointed at through that env var.
 */
export async function ompSessionLaunch(input: SessionLaunchInput) {
  let model = input.model;
  if (model === "native") model = undefined;
  else if (model === undefined) model = resolveDefault(input.catalog, input.profileModel);
  const files: Record<string, string> = {
    "models.yml": yamlRender({
      providers: {
        [OMP_PROVIDER_ID]: buildOmpProviderBlock({
          baseUrl: input.baseUrl,
          apiKey: input.apiKey,
        }),
      },
    }),
  };
  if (model !== undefined) {
    files["config.yml"] = yamlRender({ modelRoles: { default: `${OMP_PROVIDER_ID}/${model}` } });
  }
  const overlay = await createSessionOverlay("aiand-omp-", files);
  const args = model === undefined ? [] : ["--model", `${OMP_PROVIDER_ID}/${model}`];
  // Non-TTY stdin: ask for an explicit one-shot mode. A piped prompt must
  // process and exit, not sit on an interactive session.
  if (!process.stdin.isTTY) args.push("--print");
  return {
    env: {
      PI_CODING_AGENT_DIR: overlay.dir,
      PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR ?? ompSessionsDir(),
    },
    // --model pins the routing; a user-supplied --provider/--api-key/
    // --models would override the overlay, so they are stripped with the
    // rest of the routing flags (both `--flag value` and `--flag=value`).
    args,
    stripPassthroughFlags: ["--model", "--provider", "--api-key", "--models"],
    cleanup: overlay.cleanup,
  };
}

export async function ompRefreshKey(input: {
  apiKey: string;
  previousKey?: string;
}): Promise<boolean> {
  // Marker-gated like disable(): a foreign `aiand`-named provider keeps
  // its own key untouched. A models.yml that cannot be parsed must not
  // hard-fail the rebake either: report untouched and leave the file
  // for a by-hand fix (#18 P18-omp-3).
  const raw = await readTextIfExists(ompModelsPath());
  const ownership: OmpProviderOwnership = readOmpProviderBlock(raw);
  if (ownership.kind !== "ours") return false;
  const bakedKey = ownership.block.apiKey;
  // A same-key no-op still counts as touched: an idempotent rebake reports
  // refreshed.
  if (bakedKey === input.apiKey) return true;
  // A rotation swaps only the key it replaced: a config baked from another
  // profile keeps routing to that profile's org.
  if (input.previousKey !== undefined && bakedKey !== input.previousKey) return false;
  await writeFileAtomic(ompModelsPath(), editOmpProviderBlock(raw, "apiKey", input.apiKey), {
    mode: PRIVATE_FILE_MODE,
  });
  return true;
}
