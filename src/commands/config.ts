import { parse, bool, str } from "../cli/args.js";
import { fields, json, out, style } from "../cli/output.js";
import { CliError } from "../cli/errors.js";
import {
  configPath,
  credentialsPath,
  loadConfig,
  loadCredential,
  resolveProfile,
  saveConfig,
  updateProfile,
} from "../config.js";

export const help = `${style.bold("aiand config")} -- inspect and change stored settings

Usage
  aiand config                     show the resolved settings
  aiand config path                print the config file locations
  aiand config set <key> <value>   change a setting on the active profile
  aiand config profiles            list profiles and which are signed in
  aiand config use <profile>       make a profile the default

Settable keys
  api-url   base URL for inference, catalog, logs, and usage
  auth-url  base URL for sign-in and account
  model     default model for run/chat

Environment variables override stored settings: AIAND_API_KEY, AIAND_BASE_URL,
AIAND_AUTH_URL, AIAND_PROFILE, AIAND_CONFIG_DIR.`;

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv);
  if (bool(parsed, "help")) return out(help);

  const [subcommand, ...rest] = parsed.positionals;

  switch (subcommand) {
    case undefined:
      return show(parsed);
    case "path":
      return paths(parsed);
    case "set":
      return set(rest);
    case "profiles":
      return profiles(parsed);
    case "use":
      return use(rest[0]);
    default:
      throw new CliError(`Unknown subcommand "${subcommand}".`, {
        hint: "Run `aiand config --help` to see the subcommands.",
      });
  }
}

async function show(parsed: ReturnType<typeof parse>): Promise<void> {
  const profile = resolveProfile(str(parsed, "profile"));
  const signedIn = Boolean(await loadCredential(profile.name));

  if (bool(parsed, "json")) {
    return json({ ...profile, signed_in: signedIn, config_path: configPath() });
  }

  fields([
    ["profile", profile.name],
    ["api url", profile.apiUrl],
    ["auth url", profile.authUrl],
    ["model", profile.model ?? style.dim("auto")],
    ["signed in", signedIn ? style.green("yes") : style.dim("no")],
  ]);
}

function paths(parsed: ReturnType<typeof parse>): void {
  if (bool(parsed, "json")) {
    return json({ config: configPath(), credentials: credentialsPath() });
  }
  fields([
    ["config", configPath()],
    ["credentials", credentialsPath()],
  ]);
}

function set(args: string[]): void {
  const [key, ...valueParts] = args;
  const value = valueParts.join(" ");
  if (!key || !value) {
    throw new CliError("Both a key and a value are required.", {
      hint: "For example: aiand config set model auto",
    });
  }

  const name = resolveProfile().name;

  switch (key) {
    case "api-url":
      updateProfile(name, { apiUrl: value });
      break;
    case "auth-url":
      updateProfile(name, { authUrl: value });
      break;
    case "model":
      updateProfile(name, { model: value });
      break;
    default:
      throw new CliError(`"${key}" is not a settable key.`, {
        hint: "Settable keys: api-url, auth-url, model.",
      });
  }

  out(style.green(`Set ${key} = ${value} on profile "${name}".`));
}

async function profiles(parsed: ReturnType<typeof parse>): Promise<void> {
  const config = loadConfig();
  const rows: { name: string; active: boolean; signed_in: boolean }[] = [];
  for (const [name] of Object.entries(config.profiles)) {
    rows.push({
      name,
      active: name === config.profile,
      signed_in: Boolean(await loadCredential(name)),
    });
  }

  if (bool(parsed, "json")) return json(rows);

  for (const row of rows) {
    const marker = row.active ? style.green("*") : " ";
    const status = row.signed_in ? style.green("signed in") : style.dim("signed out");
    out(`${marker} ${row.name}  ${status}`);
  }
}

function use(name: string | undefined): void {
  if (!name) {
    throw new CliError("Which profile?", { hint: "aiand config use <profile>" });
  }
  const config = loadConfig();
  if (!config.profiles[name]) {
    config.profiles[name] = {};
  }
  config.profile = name;
  saveConfig(config);
  out(style.green(`Using profile "${name}".`));
}
