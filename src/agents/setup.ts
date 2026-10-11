import { openSession, requestJson } from "../api/client.js";
import { requireSessionKey } from "../auth/session.js";
import { ApiError, CliError } from "../cli/errors.js";
import { resolveProfile } from "../config.js";
import { getCatalog, resolveDefault, validateCatalogModel, visionLabel } from "./catalog.js";
import { installIfMissing, notInstalledError, runAgentBinary } from "./launch.js";
import { discardSnapshot, hasSnapshot, snapshotCovers, snapshotFiles } from "./snapshot.js";
import type { AgentAdapter } from "./types.js";

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

  // Detect before resolving a session: a missing binary exits 127 with an
  // Install hint, never a login ceremony for a binary that isn't there.
  if (!adapter.detect().installed) throw notInstalledError(adapter);
  const session = await requireSessionKey(opts.profile);
  // The catalog endpoint is public, so a garbage env key would otherwise
  // pass the fetch below and get baked into the agent's files (the first
  // auth'd call would then 401 at session time). One authenticated request
  // up front: a rejected key refuses on before any write. Only a 401
  // refuses — an unreachable gateway must not block a cache-served on.
  const apiSession = await openSession(resolveProfile(opts.profile));
  try {
    await requestJson(apiSession, { path: "/v1/models" });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) throw error;
  }

  const probe = await adapter.probe();

  // Pre-write guards run before any snapshot: refusing must never leave a
  // half-state behind, and --force must escape the gate.
  if (adapter.enableGuard) {
    await adapter.enableGuard({ force: opts.force ?? false });
  }

  const profile = resolveProfile(opts.profile);
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
 * Run an adapter's own one-process wiring, the way `aiand run-agent` does:
 * resolve the session, build the ephemeral launch, spawn the agent, and clean
 * up after it. Returns the model the adapter ran on; the `--session` flag of
 * `aiand <agent> [on]` reuses this so the persistent path stays the only
 * place `enable` writes.
 */
export async function agentSession(
  adapter: AgentAdapter,
  opts: { model?: string; profile?: string; passthrough?: string[]; install?: boolean } = {},
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

  const session = await requireSessionKey(opts.profile);
  const profile = resolveProfile(opts.profile);
  const catalog = await getCatalog(profile.apiUrl);
  const unpinned = opts.model === "native" && adapter.allowUnpinnedModel === true;
  if (opts.model !== undefined && !unpinned) validateCatalogModel(catalog, opts.model);

  const resolved = await launch({
    apiKey: session.key,
    model: opts.model,
    profileModel: profile.model,
    profileName: profile.name,
    catalog,
    baseUrl: profile.apiUrl,
  });

  // The reported model: an explicit --model, else the catalog default.
  // ponytail: an adapter with its own preferred order (claude's claude
  // adapter) may pin a different model inside its sessionLaunch, and
  // SessionLaunch does not report back which one it chose; extend
  // SessionLaunch with `model` if the JSON report must match exactly.
  const model = opts.model ?? resolveDefault(catalog, profile.model);

  // Child env = inherited, plus the adapter's own injection; the adapter's
  // injection carries the key, so the spawn env starts scrubbed.
  const env: NodeJS.ProcessEnv = { ...process.env };
  // The adapter's own injection carries the key; a leaked AIAND_API_KEY would
  // hand it to every process the agent spawns.
  delete env.AIAND_API_KEY;
  // Adapters that route outside the child env list the inherited names that
  // would shadow that routing; the launcher drops them so its own injection wins.
  for (const k of adapter.shadowEnv ?? []) delete env[k];
  Object.assign(env, resolved.env);

  // The adapter may own routing flags in the passthrough: drop the user's
  // `--flag value` and `--flag=value` forms so the injected routing cannot be
  // overridden. Everything else passes verbatim. A value is only consumed when
  // it is not itself a flag, so `--model --print` keeps --print and a trailing
  // `--model` eats nothing.
  const ownedFlags = resolved.stripPassthroughFlags ?? [];
  const passthrough: string[] = [];
  const input = opts.passthrough ?? [];
  for (let i = 0; i < input.length; i += 1) {
    const token = input[i]!;
    if (ownedFlags.includes(token)) {
      // `--flag value`: the value is the next token, when present and not
      // itself a flag.
      const next = input[i + 1];
      if (next !== undefined && !next.startsWith("-")) i += 1;
      continue;
    }
    if (ownedFlags.some((flag) => token.startsWith(`${flag}=`))) continue;
    passthrough.push(token);
  }

  await runAgentBinary(adapter, [...(resolved.args ?? []), ...passthrough], env, resolved.cleanup);
  return model;
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
