import { forgetAgentKeys, recordAgentKey } from "../api/agent-keys.js";
import { publicRequest } from "../api/client.js";
import { requireSessionKey } from "../auth/session.js";
import { ApiError, CliError, SYNTHETIC_STATUS } from "../cli/errors.js";
import { normalizeBaseUrl, resolveProfile } from "../config.js";
import {
  getCatalog,
  resolveDefault,
  servedModelId,
  validateCatalogModel,
  visionLabel,
} from "./catalog.js";
import { knownKeys } from "./known-keys.js";
import { installIfMissing, notInstalledError } from "./launch.js";
import { assertFastModelFlag, launchAgentSession } from "./session.js";
import { discardSnapshot, extendSnapshot } from "./snapshot.js";
import type { AgentAdapter, ModelSlots } from "./types.js";
import { forgetWired, recordWired } from "./wired.js";

/**
 * The agent on/off/status verbs. `agentOn` wires an adapter to ai& (after a
 * pre-aiand snapshot), `agentOff` subtracts what aiand added, and
 * `agentStatus` reads the ground-truth config state (on/off) without
 * trusting any local bookkeeping. The snapshot backs `restore --force`, not `off`.
 * `agentSession` runs the adapter's own one-process wiring instead: nothing is
 * written outside the throwaway files the adapter creates for that spawn.
 */

export type AgentOnOptions = {
  model?: string;
  fastModel?: string;
  /** A model named in the agent's own launch args: wired as --model when the catalog serves it. */
  launchModel?: string;
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
  warnings?: string[];
};

