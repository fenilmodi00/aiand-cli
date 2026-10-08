import { publicRequest } from "../api/client.js";
import { requireSessionKey } from "../auth/session.js";
import { ApiError, CliError, SYNTHETIC_STATUS } from "../cli/errors.js";
import { resolveProfile } from "../config.js";
import { getCatalog, resolveDefault, validateCatalogModel, visionLabel } from "./catalog.js";
import { notInstalledError } from "./launch.js";
import { discardSnapshot, hasSnapshot, snapshotCovers, snapshotFiles } from "./snapshot.js";
import type { AgentAdapter } from "./types.js";

/**
 * The agent on/off/status verbs. `agentOn` wires an adapter to ai& (after a
 * pre-aiand snapshot), `agentOff` subtracts what aiand added, and
 * `agentStatus` reads the ground-truth config state (on/off) without
 * trusting any local bookkeeping. The snapshot backs `restore --force`, not `off`.
 */

export type AgentOnOptions = {
  model?: string;
  force?: boolean;
  profile?: string;
};

export type AgentOnResult = {
  agent: string;
  state: "on";
  model: string;
  files: string[];
  /** e.g. a warning when a wired model is text-only and can't take images. */
  warnings: string[];
};

export type AgentOffResult = {
  agent: string;
  state: "off";
  note?: string;
};

export type AgentStatusResult = {
  agent: string;
  installed: boolean;
  binary: string | null;
  state: "on" | "off";
  model: string | null;
};

/**
 * The refusal launcher-only adapters share: they have no persistent wiring,
 * so every session goes through `aiand run-agent`. One source for the text
 * `agentOn`/`agentOff` throw and `aiand <id> --help` prints.
 */
export function launcherOnlyRefusal(adapter: AgentAdapter): string {
  return `${adapter.label} runs on ai& per session only.`;
}

/**
 * The rejected-key advice `on` refuses with before any write, mirroring the
 * 401 hints request() gives at request time: under an env key the fix is the
 * variable, under a stored key it is a fresh login.
 */
function rejectedKeyError(): CliError {
  if (process.env.AIAND_API_KEY) {
    return new CliError("Your AIAND_API_KEY was rejected.", {
      hint: "Check the key, or unset it to use your stored login instead.",
    });
  }
  return new CliError("Your key was rejected.", {
    hint: "Run `aiand login` again.",
  });
}

/**
 * One authenticated probe of `/v1/models` before any write: a key the
 * gateway rejects (401) refuses with the rejected-key advice instead of
 * being baked into agent configs. Unreachable/other failures pass through —
 * the catalog fetch below owns those errors, and a seeded cache keeps
 * offline runs working.
 */
