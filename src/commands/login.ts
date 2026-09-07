import { parse, bool, str, type Parsed } from "../cli/args.js";
import { err, fields, out, style, spinner } from "../cli/output.js";
import { openBrowser } from "../cli/browser.js";
import { CliError } from "../cli/errors.js";
import { confirm, isInteractive, readSecret } from "../cli/prompt.js";
import {
  loadConfig,
  loadCredential,
  maskKey,
  resolveProfile,
  saveConfig,
  saveCredential,
  updateProfile,
} from "../config.js";
import {
  pollForToken,
  startDeviceAuthorization,
  verificationUrl,
} from "../api/device.js";
import { openSession } from "../api/client.js";
import { getUser, listOrgs, validateKey } from "../api/account.js";
import { readStdin } from "../cli/stdin.js";
import { rebakeAgentKeys } from "../agents/sync.js";

/**
 * After a fresh credential is stored, rebake it into every active agent config
 * and print one dim stderr line per note (silently skip when nothing changed).
 */
async function rebakeIntoAgents(key: string): Promise<void> {
  const notes = await rebakeAgentKeys(key);
  for (const note of notes) {
    err(style.dim(`[${note.agent}] ${note.note}`));
  }
}

export const help = `${style.bold("aiand login")} -- sign in with a browser approval, or store a key you already have

Usage
  aiand login [options]

Options
  --base-url <url>    point at a different API endpoint
  --profile <name>    store the session under this profile
  --no-browser        print the URL instead of opening it
  --force             sign in again even if this profile already has a session
  --paste             paste an existing ai& API key (masked input)
  --api-key <sk-...>  store a key passed on the command line
  --with-token        read the key from stdin (aiand login --with-token < key.txt)

The default path mints an org-scoped API key via a browser approval. Paste paths
validate the key against the API first; a pasted key is never rotated or revoked
by this CLI.`;

async function readPastedKey(parsed: Parsed): Promise<string> {
  if (bool(parsed, "paste")) {
    // Three attempts: a mis-typed paste should not force a full restart.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const key = await readSecret("Paste your ai& API key (sk-…): ");
      if (!/^sk-/.test(key)) {
        err(style.red(`Keys start with "sk-" (attempt ${attempt} of 3).`));
        continue;
      }
      return key;
    }
    throw new CliError("Three invalid keys in a row — giving up.");
  }

  const apiKey = str(parsed, "api-key");
  if (apiKey !== undefined) {
    if (!/^sk-/.test(apiKey)) {
      throw new CliError('Keys start with "sk-".', { hint: "Check the key and try again." });
    }
    return apiKey;
  }

  const piped = await readStdin();
  if (piped === null) {
    throw new CliError("Pipe the key: aiand login --with-token < key.txt");
  }
  if (!/^sk-/.test(piped)) {
    throw new CliError('Keys start with "sk-".', { hint: "Check the key and try again." });
  }
  return piped;
}
async function storePastedKey(
  key: string,
  authUrl: string,
  profileName: string
): Promise<{ user: { id: string; email: string }; storage: string }> {
  const user = await validateKey(key, authUrl);
  await saveCredential(profileName, {
    access_token: key,
    origin: "paste",
    user,
  });
  // saveCredential records the tier the store actually used (a keychain write
  // can fall back to the encrypted file); report that, not a guess.
  const stored = await loadCredential(profileName);
  return { user, storage: stored?.storage ?? "file" };
}

async function runDeviceLogin(argvOptions: Parsed): Promise<void> {
  const profile = resolveProfile(str(argvOptions, "profile"));

  const device = await startDeviceAuthorization(profile.authUrl);
  const url = verificationUrl(profile.authUrl, device);

  out();
  out(`  ${style.dim("Your code ")}  ${style.bold(style.cyan(device.user_code))}`);
  out(`  ${style.dim("Approve at")}  ${style.blue(url)}`);
  out();

  if (bool(argvOptions, "no-browser")) {
    err(style.dim("Open the URL above to continue."));
  } else if (!openBrowser(url)) {
    err(style.dim("Could not open a browser -- open the URL above to continue."));
  }

  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once("SIGINT", onInterrupt);

  const spin = spinner("Waiting for approval in the browser...");
  let tokens;
  try {
    tokens = await pollForToken(profile.authUrl, device, {
      signal: controller.signal,
      onSlowDown: (interval) => err(style.dim(`Server asked us to back off; polling every ${interval}s.`)),
    });
  } finally {
    spin.stop();
    process.removeListener("SIGINT", onInterrupt);
  }

  await saveCredential(profile.name, {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + tokens.expires_in,
    origin: "device",
  });

  const config = loadConfig();
  updateProfile(profile.name, {});
  if (config.profile !== profile.name) {
    saveConfig({ ...loadConfig(), profile: profile.name });
  }

  const session = await openSession(resolveProfile(profile.name));
  const [user, orgs] = await Promise.all([getUser(session), listOrgs(session)]);
  const org = orgs[0];
  const stored = await loadCredential(profile.name);
  if (!stored) throw new CliError("Session vanished while signing in.");
  await saveCredential(profile.name, {
    ...stored,
    user,
    ...(org ? { org } : {}),
  });

  await rebakeIntoAgents(session.token);

  if (bool(argvOptions, "json")) {
    return out(
      JSON.stringify({ profile: profile.name, user, org: org ?? null, key: maskKey(session.token) }, null, 2)
    );
  }

  out(style.green("Signed in."));
  out();
  fields([
    ["email", user.email || style.dim("unknown")],
    ["org", org ? `${org.name} ${style.dim(`(${org.id})`)}` : style.dim("none")],
    ["profile", profile.name],
    ["key", style.dim(maskKey(session.token))],
  ]);
}

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    "no-browser": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    paste: { type: "boolean", default: false },
    "api-key": { type: "string" },
    "with-token": { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  const pasteMode = bool(parsed, "paste") || str(parsed, "api-key") !== undefined || bool(parsed, "with-token");
  const profile = resolveProfile(str(parsed, "profile"));

  if (!bool(parsed, "force") && (await loadCredential(profile.name))) {
    if (isInteractive()) {
      const existing = await loadCredential(profile.name);
      const email = existing?.user?.email ?? "unknown";
      const again = await confirm(`Profile ${profile.name} is already signed in as ${email}. Sign in again?`, {
        default: false,
      });
      if (!again) {
        out("Keeping the existing session.");
        return;
      }
    } else {
      throw new CliError(`Profile "${profile.name}" is already signed in.`, {
        hint: "Run `aiand whoami` to see who, or `aiand login --force` to replace it.",
      });
    }
  }

  if (process.env.AIAND_API_KEY) {
    err(style.yellow("AIAND_API_KEY is set; it takes precedence over the stored session until unset."));
  }

  if (pasteMode) {
    const key = await readPastedKey(parsed);
    const { user, storage } = await storePastedKey(key, profile.authUrl, profile.name);

    const config = loadConfig();
    updateProfile(profile.name, {});
    if (config.profile !== profile.name) {
      saveConfig({ ...loadConfig(), profile: profile.name });
    }

    if (bool(parsed, "json")) {
      return out(JSON.stringify({ profile: profile.name, source: "pasted-key", storage }, null, 2));
    }

    await rebakeIntoAgents(key);

    out(style.green("Signed in with a pasted key."));
    out();
    fields([
      ["email", user.email || style.dim("unknown")],
      ["profile", profile.name],
      ["source", "pasted key"],
      ["storage", storage],
    ]);
    return;
  }

  return runDeviceLogin(parsed);
}