export type AgentStatusResult = {
  agent: string;
  installed: boolean;
  binary: string | null;
  state: "on" | "off";
  model: string | null;
  /** Every model slot the wired config holds (adapters with more than one). */
  slots?: ModelSlots["slots"];
  /** A slot holding a model the user did not choose. */
  warnings?: string[];
};

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
    throw new CliError(`${adapter.label} runs on ai& per session only.`, {
      hint: `Use: aiand run-agent ${adapter.id}`,
    });
  }

  if (opts.fastModel !== undefined) assertFastModelFlag(adapter);

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
  // here, never baked in an agent config.
  await validateSessionKey(session.key, profile.apiUrl);
  const catalog = await getCatalog(profile.apiUrl);

  let model: string;
  // Explicit means explicit: only undefined falls back to the catalog
  // default. An empty --model hits the membership check and errors instead
  // of silently resolving.
  const launchModel =
    opts.model === undefined && opts.launchModel !== undefined
      ? servedModelId(catalog, opts.launchModel)
      : undefined;
  const requested =
    launchModel !== undefined && catalog.some((entry) => entry.id === launchModel)
      ? launchModel
      : opts.model;
  if (requested !== undefined) {
    // The literal "native" leaves the model unpinned so the agent's own
    // default wins; it is not a catalog id, so it skips the membership check
    // and the adapter writes nothing for it.
    if (requested !== "native") validateCatalogModel(catalog, requested);
    model = requested;
  } else {
    model = resolveDefault(catalog, profile.model);
  }
  if (opts.fastModel !== undefined) validateCatalogModel(catalog, opts.fastModel, "--fast-model");

  // A re-`on` while routed skips the snapshot, and an inactive `on` only
  // adds paths the snapshot lacks (the managed file moved, e.g. a new
  // PI_CODING_AGENT_DIR), so the first pre-aiand capture of every path stays
  // authoritative. A file already carrying our marker or a known key is
  // recorded without a copy: it is not pre-aiand, and the copy would keep
  // the key past `off` and logout.
  let snapshottedThisCall = false;
  if (!probe.active) {
    snapshottedThisCall = await extendSnapshot(adapter.id, adapter.managedFiles(), {
      keys: await knownKeys(session.key),
      carriesWiring: adapter.carriesWiring?.bind(adapter),
    });
  }

  try {
    const written = await adapter.enable({
      apiKey: session.key,
      model,
      pinModel: requested !== undefined && requested !== "native",
      ...(opts.fastModel !== undefined ? { fastModel: opts.fastModel } : {}),
      profileModel: profile.model,
      profileName: profile.name,
      catalog,
      baseUrl: profile.apiUrl,
    });
    await recordWired(adapter.id, profile.name, normalizeBaseUrl(profile.apiUrl));
    // The wired model warns when it is text-only and can't take images. A
    // model that is not ours (the literal "native", a foreign ref) never warns.
    const warnings: string[] = [...(written.warnings ?? [])];
    const entry = written.catalogModel
      ? catalog.find((model) => model.id === written.catalogModel)
      : undefined;
    if (entry && visionLabel(entry) === "text-only") {
      warnings.push(`${written.model} is text-only and can't take images.`);
    }

    // Remember which key this agent now uses, so `aiand cache` can attribute
    // the Gateway's per-request rows to it. The Gateway reports `api_key` but
    // no client field, and this map is the only handle on that.
    await recordAgentKey(adapter.id, session.key).catch(() => {
      // Observability must never break wiring.
    });

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
 * Run an adapter's own one-process wiring, the way `aiand run-agent` does:
 * resolve the session, build the ephemeral launch, spawn the agent, and clean
 * up after it. Returns the model the adapter ran on; the `--session` flag of
 * `aiand <agent> [on]` reuses this so the persistent path stays the only
 * place `enable` writes.
 */
export async function agentSession(
  adapter: AgentAdapter,
  opts: {
    model?: string;
    fastModel?: string;
    profile?: string;
    passthrough?: string[];
    install?: boolean;
  } = {},
): Promise<string> {
  // Same refusal order as run-agent.ts: capability before session, so an
  // unsupported adapter never starts a login ceremony.
  if (adapter.configOnly) {
    throw new CliError(`${adapter.label} is a desktop app; aiand wires it but cannot launch it.`, {
      hint: `Run \`aiand ${adapter.id} on\` for permanent wiring.`,
    });
  }
  if (adapter.launcherOnly) {
    throw new CliError(`${adapter.label} runs on ai& per session only.`, {
      hint: `Use: aiand run-agent ${adapter.id}`,
    });
  }
  const launch = adapter.sessionLaunch;
  if (!launch) {
    throw new CliError(`${adapter.label} does not support --session.`, {
      hint: `Run \`aiand ${adapter.id} on\` for permanent wiring.`,
    });
  }

  // `aiand <agent> --session` is the bare open path, so it offers the npm
  // install just like `aiand <agent>`; `on --session` does not.
  if (opts.install) await installIfMissing(adapter);
  if (!adapter.detect().installed) throw notInstalledError(adapter);

  // One launcher with `aiand run-agent`: the model flags, catalog validation,
  // overlay sweep, key attribution, child env, spawn, and cleanup all match
  // the session path there.
  return launchAgentSession(adapter, launch, {
    model: opts.model,
    fastModel: opts.fastModel,
    profile: opts.profile,
    passthrough: opts.passthrough,
  });
}

/**
 * Turn an agent off: subtract marked aiand keys. The snapshot is not replayed
 * here — it backs `aiand restore --force`. `stripped` false with a note
 * reports work off did but declines to claim ("left providers.aiand because
 * you edited it"); false and silent means nothing was there. Exit 0 either way.
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
  await forgetWired(adapter.id);
  const notes = result.notes?.filter(Boolean) ?? [];
  // The agent no longer uses our key: drop the attribution so `aiand cache`
  // does not keep reporting it as an active agent.
  await forgetAgentKeys(adapter.id);
  if (!result.stripped && notes.length === 0) {
    return {
      agent: adapter.id,
      state: "off",
      note: "Already your own config — nothing to turn off.",
    };
  }
  const warnings = result.warnings?.length ? { warnings: result.warnings } : {};
  if (notes.length > 0) {
    // `note` is one string by contract (agent.ts prints a single dim line, init
    // embeds it as `agent — note`, JSON carries it scalar), so a moved-dir strip
    // per file plus an edited-value note must stay readable: "; " separated.
    return { agent: adapter.id, state: "off", note: notes.join("; "), ...warnings };
  }
  return { agent: adapter.id, state: "off", ...warnings };
}

/**
 * Read-only status: whether the binary is present, and the ground-truth
 * config state (aiand-routed or not).
 */
export async function agentStatus(adapter: AgentAdapter): Promise<AgentStatusResult> {
  const detected = adapter.detect();
  const probe = await adapter.probe();
  const slots = probe.active ? await adapter.modelSlots?.() : undefined;
  return {
    agent: adapter.id,
    installed: detected.installed,
    binary: detected.path,
    state: probe.active ? "on" : "off",
    model: probe.model,
    ...(slots ? { slots: slots.slots, warnings: slots.warnings } : {}),
  };
}
