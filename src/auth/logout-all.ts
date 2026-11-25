import { lstat, readdir, readFile, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { findUnmarkedKeyDirs, HERMES_SHIM_HELD, sweepOverlays } from "../agents/overlays.js";
import { AGENTS, wiringCheckFor } from "../agents/registry.js";
import { scrubSnapshotKeys } from "../agents/snapshot.js";
import { revokeTokens } from "../api/device.js";
import { CliError, cancelled, EXIT } from "../cli/errors.js";
import { err, json, out, safeLine, style } from "../cli/output.js";
import { confirm, isInteractive } from "../cli/prompt.js";
import { redactSecrets } from "../cli/redact.js";
import {
  CONSOLE_KEYS_URL,
  CREDENTIAL_ORIGIN,
  clearCredential,
  configDir,
  issuerBinding,
  type LoadedCredential,
  loadAllCredentials,
  loadConfig,
  loadCredential,
  redactUrl,
  unprovenIssuer,
} from "../config.js";
import {
  CONFIG_MARKER_FILE,
  readConfigId,
  readMarkerId,
  SIGN_IN_STORE_FILES,
} from "../config-files.js";
import { agentHome, pathIsInside } from "../fsutil.js";
import { deleteSecret } from "../secrets.js";
import {
  provesAiandConfigDir,
  SIGN_IN_FILES,
  type WipePlan,
  type WipeResult,
  wipeConfigDir,
} from "./config-wipe.js";
import { classifySource } from "./identity.js";

/** Set to 1 to let `logout --all` delete a config dir outside the home directory. */
export const WIPE_OUTSIDE_HOME_ENV = "AIAND_WIPE_OUTSIDE_HOME";

export type LogoutAllOptions = {
  force?: boolean;
  keepRemote?: boolean;
  json?: boolean;
};

type ProfileOutcome = {
  profile: string;
  source: string;
  revoked: boolean;
  /** The revoke failed, so the sign-in stays for a retry: it is the only way to revoke the key. */
  kept?: true;
  error?: string;
  /** The HTTP status the issuer answered the revoke with, when it answered. */
  http_status?: number;
};

type AgentOutcome = {
  agent: string;
  stripped: boolean;
  notes?: string[];
  error?: string;
};

/**
 * Recovery for a refused dir that holds a sign-in. Login replaces a stored
 * sign-in without revoking it, so logging out comes first: once its refresh
 * token is overwritten, nothing here can revoke the key it minted.
 */
const LOG_OUT_FIRST =
  "first run aiand logout --profile <name> with AIAND_CONFIG_DIR set to it, for each profile its credentials.json names: that revokes each key aiand minted where it was issued, and a login there now would replace a sign-in without revoking it.";

/** An error's text for a report: it can quote a file or a response, so one safe line with no key in it. */
const message = (error: unknown): string =>
  redactSecrets(safeLine((error as Error)?.message ?? String(error)));

/**
 * The config dir `logout --all` will delete, canonicalised, or null when
 * there is none. Refuses the home directory itself, a filesystem root, and
 * (unless WIPE_OUTSIDE_HOME_ENV) anything outside home, before anything is
 * touched.
 */
async function wipeTarget(): Promise<string | null> {
  const configured = resolve(configDir());
  let real: string;
  try {
    real = await realpath(configured);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const home = await realpath(homedir()).catch(() => resolve(homedir()));
  if (real === home || dirname(real) === real) {
    throw new CliError(`Refusing to delete ${real}: it is not a config directory.`, {
      hint: "Point AIAND_CONFIG_DIR at aiand's own directory, then run aiand logout --all again.",
    });
  }
  if (!pathIsInside(home, real) && process.env[WIPE_OUTSIDE_HOME_ENV] !== "1") {
    throw new CliError(`Refusing to delete ${real}: it is outside your home directory (${home}).`, {
      hint: `If that really is aiand's config directory, run again with ${WIPE_OUTSIDE_HOME_ENV}=1.`,
    });
  }
  if (!(await provesAiandConfigDir(real))) {
    const names = await readdir(real).catch((): string[] => []);
    const signIn = names.some((name) => SIGN_IN_STORE_FILES.has(name));
    const unvouched = signIn && !names.includes("config.json");
    // The dir is unproven, so two ids here are two different ones.
    const otherId = (await readMarkerId(real)) !== null && (await readConfigId(real)) !== null;
    // aiand never rewrites a marker that names an id, so a login fixes a mismatch only once it is gone.
    const there = signIn ? "there" : "with AIAND_CONFIG_DIR set to it";
    const relogin = otherId
      ? `delete its ${CONFIG_MARKER_FILE} file, run aiand login ${there}, and run aiand logout --all again.`
      : `run aiand login ${there}, so aiand writes them, and run aiand logout --all again.`;
    throw new CliError(
      `Refusing to delete from ${real}: it is not aiand's config directory${unvouched ? ", or a sign-in there never finished: it holds sign-in files but no config.json" : ""}.`,
      {
        hint: `aiand's own directory has a config.json with a profile and profiles, and a ${CONFIG_MARKER_FILE} file carrying the same id as that config.json; aiand login writes both. A ${CONFIG_MARKER_FILE} file that is empty or copied from elsewhere proves nothing, and sign-in files (credentials.json, secret-store.*) count only beside that config.json.${otherId ? ` This one's config.json records another id than its ${CONFIG_MARKER_FILE} file, so one of them came from another install.` : ""} If it really is aiand's, ${signIn ? `${LOG_OUT_FIRST} Then ${relogin}` : relogin} Otherwise point AIAND_CONFIG_DIR at aiand's directory.`,
      },
    );
  }
  return real;
}

/**
 * Whether `target` is still the directory `wipeTarget` proved: the prompt, the
 * revokes and the agent strips between that proof and a deletion can take
 * seconds, and a path swapped for a link in the meantime (or a dir replaced by
 * another) would make the deletion follow it. The same checks run again, on
 * the path as it is now.
 */
async function targetUnchanged(target: string): Promise<boolean> {
  try {
    return (await wipeTarget()) === target;
  } catch {
    return false;
  }
}

const TARGET_CHANGED = (target: string): string =>
  `${target} is no longer the config directory logout --all checked, so nothing was deleted from it.`;

/** Delete what aiand keeps in the config dir, and a symlinked path to it once its target is gone. */
async function deleteConfigDir(real: string, plan: WipePlan): Promise<WipeResult> {
  if (!(await targetUnchanged(real))) throw new CliError(TARGET_CHANGED(real));
  const result = await wipeConfigDir(real, plan);
  const configured = resolve(configDir());
  if (result.removed && configured !== real) {
    if ((await lstat(configured).catch(() => null))?.isSymbolicLink()) {
      await unlink(configured).catch(() => {});
    }
  }
  return result;
}

/** Whether a file still holds one of `keys`; an unreadable one is not proof of anything. */
async function holdsKey(path: string, keys: readonly string[]): Promise<boolean> {
  const text = await readFile(path, "utf8").catch(() => "");
  return keys.some((key) => key.length > 0 && text.includes(key));
}

/**
 * Hand a machine back: revoke every key this CLI minted (best-effort, one
 * profile at a time), strip ai& from every agent whatever profile wired it,
 * delete stale launcher overlays, every stored secret (keychain included),
 * and the config dir with its snapshots. Pasted keys cannot be revoked from
 * here; they are listed with the console page that can. Exit 1 when any
 * step left something behind, after reporting all of it.
 */
export async function logoutAll(opts: LogoutAllOptions = {}): Promise<void> {
  // Refuse a bad target before anything is revoked or stripped.
  const target = await wipeTarget();
  const shownTarget = target ?? resolve(configDir());

  if (!opts.force) {
    if (!isInteractive()) {
      throw new CliError("logout --all signs out every profile and deletes aiand's local data.", {
        hint: "Pass --force to confirm when not at a terminal.",
      });
    }
    const yes = await confirm(
      `Sign out of every profile, remove ai& from every agent, and delete ${shownTarget}?`,
      { default: false },
    );
    if (!yes) throw cancelled();
  }

  const problems: string[] = [];
  let stored: Record<string, unknown> = {};
  // Without the credential list nothing can be revoked or told apart from a
  // sign-in that is still owed a revoke, so none of it is deleted.
  let credentialsUnreadable = false;
  try {
    stored = await loadAllCredentials();
  } catch (error) {
    credentialsUnreadable = true;
    problems.push(`Could not read stored credentials: ${message(error)}`);
  }
  let profileNames: string[] = [];
  try {
    profileNames = Object.keys(loadConfig().profiles);
  } catch (error) {
    problems.push(`Could not read config.json: ${message(error)}`);
  }
  const names = [...new Set([...Object.keys(stored), ...profileNames])];

  // Revoke first, while the refresh tokens are still here.
  const profiles: ProfileOutcome[] = [];
  const keys: string[] = [];
  /** Profiles whose sign-in is there but could not be read: kept, since nothing here can revoke what it cannot read. */
  const unreadable = new Set<string>();
  const keepUnreadable = (name: string, reason: string): void => {
    unreadable.add(name);
    profiles.push({
      profile: name,
      source: "unknown",
      revoked: false,
      kept: true,
      error: reason,
    });
  };
  if (credentialsUnreadable) {
    for (const name of profileNames) {
      keepUnreadable(name, "the stored credentials could not be read, so this sign-in was kept");
    }
  }
  for (const name of Object.keys(stored)) {
    let credential: LoadedCredential | null = null;
    try {
      credential = await loadCredential(name);
    } catch (error) {
      profiles.push({
        profile: name,
        source: "unknown",
        revoked: false,
        ...(opts.keepRemote ? {} : { kept: true as const }),
        error: message(error),
      });
      continue;
    }
    if (!credential) {
      keepUnreadable(
        name,
        "the stored credential could not be read (is the keychain locked?), so this sign-in was kept",
      );
      problems.push(`Could not read the stored credential for "${name}": its sign-in was kept.`);
      continue;
    }
    keys.push(credential.access_token);
    const outcome: ProfileOutcome = {
      profile: name,
      source: classifySource(credential),
      revoked: false,
    };
    profiles.push(outcome);
    if (credential.origin === CREDENTIAL_ORIGIN.PASTE || opts.keepRemote) continue;
    if (!credential.refresh_token) {
      outcome.error = "no refresh token was stored, so it cannot be revoked from here";
      continue;
    }
    try {
      const binding = await issuerBinding(name, credential);
      if (!binding) throw new Error(unprovenIssuer(name, "its key was not revoked").message);
      const issuer = binding.auth_url;
      const result = await revokeTokens(issuer, credential.refresh_token);
      outcome.revoked = result.revoked;
      if (result.status !== undefined) outcome.http_status = result.status;
      if (!result.revoked) {
        outcome.error =
          result.status === undefined
            ? "the server could not be reached"
            : `${safeLine(redactUrl(issuer))} answered HTTP ${result.status}`;
      }
    } catch (error) {
      outcome.error = message(error);
    }
    if (!outcome.revoked) outcome.kept = true;
  }
  const retained = new Set(profiles.filter((p) => p.kept).map((p) => p.profile));
  const keepSignIn = retained.size > 0 || credentialsUnreadable;
  const envKey = process.env.AIAND_API_KEY?.trim();
  if (envKey) keys.push(envKey);

  // The prompt and the revokes can take seconds. Before anything else reads
  // from or deletes in the config dir (the agent strips restore from its
  // snapshots), check it is still the dir that was proven; and again before
  // the deletions, which follow the strips.
  let targetMoved = false;
  const checkTarget = async (): Promise<void> => {
    if (targetMoved || target === null || (await targetUnchanged(target))) return;
    targetMoved = true;
    problems.push(TARGET_CHANGED(target));
  };
  await checkTarget();

  // Strip every agent. No loggingOut: whichever profile wired it, it goes.
  const agents: AgentOutcome[] = [];
  const keysLeft: string[] = [];
  // Agents `off` could not finish: what `on` recorded is what a retry needs.
  const unfinished = new Set<string>();
  for (const adapter of AGENTS) {
    if (adapter.launcherOnly || targetMoved) continue;
    let files: string[] = [];
    try {
      files = adapter.managedFiles();
    } catch {
      // Unknown locations are checked by nothing; disable() still runs.
    }
    try {
      // The guard `off` runs: an app that holds its config in memory rewrites
      // it on exit and puts the key back. Only an agent with something wired
      // is refused, so a running app we never touched does not block the wipe.
      if (
        adapter.offGuard &&
        (await adapter.probe().then(
          (p) => p.active,
          () => true,
        ))
      ) {
        await adapter.offGuard({ force: false });
      }
      const result = (await adapter.disable()) ?? { stripped: false };
      const notes = result.notes?.filter(Boolean) ?? [];
      agents.push({
        agent: adapter.id,
        stripped: result.stripped,
        ...(notes.length > 0 ? { notes } : {}),
      });
    } catch (error) {
      agents.push({ agent: adapter.id, stripped: false, error: message(error) });
      unfinished.add(adapter.id);
    }
    for (const file of files) {
      if (await holdsKey(file, keys)) {
        keysLeft.push(file);
        unfinished.add(adapter.id);
      }
    }
  }

  // What the sweep could not do is reported, never swallowed: a leftover
  // overlay holds the key, and an incomplete sweep must not read as complete.
  const overlays: {
    removed: string[];
    inUse: string[];
    failed: { dir: string; reason: string }[];
    /** Folders from an older aiand, with no marker, that still hold a key: deleted by hand, not by us. */
    unmarked: string[];
  } = { removed: [], inUse: [], failed: [], unmarked: [] };
  try {
    const swept = await sweepOverlays();
    overlays.removed.push(...swept.removed);
    overlays.inUse.push(...swept.inUse);
    overlays.failed.push(...swept.failed);
    const around = [
      target ?? resolve(configDir()),
      await realpath(agentHome()).catch(() => agentHome()),
    ];
    overlays.unmarked.push(...(await findUnmarkedKeyDirs(keys, around)));
  } catch (error) {
    problems.push(`Could not sweep leftover session overlays: ${message(error)}`);
  }
  await checkTarget();

  for (const name of targetMoved ? [] : names) {
    if (retained.has(name)) continue;
    try {
      // A kept sign-in leaves credentials.json in place, so a cleared one must leave it too.
      if (retained.size > 0 && Object.hasOwn(stored, name)) await clearCredential(name);
      else await deleteSecret(name);
    } catch (error) {
      problems.push(`Could not delete the stored secret for "${name}": ${message(error)}`);
    }
  }

  let wipe: WipeResult = { removed: false, left: [], kept: [] };
  if (target !== null && !targetMoved) {
    try {
      // A kept snapshot may hold a copy an older aiand made of a keyed file.
      if (unfinished.size > 0) await scrubSnapshotKeys(keys, wiringCheckFor).catch(() => []);
      wipe = await deleteConfigDir(target, {
        keep: keepSignIn ? SIGN_IN_FILES : new Set(),
        keepSnapshots: unfinished,
      });
    } catch (error) {
      problems.push(`Could not delete ${target}: ${message(error)}`);
    }
  }
  const left = wipe.left;

  const revokeFailed = profiles.filter(
    (profile) => profile.error !== undefined && profile.source !== "pasted-key",
  );
  const pasted = profiles.filter((profile) => profile.source === "pasted-key");
  const agentFailed = agents.filter((agent) => agent.error !== undefined);
  const complete =
    problems.length === 0 &&
    (opts.keepRemote || revokeFailed.length === 0) &&
    agentFailed.length === 0 &&
    keysLeft.length === 0 &&
    overlays.inUse.length === 0 &&
    overlays.failed.length === 0 &&
    overlays.unmarked.length === 0 &&
    !targetMoved &&
    left.length === 0;
  if (!complete) process.exitCode = EXIT.ERROR;

  if (envKey) {
    err(style.dim("The AIAND_API_KEY environment variable still applies until it is unset."));
  }

  if (opts.json) {
    return json({
      complete,
      profiles,
      ...(pasted.length > 0 ? { console_url: CONSOLE_KEYS_URL } : {}),
      agents,
      keys_left_on_disk: keysLeft,
      overlays: {
        removed: overlays.removed.length,
        in_use: overlays.inUse,
        failed: overlays.failed,
        unmarked_with_key: overlays.unmarked,
      },
      config_dir: { path: shownTarget, removed: wipe.removed, left, kept: wipe.kept },
      problems,
    });
  }

  out(
    complete
      ? style.green("Signed out everywhere and removed ai& from this machine.")
      : style.yellow(
          keepSignIn
            ? "Not everything could be cleaned up:"
            : "Signed out, but not everything could be cleaned up:",
        ),
  );
  for (const profile of profiles) {
    if (profile.source === "pasted-key") continue;
    if (profile.revoked) out(`  ${safeLine(profile.profile)}: key revoked`);
    else if (opts.keepRemote && !profile.kept) {
      out(`  ${safeLine(profile.profile)}: removed locally; the key stays valid`);
    } else out(`  ${safeLine(profile.profile)}: could not revoke the key (${profile.error})`);
  }
  if (pasted.length > 0) {
    out(
      `  Pasted keys are removed here but still valid: ${pasted.map((p) => safeLine(p.profile)).join(", ")}.`,
    );
    out(
      `  This CLI did not mint them, so it cannot revoke them. Revoke them at ${CONSOLE_KEYS_URL}`,
    );
  }
  if (unreadable.size > 0) {
    out(
      `  Could not read the sign-in for: ${[...unreadable].map(safeLine).join(", ")}, so it was kept. Unlock the keychain or fix the credential store, then run aiand logout --all again.`,
    );
  }
  const revocable = [...retained].filter((name) => !unreadable.has(name));
  if (revocable.length > 0) {
    out(
      `  Kept the sign-in for: ${revocable.map(safeLine).join(", ")}. Its refresh token is the only thing here that can revoke the key, so run aiand logout --all again when ai& is reachable.`,
    );
    out(
      `  To forget it here without revoking, run aiand logout --all --keep-remote, then revoke the key at ${CONSOLE_KEYS_URL}`,
    );
  } else if (revokeFailed.length > 0 && !opts.keepRemote) {
    out(`  Those keys are still valid: revoke them at ${CONSOLE_KEYS_URL}`);
  }
  for (const agent of agents) {
    if (agent.error) out(`  ${agent.agent}: could not strip its config (${agent.error})`);
    else if (agent.stripped) out(style.dim(`  ${agent.agent}: ai& removed`));
    for (const note of agent.notes ?? []) out(style.dim(`  ${agent.agent}: ${safeLine(note)}`));
  }
  for (const file of keysLeft) {
    out(`  An ai& key is still in ${safeLine(file)}; fix that file by hand and delete the key.`);
  }
  if (overlays.removed.length > 0) {
    out(style.dim(`  Deleted ${overlays.removed.length} leftover session overlay(s).`));
  }
  for (const dir of overlays.inUse) {
    out(
      `  A running aiand session still uses ${safeLine(dir)}; it is deleted when that session ends.`,
    );
  }
  for (const { dir, reason } of overlays.failed) {
    if (reason === HERMES_SHIM_HELD) {
      out(
        `  Kept the session overlay ${safeLine(dir)}: a Hermes shim still points into it, and deleting it would break your hermes command. Reinstall Hermes, then run aiand logout --all again.`,
      );
      continue;
    }
    out(
      `  Could not delete the session overlay ${safeLine(dir)} (${safeLine(reason)}); it may still hold your key. Delete it by hand.`,
    );
  }
  for (const dir of overlays.unmarked) {
    out(
      `  ${safeLine(dir)} looks like a leftover session folder from an older aiand and still holds your key; delete it by hand.`,
    );
  }
  if (target === null) {
    out(style.dim(`  ${safeLine(shownTarget)} did not exist.`));
  } else if (wipe.removed) {
    out(style.dim(`  Deleted ${safeLine(target)}.`));
  } else {
    for (const entry of wipe.kept.filter((name) => name.startsWith("snapshots/"))) {
      const agent = safeLine(String(entry.split("/")[1]));
      out(
        `  Kept ${safeLine(target)}/${safeLine(entry)}: ${agent} still has ai& wired in. Fix its config, run aiand ${agent} off, then run aiand logout --all again.`,
      );
    }
    if (left.length > 0) {
      out(
        `  Emptied ${safeLine(target)} of aiand's files but left it: it also holds ${left.map(safeLine).join(", ")}.`,
      );
    }
  }
  for (const problem of problems) out(`  ${problem}`);
}
