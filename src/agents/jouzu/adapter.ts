import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { detectBinary } from "../detect.js";
import { readJsoncObject } from "../managed-file.js";
import { createPiFamily } from "../pi/family.js";
import { PI_PROVIDER_ID } from "../pi/ownership.js";
import type { AgentAdapter, DetectResult } from "../types.js";

const JOUZU_ID = "jouzu";
const JOUZU_BIN = "jouzu";
/** Jouzu installs the same entry point as `jz`: `aiand jz` is an alias. */
const JOUZU_SHORT_BIN = "jz";

type JouzuRootInput = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string; // the OS home Jouzu itself would use (os.homedir())
  scopedHome?: string; // AIAND_HOME: stands in for the OS home
};

/**
 * Jouzu's root: $JOUZU_HOME when set, otherwise its per-platform config dir
 * (packages/cli/src/paths.ts resolveJouzuPaths, Jouzu 0.2.x). Like Jouzu,
 * a leading `~` in JOUZU_HOME, APPDATA or XDG_CONFIG_HOME means the home
 * dir and a relative value resolves against cwd. Under AIAND_HOME the
 * scoped home stands in for the OS home, and APPDATA / XDG_CONFIG_HOME are
 * ignored: they describe the real home, not the one aiand was pointed at.
 * @public exported for tests
 */
export function resolveJouzuRoot({ platform, env, home, scopedHome }: JouzuRootInput): string {
  const path = platform === "win32" ? win32 : posix;
  const absolute = (value: string): string => path.resolve(value.replace(/^~(?=$|[/\\])/, home));
  const override = env.JOUZU_HOME?.trim();
  if (override) return absolute(override);
  const base = scopedHome ?? home;
  const fromEnv = (name: string): string | undefined => {
    const value = scopedHome === undefined ? env[name]?.trim() : undefined;
    return value ? absolute(value) : undefined;
  };
  if (platform === "darwin") return path.join(base, "Library", "Application Support", "Jouzu");
  if (platform === "win32") {
    return path.join(fromEnv("APPDATA") ?? path.join(base, "AppData", "Roaming"), "Jouzu");
  }
  return path.join(fromEnv("XDG_CONFIG_HOME") ?? path.join(base, ".config"), "jouzu");
}

function jouzuConfigDir(): string {
  return resolveJouzuRoot({
    platform: process.platform,
    env: process.env,
    home: homedir(),
    scopedHome: process.env.AIAND_HOME || undefined,
  });
}

/**
 * Jouzu runs Pi with PI_CODING_AGENT_DIR pinned to `<root>/agent`, so Pi's
 * own models.json, auth.json and settings.json live there, and the wiring is
 * Pi's, file for file. A PI_CODING_AGENT_DIR of the user's never reaches
 * Jouzu: it overwrites the variable at startup.
 */
function jouzuAgentDir(): string {
  return join(jouzuConfigDir(), "agent");
}

const jouzu = createPiFamily({
  id: JOUZU_ID,
  label: "Jouzu",
  agentDir: jouzuAgentDir,
  dirEnv: "JOUZU_HOME",
});

/**
 * Args that already decide the model or the session (Pi's flags, which
 * Jouzu passes through), that name Jouzu's own options, or that run a Jouzu
 * management command. `open` adds nothing when any of these is present.
 */
const DECIDING_FLAGS = new Set([
  "--model",
  "--models",
  "--provider",
  "--api-key",
  "--session",
  "--session-id",
  "--resume",
  "-r",
  "--continue",
  "-c",
  "--fork",
  "--help",
  "-h",
  "--version",
  "-v",
]);
/**
 * Words Jouzu or Pi read as a command, and only as the first argument
 * (Pi 1.5.0: package-manager-cli.js parsePackageCommand and
 * handleConfigCommand, main.js `mcp`, cli/auth-command.js). Flags in front
 * of one would turn it into a chat prompt, so `open` adds none.
 */
const SUBCOMMANDS = new Set([
  "acp",
  "doctor",
  "catalog",
  "profile",
  "profile-migration",
  "keybindings",
  "self-update",
  "pi",
  "help",
  "install",
  "uninstall",
  "remove",
  "update",
  "list",
  "config",
  "mcp",
  "auth",
]);

function argsDecide(args: string[]): boolean {
  if (args.length > 0 && SUBCOMMANDS.has(args[0] as string)) return true;
  // `--` only ends option parsing; what follows is positional, and the
  // injected flags go in front of it.
  const end = args.indexOf("--");
  return (end === -1 ? args : args.slice(0, end)).some((arg) => {
    const flag = arg.split("=", 1)[0] as string;
    return DECIDING_FLAGS.has(flag) || flag.startsWith("--jouzu-");
  });
}

/**
 * The Jouzu release the install hint pins: the newest one at least seven
 * days old when this was written, matching the release-age rule the repo
 * applies to its own dependencies. Jouzu updates a global npm install
 * itself at launch, so this only decides the first install. CI installs
 * the same release for scripts/jouzu-smoke.mjs.
 * @public read from dist/ by scripts/check-dist.mjs
 */
export const JOUZU_VERSION = "0.2.5";

export const jouzuAdapter: AgentAdapter = {
  id: JOUZU_ID,
  label: "Jouzu",
  bin: JOUZU_BIN,
  aliases: [JOUZU_SHORT_BIN],
  install: {
    command: `npm install -g --ignore-scripts jouzu@${JOUZU_VERSION}`,
    url: "https://github.com/shisa-ai/jouzu",
  },
  // "--model native" leaves the model unpinned, as for Pi.
  allowUnpinnedModel: true,
  detect(): DetectResult {
    // `jouzu` only: npm installs `jz` beside it, so a `jz` alone belongs to
    // another tool, and `open` launches `jouzu`.
    return detectBinary(JOUZU_BIN);
  },
  carriesWiring: jouzu.carriesWiring,
  managedFiles: jouzu.managedFiles,
  probe: jouzu.probe,
  bakedBaseUrl: jouzu.bakedBaseUrl,
  enableGuard: jouzu.enableGuard,
  enable: jouzu.enable,
  disable: jouzu.disable,
  refreshKey: jouzu.refreshKey,
  // Attribution for gateway /logs rows, from the same Pi files `on` writes:
  // the baked credential and any native gateway-reaching credential in
  // auth.json. Behavior of on/off/status is unchanged.
  bakedKey: jouzu.bakedKey,
  nativeAiandKeys: jouzu.nativeAiandKeys,
  // No sessionLaunch: Jouzu derives its agent dir from JOUZU_HOME, which
  // also moves its sessions, state and first-run setup, so a throwaway
  // overlay would hide the user's history. `on` is the route.
  async openExtras({ args }) {
    // Jouzu starts on its project default or last-used model before
    // settings.json's defaultModel, so a model picked before `on` would
    // still decide. `aiand jouzu` names the ai& model `on` wired, for this
    // run only; nothing is written. Under --model native (no aiand
    // default provider) Jouzu's own choice stands.
    if (argsDecide(args)) return {};
    const settings = await readJsoncObject(jouzu.settingsPath()).catch(
      () => ({}) as Record<string, unknown>,
    );
    if (settings.defaultProvider !== PI_PROVIDER_ID) return {};
    if (typeof settings.defaultModel !== "string" || settings.defaultModel === "") return {};
    return { args: ["--provider", PI_PROVIDER_ID, "--model", settings.defaultModel] };
  },
};
