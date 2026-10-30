import { getCatalog, validateCatalogModel } from "../agents/catalog.js";
import { dropOwnedFlags, notInstalledError, runAgentBinary } from "../agents/launch.js";
import { AGENTS, findAgent } from "../agents/registry.js";
import { requireSessionKey } from "../auth/session.js";
import { CliError } from "../cli/errors.js";
import { out, style } from "../cli/output.js";
import { assertHttpsBaseUrl, assertNoV1Suffix, resolveProfile } from "../config.js";

// Aligns agent labels with the Options column below.
const HELP_ID_WIDTH = 28;

export const help = `${style.bold("aiand run-agent")} -- run a coding agent on ai& for one session

Usage
  aiand run-agent <agent> [--model <id>] [--] [args…]

Agents
${AGENTS.map((a) => `  ${a.id.padEnd(HELP_ID_WIDTH)} ${a.label}`).join("\n")}

Options
      --model <id>       model from the catalog (default: the agent's own)
      --profile <name>   use a stored profile
      --base-url <url>   point at a different API endpoint
  -h, --help             show this help

Everything after \`--\` (and any bare positional before it) is passed to the
agent's binary as-is, except the routing flags the adapter owns — those are
stripped so the injected wiring cannot be overridden.

Try: aiand run-agent opencode -- --version`;

type Invocation = {
  agent: string | undefined;
  model: string | undefined;
  profile: string | undefined;
  baseUrl: string | undefined;
  help: boolean;
  passthrough: string[];
};

/**
 * Split raw argv without the strict parse() (the trailing args must reach the
 * agent's binary byte-for-byte, including unknown flags). The first `--` is
 * the hard boundary: everything before it is ours unless we don't recognize
 * it (then it is prepended to the passthrough), everything after is
 * passthrough verbatim.
 */
function splitInvocation(argv: string[]): Invocation {
  const sep = argv.indexOf("--");
  const head = sep === -1 ? argv : argv.slice(0, sep);
  const tail = sep === -1 ? [] : argv.slice(sep + 1);

  let agent: string | undefined;
  let model: string | undefined;
  let profile: string | undefined;
  let baseUrl: string | undefined;
  let help = false;
  const prepend: string[] = [];

  let i = 0;
  while (i < head.length) {
    const token = head[i]!;
    if (agent === undefined && !token.startsWith("-")) {
      agent = token;
      i += 1;
      continue;
    }
    if (token === "--help" || token === "-h") {
      help = true;
      i += 1;
    } else if (token === "--model") {
      model = takeValue(head, i, "--model");
      i += 2;
    } else if (token.startsWith("--model=")) {
      model = inlineValue(token, "--model");
      i += 1;
    } else if (token === "--profile") {
      profile = takeValue(head, i, "--profile");
      i += 2;
    } else if (token.startsWith("--profile=")) {
      profile = inlineValue(token, "--profile");
      i += 1;
    } else if (token === "--base-url") {
      baseUrl = takeValue(head, i, "--base-url");
      i += 2;
    } else if (token.startsWith("--base-url=")) {
      baseUrl = inlineValue(token, "--base-url");
      i += 1;
    } else {
      // Anything unrecognized before the separator (flags we don't own, bare
      // positionals) is still the agent's, prepended ahead of the tail args.
      prepend.push(token);
      i += 1;
    }
  }

  return { agent, model, profile, baseUrl, help, passthrough: [...prepend, ...tail] };
}

function takeValue(head: string[], i: number, name: string): string {
  const value = head[i + 1];
  if (value === undefined) throw new CliError(`${name} needs a value.`);
  return value;
}

function inlineValue(token: string, name: string): string {
  const value = token.slice(name.length + 1);
  if (!value) throw new CliError(`${name} needs a value.`);
  return value;
}

export async function run(argv: string[]): Promise<void> {
  const split = splitInvocation(argv);
  if (split.help) {
    out(help);
    return;
  }
  if (split.baseUrl !== undefined) {
    assertHttpsBaseUrl(split.baseUrl);
    // Like `--base-url` at parse time (args.ts) and `config set api-url`:
    // adapters append /v1 themselves, so a suffixed URL doubles to
    // /v1/v1/... and the gateway misdiagnoses it as an expired key.
    assertNoV1Suffix(split.baseUrl);
    process.env.AIAND_BASE_URL = split.baseUrl;
  }

  const agentName = split.agent;
  if (!agentName) {
    throw new CliError("run-agent needs a coding agent name.", {
      hint: "Usage: aiand run-agent <agent> [--model <id>] [--] [args…]\nTry: aiand run-agent opencode -- --version",
    });
  }

  const adapter = findAgent(agentName);
  if (!adapter) {
    throw new CliError(`Unknown agent "${agentName}".`, {
      hint: `Agents: ${AGENTS.map((a) => a.id).join(", ")}`,
    });
  }

  // Detect before resolving a session: a missing binary exits 127 with an
  // Install hint, never a login ceremony for a binary that isn't there.
  if (!adapter.detect().installed) throw notInstalledError(adapter);

  // Capability before session, for the same reason: no sign-in for a launch
  // this adapter cannot do.
  if (!adapter.sessionLaunch) {
    throw new CliError(`${adapter.label} does not support session launches.`, {
      hint: `Run \`aiand ${adapter.id} on\` for permanent wiring.`,
    });
  }

  const session = await requireSessionKey(split.profile);

  const profile = resolveProfile(split.profile);
  const baseUrl = profile.apiUrl;
  const catalog = await getCatalog(baseUrl);

  // --model is validated against the live catalog; without it the adapter
  // picks, with the profile default on hand for adapters that need one.
  // Adapters that opt in via allowUnpinnedModel read the literal "native"
  // as "leave the model unpinned"; every other adapter keeps the ordinary
  // catalog-membership error for it.
  const unpinned = split.model === "native" && adapter.allowUnpinnedModel === true;
  if (split.model !== undefined && !unpinned) validateCatalogModel(catalog, split.model);

  const launch = await adapter.sessionLaunch({
    apiKey: session.key,
    model: split.model,
    profileModel: profile.model,
    profileName: profile.name,
    catalog,
    baseUrl,
  });

  // Child env = inherited, plus the adapter's own injection.
  const env: NodeJS.ProcessEnv = { ...process.env };
  // The adapter's own injection carries the key; a leaked AIAND_API_KEY would hand it to every process the agent spawns.
  delete env.AIAND_API_KEY;
  // Adapters that route outside the child env list the inherited names that
  // would shadow that routing; the launcher drops them so its own injection wins.
  for (const k of adapter.shadowEnv ?? []) delete env[k];
  Object.assign(env, launch.env);

  // The adapter may own routing flags in the passthrough (e.g. Pi's
  // --provider/--model/--api-key): drop the user's `--flag value` and
  // `--flag=value` forms so the injected routing cannot be overridden.
  // Everything else passes verbatim.
  const passthrough = dropOwnedFlags(split.passthrough, launch.stripPassthroughFlags);

  await runAgentBinary(adapter, [...(launch.args ?? []), ...passthrough], env, launch.cleanup);
}
