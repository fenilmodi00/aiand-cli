import type { Model } from "../api/models.js";

export type Verb = "on" | "off" | "status";
export type ForeignTool = string; // display id of a foreign config writer, assembled at runtime by foreign.ts — never a literal here (zero-mention rule)

export type DetectResult = { installed: boolean; path: string | null };

export type ProbeResult = {
  active: boolean; // aiand routing live, ground truth from real files
  foreignTool: ForeignTool | null;
  model: string | null;
};

export type EnableInput = {
  apiKey: string;                       // resolved session key, baked literal
  model: string;                         // resolved default or --model
  slots: Record<string, string>;         // claude only: opus/sonnet/haiku
  catalog: Model[];                      // live /v1/models
  home: string;                          // agentHome()
  baseUrl: string;                       // API origin (api.json fetches)
};

/** Everything a one-process session launcher needs to build its injection. */
export type SessionLaunchInput = {
  apiKey: string;                        // resolved session key, baked into env/config content
  model: string | undefined;              // --model or the adapter default, catalog-validated
  catalog: Model[];                      // live /v1/models (adapters that build model maps)
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

/** Options for the pre-write guards; `isRunning` is the test seam. */
export type GuardOptions = { force: boolean; isRunning?: () => boolean };

export type AgentAdapter = {
  id: string; // short: "claude", "codex", ...
  label: string; // "Claude Code"
  bin: string; // PATH binary: "claude", "codex", ...
  install: { command: string; url: string };
  aliases?: string[]; // e.g. codex: ["chatgpt"]
  detect(): DetectResult; // which/where probe
  managedFiles(): string[]; // absolute paths this adapter touches
  probe(): Promise<ProbeResult>; // read real config, no flags trusted
  enable(input: EnableInput): Promise<{ model: string; filesWritten: string[] }>;
  enableGuard?(opts: GuardOptions): Promise<void>;
  // ^ Runs inside agentOn, after the foreign-config refusal but BEFORE the
  // snapshot + enable(). Adapters whose target app holds config in memory
  // (ChatGPT Desktop, Cursor IDE) refuse the write while the app is running
  // because it would clobber theirs; --force (parsed by the command layer)
  // escapes every guard.
  offGuard?(opts: GuardOptions): Promise<void>;
  // ^ Same refusal for `off`: the app rewrites its config file from memory on
  // exit, which would clobber the byte-for-byte restore. Only adapters whose
  // target app holds the config in memory define one.
  sessionLaunch?(input: SessionLaunchInput): Promise<SessionLaunch>;
  disable(): Promise<void>; // strip aiand writes AFTER manifest restore
  launcherOnly?: boolean; // hermes/grok: on/off unsupported
};
