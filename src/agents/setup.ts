import { resolveProfile } from "../config.js";
import { CliError } from "../cli/errors.js";
import { requireSessionKey } from "../auth/session.js";
import { snapshotFiles, hasSnapshot, discardSnapshot } from "./snapshot.js";
import {
  getCatalog,
  resolveDefault,
  validateCatalogModel,
  visionLabel,
} from "./catalog.js";
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
 * Turn an agent on: resolve a session key, detect the binary, resolve the
 * model from the live catalog, snapshot when inactive, then let the
 * adapter write its config. An already-active probe skips the snapshot so
 * a re-`on` keeps the first pre-aiand capture.
 */
export async function agentOn(adapter: AgentAdapter, opts: AgentOnOptions = {}): Promise<AgentOnResult> {
  // Launcher-only adapters have no persistent wiring: their config strategy
  // is a throwaway overlay/env per session, so `on` cannot mean anything.
  // Point at the one process launcher instead of writing anything.
  if (adapter.launcherOnly) {
    throw new CliError(`${adapter.label} runs on ai& per session only.`, {
      hint: `Use: aiand run-agent ${adapter.id}`,
    });
  }

  const session = await requireSessionKey(opts.profile);
  const detected = adapter.detect();
  if (!detected.installed) {
    throw new CliError(`${adapter.label} is not installed.`, {
      exitCode: 127,
      hint: `Install it with: ${adapter.install.command}\nSee: ${adapter.install.url}`,
    });
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
  if (opts.model) {
    // The literal "native" leaves the model unpinned so the agent's own
    // default wins; it is not a catalog id, so it skips the membership check
    // and the adapter writes nothing for it.
    if (opts.model !== "native") validateCatalogModel(catalog, opts.model);
    model = opts.model;
  } else {
    model = resolveDefault(catalog, profile.model);
  }

  const managed = adapter.managedFiles();
  // Idempotency: a re-`on` while already routed skips the snapshot so the
  // first pre-aiand capture stays authoritative. An inactive `on` snapshots
  // only when none exists — never overwrite a capture with leftover keys.
  let snapshottedThisCall = false;
  if (!probe.active && !(await hasSnapshot(adapter.id))) {
    await snapshotFiles(adapter.id, managed);
    snapshottedThisCall = true;
  }

  try {
    const written = await adapter.enable({
      apiKey: session.key,
      model,
      pinModel: Boolean(opts.model) && opts.model !== "native",
      catalog,
      baseUrl: profile.apiUrl,
    });
    // The wired model warns when it is text-only and can't take images. The
    // literal "native" names no catalog model and never warns.
    const warnings: string[] = [...(written.warnings ?? [])];
    if (written.model !== "native") {
      const catalogId = written.model.startsWith("aiand/")
        ? written.model.slice("aiand/".length)
        : written.model;
      const entry = catalog.find((model) => model.id === catalogId);
      if (entry && visionLabel(entry) === "text-only") {
        warnings.push(`${written.model} is text-only and can't take images.`);
      }
    }

    return {
      agent: adapter.id,
      state: "on",
      model: written.model,
      files: written.filesWritten,
      warnings,
    };
  } catch (error) {
    if (snapshottedThisCall) await discardSnapshot(adapter.id);
    throw error;
  }

}

/**
 * Turn an agent off: subtract marked aiand keys. The snapshot is not replayed
 * here — it backs `aiand restore --force`. Exit 0 either way.
 */
export async function agentOff(adapter: AgentAdapter, opts: { force?: boolean } = {}): Promise<AgentOffResult> {
  // GUI adapters refuse while the app holds the file in memory.
  if (adapter.offGuard) {
    await adapter.offGuard({ force: opts.force ?? false });
  }

  const result = (await adapter.disable()) ?? { stripped: false };
  const notes = result.notes?.filter(Boolean) ?? [];
  if (!result.stripped && notes.length === 0) {
    return { agent: adapter.id, state: "off", note: "Already your own config — nothing to turn off." };
  }
  if (notes.length > 0) {
    return { agent: adapter.id, state: "off", note: notes.join(" ") };
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
