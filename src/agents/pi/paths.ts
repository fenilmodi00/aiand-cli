// Where Pi keeps its config and session history, as plain `pi` resolves it.
import { join, resolve } from "node:path";
import { agentHome } from "../../config.js";
import { readJsoncObject } from "../managed-file.js";

/** The agent config dir: ~/.pi/agent/, or $PI_CODING_AGENT_DIR when set. */
export function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(agentHome(), ".pi", "agent");
}

function piSettingsPath(): string {
  return join(piAgentDir(), "settings.json");
}

/**
 * Where plain `pi` keeps this cwd's sessions: a `sessionDir` from settings
 * when set, else Pi's per-cwd default (getDefaultSessionDirPath in 0.87.1's
 * session-manager.js). Pi merges `<cwd>/.pi/settings.json` over the global
 * `~/.pi/agent/settings.json` (settings-manager.js deepMergeSettings), so a
 * project-level `sessionDir` wins here exactly as it does for a plain `pi`
 * launch.
 */
export async function piSessionDir(): Promise<string> {
  const globalSettings = await readJsoncObject(piSettingsPath()).catch(
    () => ({}) as Record<string, unknown>,
  );
  const projectSettings = await readJsoncObject(
    join(resolve(process.cwd()), ".pi", "settings.json"),
  ).catch(() => ({}) as Record<string, unknown>);
  const settings = { ...globalSettings, ...projectSettings };
  if (typeof settings.sessionDir === "string" && settings.sessionDir !== "") {
    return resolve(settings.sessionDir.replace(/^~(?=$|[/\\])/, agentHome()));
  }
  const cwd = resolve(process.cwd());
  return join(piAgentDir(), "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}
