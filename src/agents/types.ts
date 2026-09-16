import type { Model } from "../api/models.js";

export type Verb = "on" | "off" | "status";

export type DetectResult = { installed: boolean; path: string | null };

export type ProbeResult = {
  active: boolean; // aiand routing live, ground truth from real files
  model: string | null;
};

export type EnableInput = {
  apiKey: string;                       // resolved session key, baked literal
  model: string;                         // resolved default or --model
  pinModel?: boolean;                    // --model was passed (not native): overwrite existing
  slots: Record<string, string>;         // reserved for future slot-aware adapters
  catalog: Model[];                      // live /v1/models
  home: string;                          // agentHome()
  baseUrl: string;                       // API origin (api.json fetches)
};

export type DisableResult = {
  stripped: boolean;
  notes?: string[];
};

/** Everything a one-process session launcher needs to build its injection. */
export type SessionLaunchInput = {
  apiKey: string;                        // resolved session key, baked into env/config content
  model: string | undefined;              // --model or the adapter default, catalog-validated
  catalog: Model[];                      // live /v1/models (adapters that build model maps)
  baseUrl?: string;                      // --base-url override; adapters fall back to their default
};

export type SessionLaunch = {
  env: Record<string, string>; // added to child env
  clear: string[]; // deleted from child env
  args?: string[]; // extra CLI args before passthrough
  // Always run by the launcher after the child exits, success or failure:
  // remove throwaway overlays, close ephemeral servers. The launcher owns
  // this lifecycle because sessionLaunch is async — ephemeral servers can
  // bind before returning, so no pre-spawn hook is needed.
  cleanup?: () => Promise<void>;
};

/** Options for the pre-write guards. */
export type GuardOptions = { force: boolean };

export type AgentAdapter = {
  id: string; // short: "opencode"
  label: string; // "OpenCode"
  bin: string; // PATH binary: "opencode"
  install: { command: string; url: string };
  aliases?: string[]; // e.g. opencode: []
  detect(): DetectResult; // which/where probe
  managedFiles(): string[]; // absolute paths this adapter touches
  probe(): Promise<ProbeResult>; // read real config, no flags trusted
  enable(input: EnableInput): Promise<{ model: string; filesWritten: string[]; warnings?: string[] }>;
  enableGuard?(opts: GuardOptions): Promise<void>;
  // ^ Runs inside agentOn, before the snapshot + enable(). Adapters whose
  // target app holds config in memory refuse the write while the app is
  // running; --force (parsed by the command layer) escapes every guard.
  offGuard?(opts: GuardOptions): Promise<void>;
  // ^ Same refusal for `off`: the app rewrites its config file from memory on
  // exit, which would clobber the subtractive strip. Only adapters whose
  // target app holds the config in memory define one.
  sessionLaunch?(input: SessionLaunchInput): Promise<SessionLaunch>;
  disable(): Promise<void | DisableResult>; // subtract marked aiand writes; never a snapshot rewind
  // ^ Swap ONLY the baked API-key literal in an already-active config, leaving
  // model ids and every unrelated key/byte untouched. Idempotent: a
  // config whose key already matches is a no-op. Adapters that do not persist
  // a plaintext key skip this (re-running `aiand <id> on` is the refresh path).
  refreshKey?(input: { apiKey: string; home: string }): Promise<void>;
  launcherOnly?: boolean; // adapters with session-only routing: on/off unsupported
};
