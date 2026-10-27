import { rebakeAgentKeys } from "../agents/rebake.js";
import { bool, type Parsed, parse, str } from "../cli/args.js";
import { CliError } from "../cli/errors.js";
import { err, fields, json, out, style } from "../cli/output.js";
import {
  activeProfileName,
  assertHttpsBaseUrl,
  assertNoV1Suffix,
  assertSafeProfileName,
  configPath,
  credentialsPath,
  loadConfig,
  loadCredential,
  resolveProfile,
  saveConfig,
  updateProfile,
} from "../config.js";
import {
  loadBudget,
  unsetBudgetKey as removeBudgetKey,
  setBudgetHarness,
  setBudgetMonthly,
  setBudgetWarnPct,
} from "../obs/budget.js";
import { storeCurrency } from "../obs/forecast.js";
import { routedAgents } from "./agent.js";

export const help = `${style.bold("aiand config")} -- inspect and change stored settings

Usage
  aiand config                     show the resolved settings
  aiand config path                print the config file locations
  aiand config set <key> <value>   change a setting on the active profile
  aiand config profiles            list profiles and which are signed in
  aiand config use <profile>       make a profile the default

Settable keys
  api-url            base URL for inference, catalog, logs, and usage
  auth-url           base URL for sign-in and account
  model              default model for run, chat, run-agent, and <agent> on
  budget.monthly     monthly spend budget, in the account's billing currency
  budget.harness.<n> per-harness budget override (unset falls back to monthly)
  budget.warn-pct    budget warning threshold percent (default 80)
  mcp.realProjectNames  let \`aiand mcp\` tools show real harness/project names
                     (default false: names are pseudonymized, project-a1b2)

Other commands
  aiand config get budget       print every budget key
  aiand config unset <key>      remove a stored setting (budget keys and model)

Budgets are advisory: cost-showing commands warn at warn-pct of budget, they
never block. Set budgets from real history with: aiand forecast --suggest-budget.

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
      return set(rest, parsed);
    case "get":
      return get(rest, parsed);
    case "unset":
      return unset(rest, parsed);
    case "profiles":
      return profiles(parsed);
    case "use":
      return use(rest[0], parsed);
    default:
      throw new CliError(`Unknown subcommand "${subcommand}".`, {
        hint: "Run `aiand config --help` to see the subcommands.",
      });
  }
}

async function show(parsed: Parsed): Promise<void> {
  const profile = resolveProfile(str(parsed, "profile"));
  const signedIn = Boolean(await loadCredential(profile.name));

  if (bool(parsed, "json")) {
    return json({ ...profile, signed_in: signedIn, config_path: configPath() });
  }

  fields([
    ["profile", profile.name],
    ["api url", profile.apiUrl],
    ["auth url", profile.authUrl],
    ["model", profile.model ?? style.dim("catalog preferred")],
    ["signed in", signedIn ? style.green("yes") : style.dim("no")],
  ]);
}

function paths(parsed: Parsed): void {
  if (bool(parsed, "json")) {
    json({ config: configPath(), credentials: credentialsPath() });
    return;
  }
  fields([
    ["config", configPath()],
    ["credentials", credentialsPath()],
  ]);
}

async function set(args: string[], parsed: Parsed): Promise<void> {
  const [key, ...valueParts] = args;
  const value = valueParts.join(" ");
  if (!key || !value) {
    throw new CliError("Both a key and a value are required.", {
      hint: "For example: aiand config set model zai-org/glm-5.3",
    });
  }

  // activeProfileName, not resolveProfile: a stored http URL must stay fixable
  // via `config set` instead of throwing before the new value lands.
  const name = activeProfileName(str(parsed, "profile"));

  // Budget keys are not profile-scoped: one account, one store, one budget.
  const budgetMatch = /^budget\.(.+)$/.exec(key);
  if (budgetMatch?.[1]) return setBudget(budgetMatch[1], value, key, parsed);

  switch (key) {
    case "api-url":
      assertHttpsBaseUrl(value);
      assertNoV1Suffix(value);
      await updateProfile(name, { apiUrl: value });
      break;
    case "auth-url":
      assertHttpsBaseUrl(value);
      assertNoV1Suffix(value);
      await updateProfile(name, { authUrl: value });
      break;
    case "model":
      await updateProfile(name, { model: value });
      break;
    default:
      if (key === "mcp.realProjectNames") {
        const real = value === "true" ? true : value === "false" ? false : null;
        if (real === null) {
          throw new CliError(`${key} must be "true" or "false" (got "${value}").`);
        }
        const config = loadConfig();
        await saveConfig({ ...config, mcp: { ...(config.mcp ?? {}), realProjectNames: real } });
        if (bool(parsed, "json")) return json({ key, value: real });
        out(
          style.green(
            real
              ? "MCP tools will show real harness/project names."
              : "MCP tools will pseudonymize harness/project names (project-a1b2).",
          ),
        );
        return;
      }
      throw new CliError(`"${key}" is not a settable key.`, {
        hint:
          "Settable keys: api-url, auth-url, model, budget.monthly, budget.harness.<name>, " +
          "budget.warn-pct, mcp.realProjectNames.",
      });
  }

  if (bool(parsed, "json")) {
    return json({ profile: name, key, value });
  }
  out(style.green(`Set ${key} = ${value} on profile "${name}".`));
}

/**
 * `config set budget.*` (ticket #74). Budget values are positive numbers in
 * the account's billing currency; `budget.monthly` records the currency
 * inferred from the store's cost rows — a mixed-currency store refuses with
 * a doctor-style verdict instead of guessing.
 */
async function setBudget(field: string, value: string, key: string, parsed: Parsed): Promise<void> {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new CliError(`${key} must be a number (got "${value}").`);
  }

  if (field === "monthly") {
    const currency = storeCurrency();
    await setBudgetMonthly(number, currency);
    if (bool(parsed, "json")) return json({ key, value: number, currency });
    out(style.green(`Set ${key} = ${number}${currency ? ` (${currency})` : ""}.`));
    return;
  }

  const harness = /^harness\.(.+)$/.exec(field);
  if (harness?.[1]) {
    await setBudgetHarness(harness[1], number);
    if (bool(parsed, "json")) return json({ key, value: number });
    out(style.green(`Set ${key} = ${number}.`));
    return;
  }

  if (field === "warn-pct") {
    await setBudgetWarnPct(number);
    if (bool(parsed, "json")) return json({ key, value: number });
    out(style.green(`Set ${key} = ${Math.round(number)}.`));
    return;
  }

  throw new CliError(`"${key}" is not a settable budget key.`, {
    hint: "Budget keys: budget.monthly, budget.harness.<name>, budget.warn-pct.",
  });
}

/**
 * `aiand config get budget` — every budget key, unset ones as "not set".
 * `config get` with no key prints the same thing (budgets are the only
 * non-profile settings today).
 */
function get(args: string[], parsed: Parsed): void {
  const [key] = args;
  if (key !== undefined && key !== "budget" && key !== "mcp" && key !== "mcp.realProjectNames") {
    throw new CliError(`"${key}" is not a gettable key.`, {
      hint: "Gettable keys: budget, mcp, mcp.realProjectNames.",
    });
  }

  if (key === "mcp" || key === "mcp.realProjectNames") {
    const config = loadConfig();
    const real = config.mcp?.realProjectNames === true;
    if (bool(parsed, "json")) {
      json({ real_project_names: real });
      return;
    }
    fields([["mcp.realProjectNames", String(real)]]);
    return;
  }

  const budget = loadBudget();
  const harnessKeys = Object.keys(budget.harness).sort();
  const rows = [
    ["budget.monthly", budget.monthly === null ? null : String(budget.monthly)],
    ...harnessKeys.map((name) => [`budget.harness.${name}`, String(budget.harness[name])]),
    ["budget.warn-pct", String(budget.warnPct)],
    ["budget currency", budget.currency],
  ] as [string, string | null][];

  if (bool(parsed, "json")) {
    json({
      monthly: budget.monthly,
      harness: budget.harness,
      warn_pct: budget.warnPct,
      currency: budget.currency,
    });
    return;
  }

  fields(rows.map(([k, v]) => [k, v ?? style.dim("not set")] as [string, string]));
}

/**
 * `aiand config unset budget.monthly` and friends — negatable parity with
 * `config set`. Only budget keys are unsettable today.
 */
async function unset(args: string[], parsed: Parsed): Promise<void> {
  const [key] = args;
  if (!key) {
    throw new CliError("A key is required.", {
      hint: "For example: aiand config unset budget.monthly",
    });
  }
  if (key === "mcp.realProjectNames") {
    const config = loadConfig();
    await saveConfig({ ...config, mcp: { ...(config.mcp ?? {}), realProjectNames: undefined } });
    if (bool(parsed, "json")) return json({ key, removed: true });
    out(style.green(`Unset ${key}.`));
    return;
  }
  if (!key.startsWith("budget.")) {
    throw new CliError(`"${key}" is not an unsettable key.`, {
      hint: "Unsettable keys: budget.monthly, budget.warn-pct, budget.harness.<name>, mcp.realProjectNames.",
    });
  }
  await removeBudgetKey(key);
  if (bool(parsed, "json")) return json({ key, removed: true });
  out(style.green(`Unset ${key}.`));
}

async function profiles(parsed: Parsed): Promise<void> {
  const config = loadConfig();
  const rows: { name: string; active: boolean; signed_in: boolean }[] = [];
  for (const name of Object.keys(config.profiles)) {
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

async function use(name: string | undefined, parsed: Parsed): Promise<void> {
  if (!name) {
    throw new CliError("Which profile?", { hint: "aiand config use <profile>" });
  }
  assertSafeProfileName(name);
  const config = loadConfig();
  if (!config.profiles[name]) {
    config.profiles[name] = {};
  }
  config.profile = name;
  await saveConfig(config);

  // Agents hold the key baked at `on`, so switching profiles rebakes the
  // target's key, or warns when agents are on and it has none. While the env
  // key is set it is the session, so nothing is swapped.
  if (!process.env.AIAND_API_KEY?.trim()) {
    const credential = await loadCredential(name);
    if (credential) {
      const notes = await rebakeAgentKeys(credential.access_token);
      for (const note of notes) {
        err(style.dim(`[${note.agent}] ${note.note}`));
      }
    } else if ((await routedAgents("exclude")).length > 0) {
      err(
        style.dim(
          `Switched to "${name}" with no stored credential; baked keys in agent configs were left in place. Run \`aiand login\` or \`aiand <agent> off\` to strip them.`,
        ),
      );
    }
  }

  if (bool(parsed, "json")) {
    return json({ profile: name });
  }
  out(style.green(`Using profile "${name}".`));
}
