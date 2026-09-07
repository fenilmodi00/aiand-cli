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
  apiKey: string; // resolved session key, baked literal
  model: string; // resolved default or --model
  slots: Record<string, string>; // claude only: opus/sonnet/haiku
  catalog: Model[]; // live /v1/models
  home: string; // agentHome()
};

export type SessionLaunch = {
  env: Record<string, string>; // added to child env
  clear: string[]; // deleted from child env
  args?: string[]; // extra CLI args before passthrough
};

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
  disable(): Promise<void>; // strip aiand writes AFTER manifest restore
  sessionLaunch?(model: string | undefined): SessionLaunch;
  launcherOnly?: boolean; // hermes/grok: on/off unsupported
};