async function validateSessionKey(key: string, apiUrl: string): Promise<void> {
  let response: Response;
  try {
    response = await publicRequest(`${apiUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === SYNTHETIC_STATUS.UNREACHABLE) return;
    throw error;
  }
  // Drain either way so the socket is freed; only the status matters here.
  await response.arrayBuffer().catch(() => {});
  if (response.status === 401) throw rejectedKeyError();
}

/**
 * Turn an agent on: detect the binary, resolve a session key, resolve the
 * model from the live catalog, snapshot when inactive, then let the
 * adapter write its config. An already-active probe skips the snapshot so
 * a re-`on` keeps the first pre-aiand capture.
 */
export async function agentOn(
  adapter: AgentAdapter,
  opts: AgentOnOptions = {},
): Promise<AgentOnResult> {
  // Launcher-only adapters have no persistent wiring to turn on.
  if (adapter.launcherOnly) {
    throw new CliError(launcherOnlyRefusal(adapter), {
      hint: `Use: aiand run-agent ${adapter.id}`,
    });
  }

  // Detect before resolving a session: a missing binary exits 127 with an
  // Install hint, never a login ceremony for a binary that isn't there.
  if (!adapter.detect().installed) throw notInstalledError(adapter);
  const session = await requireSessionKey(opts.profile);

  const probe = await adapter.probe();
  // Pre-write guards run before any snapshot: refusing must never leave a
  // half-state behind, and --force must escape the gate.
  if (adapter.enableGuard) {
    await adapter.enableGuard({ force: opts.force ?? false });
  }

  const profile = resolveProfile(opts.profile);
  // The key is validated before anything is written: a rejected key refuses
  // here, never baked into an agent config.
  await validateSessionKey(session.key, profile.apiUrl);
  const catalog = await getCatalog(profile.apiUrl);

  let model: string;
  // Explicit means explicit: only undefined falls back to the catalog
  // default. An empty --model hits the membership check and errors instead
  // of silently resolving.
  if (opts.model !== undefined) {
    // The literal "native" leaves the model unpinned so the agent's own
    // default wins; it is not a catalog id, so it skips the membership check
    // and the adapter writes nothing for it.
    if (opts.model !== "native") validateCatalogModel(catalog, opts.model);
    model = opts.model;
  } else {
    model = resolveDefault(catalog, profile.model);
  }

  const managed = adapter.managedFiles();
  // A re-`on` while routed skips the snapshot, and an inactive `on` keeps an
  // existing one, so the first pre-aiand capture stays authoritative. One of
  // other files (the managed file moved, e.g. a new CLAUDE_CONFIG_DIR) could
  // never restore this one, so it is replaced.
  let snapshottedThisCall = false;
  if (!probe.active && !(await snapshotCovers(adapter.id, managed))) {
    if (await hasSnapshot(adapter.id)) await discardSnapshot(adapter.id);
    await snapshotFiles(adapter.id, managed);
    snapshottedThisCall = true;
  }

  try {
    const written = await adapter.enable({
      apiKey: session.key,
      model,
      pinModel: opts.model !== undefined && opts.model !== "native",
      profileModel: profile.model,
      profileName: profile.name,
      catalog,
      baseUrl: profile.apiUrl,
    });
    // The wired model warns when it is text-only and can't take images. A
    // model that is not ours (the literal "native", a foreign ref) never warns.
    const warnings: string[] = [...(written.warnings ?? [])];
    const entry = written.catalogModel
      ? catalog.find((model) => model.id === written.catalogModel)
      : undefined;
    if (entry && visionLabel(entry) === "text-only") {
      warnings.push(`${written.model} is text-only and can't take images.`);
    }

    return {
      agent: adapter.id,
      state: "on",
      model: written.model,
      files: written.filesWritten,
      warnings,
    };
  } catch (error) {
    if (snapshottedThisCall) {
      // The snapshot is the only copy of the pre-aiand bytes. Discard it
      // only when enable wrote nothing (probe still inactive); otherwise
      // keep it so `restore --force` can still recover. Best-effort either
      // way: the original enable error is what the user must act on.
      let active = true;
      try {
        active = (await adapter.probe()).active;
      } catch {
        // Unreadable config: keep the snapshot rather than destroy recovery.
      }
      if (!active) {
        await discardSnapshot(adapter.id).catch(() => {});
      }
    }
    throw error;
  }
}

/**
 * Turn an agent off: subtract marked aiand keys. The snapshot is not replayed
 * here — it backs `aiand restore --force`. Exit 0 either way.
 */
export async function agentOff(
  adapter: AgentAdapter,
  opts: { force?: boolean } = {},
): Promise<AgentOffResult> {
  // offGuard lets an adapter refuse, e.g. while a GUI app holds the file.
  if (adapter.offGuard) {
    await adapter.offGuard({ force: opts.force ?? false });
  }

  const result = (await adapter.disable()) ?? { stripped: false };
  const notes = result.notes?.filter(Boolean) ?? [];
  if (!result.stripped && notes.length === 0) {
    return {
      agent: adapter.id,
      state: "off",
      note: "Already your own config — nothing to turn off.",
    };
  }
  if (notes.length > 0) {
    // `note` is one string by contract (agent.ts prints a single dim line, init
    // embeds it as `agent — note`, JSON carries it scalar), so a moved-dir strip
    // per file plus an edited-value note must stay readable: "; " separated.
    return { agent: adapter.id, state: "off", note: notes.join("; ") };
  }
  return { agent: adapter.id, state: "off" };
}

/**
 * Read-only status: whether the binary is present, and the ground-truth
 * config state (aiand-routed or not).
 */
export async function agentStatus(adapter: AgentAdapter): Promise<AgentStatusResult> {
  const detected = adapter.detect();
  const probe = await adapter.probe();
  return {
    agent: adapter.id,
    installed: detected.installed,
    binary: detected.path,
    state: probe.active ? "on" : "off",
    model: probe.model,
  };
}
