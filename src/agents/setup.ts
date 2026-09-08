import { agentHome, resolveProfile } from "../config.js";
import { CliError } from "../cli/errors.js";
import { confirm, isInteractive } from "../cli/prompt.js";
import { requireSessionKey } from "../auth/session.js";
import { snapshotFiles, restoreSnapshot } from "./snapshot.js";
import {
  formatTextOnlyWarning,
  getCatalog,
  resolveDefault,
  resolveSlots,
  visionLabel,
} from "./catalog.js";
import type { AgentAdapter } from "./types.js";

/**
 * The agent on/off/status verbs. `agentOn` wires an adapter to ai& (after a
 * foreign-config refusal and a pre-aiand snapshot), `agentOff` restores the
 * pre-aiand bytes and strips aiand-owned side files, and `agentStatus` reads
 * the ground-truth config state (on/foreign/off) without trusting any local
 * bookkeeping.
 */

export type AgentOnOptions = {
  model?: string;
  force?: boolean;
  slots?: Record<string, string>;
  profile?: string;
  baseUrl?: string;
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
  state: "on" | "off" | "foreign";
  foreign: string | null;
  model: string | null;
};

/**
 * Turn an agent on: resolve a session key, detect the binary, refuse foreign
 * configs unless forced, snapshot when inactive, resolve model/slots from the
 * live catalog, then let the adapter write its config. An already-active
 * probe skips the snapshot so a re-`on` keeps the first pre-aiand backup.
 */
export async function agentOn(adapter: AgentAdapter, opts: AgentOnOptions = {}): Promise<AgentOnResult> {
  // Launcher-only agents (hermes, grok) have no persistent wiring: their
  // config strategy is a throwaway overlay/env per session, so `on` cannot
  // mean anything. Point at the one process launcher instead of writing
  // anything.
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

  if (probe.foreignTool && !opts.force) {
    const files = adapter.managedFiles().map((file) => file.replace(agentHome(), "~")).join(", ");
    if (isInteractive()) {
      const proceed = await confirm(`\`${probe.foreignTool}\` manages ${files}. Overwrite it?`, {
        default: false,
      });
      if (!proceed) throw new CliError("Keeping your existing config.");
    } else {
      throw new CliError(`${probe.foreignTool} manages ${files}; last writer wins.`, {
        hint: "Pass --force to overwrite it.",
      });
    }
  }

  // App-held-config guards (ChatGPT Desktop, Cursor IDE) run after the
  // foreign refusal and before any snapshot: refusing must never leave a
  // half-state behind, and --force must escape both gates.
  if (adapter.enableGuard) {
    await adapter.enableGuard({ force: opts.force ?? false });
  }
  const managed = adapter.managedFiles();
  // Idempotency: a re-`on` while already routed keeps the first backup
  // (probe.active), and every inactive `on` re-snapshots so the manifest
  // always matches the pre-aiand state — including after a foreign config
  // was overwritten with --force, or an `off` that left a stale manifest
  // behind. An aiand-routed config is never its own backup: active probes
  // skip the snapshot entirely.
  if (!probe.active) {
    await snapshotFiles(adapter.id, managed);
  }

  const profile = resolveProfile(opts.profile);
  const catalog = await getCatalog(opts.baseUrl ?? profile.apiUrl);

  let model: string;
  if (opts.model) {
    // The literal "native" unpins a slot so the agent's own default wins; it
    // is not a catalog id, so it skips the membership check and the adapter
    // writes nothing for it (see the claude adapter's enable()).
    if (opts.model !== "native" && !catalog.some((entry) => entry.id === opts.model)) {
      throw new CliError(`--model "${opts.model}" is not in the catalog.`, {
        hint: `Valid ids: ${catalog.map((entry) => entry.id).join(", ")}`,
      });
    }
    model = opts.model;
  } else {
    model = resolveDefault(catalog, profile.model);
  }

  // Explicit slot overrides (only Claude Code has slots) layered on top of
  // catalog-derived defaults, so a slot never falls back to a retired id.
  const slots: Record<string, string> = {
    ...(adapter.id === "claude" ? resolveSlots(catalog) : {}),
    ...opts.slots,
  };
  for (const [slot, value] of Object.entries(opts.slots ?? {})) {
    if (value !== "native" && !catalog.some((entry) => entry.id === value)) {
      throw new CliError(`--${slot} "${value}" is not in the catalog.`, {
        hint: `Valid ids: ${catalog.map((entry) => entry.id).join(", ")}`,
      });
    }
  }

  const written = await adapter.enable({
    apiKey: session.key,
    model,
    slots,
    catalog,
    home: agentHome(),
    baseUrl: opts.baseUrl ?? profile.apiUrl,
  });

  // Claude Code reads model ids back tagged with [1m]; strip that before the
  // catalog lookup so a text-only 1M model still warns. Every id actually
  // written (main model + slot values) is checked against the catalog, except
  // the literal "native" escape hatch, which names no model and never warns.
  let warnings: string[] = [];
  if (adapter.id === "claude") {
    const ids = [written.model, slots.opus, slots.sonnet, slots.haiku]
      .filter((id): id is string => typeof id === "string" && id !== "native")
      .map((id) => id.replace(/\[1m\]$/, ""));
    const textOnly = ids.filter((id) => {
      const entry = catalog.find((model) => model.id === id);
      return entry !== undefined && visionLabel(entry) === "text-only";
    });
    const line = formatTextOnlyWarning([...new Set(textOnly)]);
    if (line) warnings = [line];
  }

  return {
    agent: adapter.id,
    state: "on",
    model: written.model,
    files: written.filesWritten,
    warnings,
  };
}

/**
 * Turn an agent off: restore the pre-aiand bytes from the manifest (or report
 * that nothing was ours to begin with), then let the adapter clean up any
 * aiand-owned side files. Exit 0 either way.
 */
export async function agentOff(adapter: AgentAdapter, opts: { force?: boolean } = {}): Promise<AgentOffResult> {
  // The restore must land on disk while the owning app is NOT running — it
  // rewrites the config from memory on exit and would undo the restore.
  if (adapter.offGuard) {
    await adapter.offGuard({ force: opts.force ?? false });
  }
  const restored = await restoreSnapshot(adapter.id);
  if (!restored) {
    // No manifest, but the config may still carry orphaned aiand routing
    // (e.g. the backup was deleted). The adapter's strip path removes only
    // what it owns; a genuinely untouched config still reports the friendly
    // nothing-to-turn-off note.
    const probe = await adapter.probe();
    if (probe.active) {
      await adapter.disable();
      return { agent: adapter.id, state: "off" };
    }
    return { agent: adapter.id, state: "off", note: "Already your own config — nothing to turn off." };
  }
  await adapter.disable();
  return { agent: adapter.id, state: "off" };
}

/**
 * Read-only status: whether the binary is present, and the ground-truth
 * config state (aiand-routed, foreign-owned, or untouched).
 */
export async function agentStatus(adapter: AgentAdapter): Promise<AgentStatusResult> {
  const detected = adapter.detect();
  const probe = await adapter.probe();
  const state: AgentStatusResult["state"] = probe.active
    ? "on"
    : probe.foreignTool
      ? "foreign"
      : "off";
  return {
    agent: adapter.id,
    installed: detected.installed,
    binary: detected.path,
    state,
    foreign: probe.foreignTool,
    model: probe.model,
  };
}