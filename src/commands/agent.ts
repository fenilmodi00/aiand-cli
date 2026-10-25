import { installIfMissing, runAgentBinary } from "../agents/launch.js";
import { AGENTS } from "../agents/registry.js";
import { agentOff, agentOn, agentSession, agentStatus } from "../agents/setup.js";
import type { AgentAdapter, Verb } from "../agents/types.js";
import { requireSessionKey } from "../auth/session.js";
import { bool, type Parsed, parse, str } from "../cli/args.js";
import { CliError } from "../cli/errors.js";
import { err, fields, json, out, style } from "../cli/output.js";
import { agentHome, resolveProfile } from "../config.js";

const VERBS: Verb[] = ["on", "off", "status"];

export function agentHelp(adapter: AgentAdapter): string {
  const flags = [
    "      --model <id>        model to route (default: catalog preferred)",
    "      --session           run on ai& for one session; writes no config",
    "      --force             escape quit-guards when the app holds config in memory",
    "      --json              machine-readable output",
    "      --profile <name>    use a stored profile",
    "      --base-url <url>    point at a different API endpoint",
    "  -h, --help              show this help",
  ].join("\n");

  const files = adapter
    .managedFiles()
    .map((file) => `  ${file.replace(agentHome(), "~")}`)
    .join("\n");

  const openUsage = adapter.configOnly
    ? `  aiand [--profile <name>] ${adapter.id}`
    : `  aiand [--profile <name>] ${adapter.id} [args…]`;
  const openPara = adapter.configOnly
    ? `  With no verb, aiand wires ${adapter.label} to ai& (a missing agent prints its install command; npm installs run after a yes). Then open the GitHub Copilot app yourself and pick the ai& model in its model menu.`
    : `  With no verb, aiand opens ${adapter.label} on ai&: a missing agent prints its install command (npm installs run after a yes), it wires it with \`on\` when it is not wired yet, then runs ${adapter.bin} with your args verbatim. Put aiand's own flags before the agent name, and \`--\` before an arg that is a verb. \`--session\` skips the wiring entirely: the agent runs on ai& for one session, and nothing is written to your config.`;
  return `${style.bold(`aiand ${adapter.id}`)} -- ${adapter.label} on ai&

Usage
${openUsage}
  aiand ${adapter.id} on|off|status [options]

${openPara}

Verbs
  on       wire ${adapter.label} to ai&
  off      remove aiand routing (keeps your edits)
  status   show whether ${adapter.label} is wired to ai&

Options
${flags}

${files === "" ? "" : `Config files\n${files}\n\n`}Install
  Install it with: ${adapter.install.command}
  See: ${adapter.install.url}`;
}

export async function runAgentCommand(
  adapter: AgentAdapter,
  argv: string[],
  globalArgs: string[] = [],
): Promise<void> {
  const [first] = argv;
  // Everything after the first `--` is the agent's own argv, byte-for-byte:
  // a `--session` in there belongs to the agent, not to aiand (the same rule
  // that lets `aiand claude -- on` open on the "on" verb).
  const sep = argv.indexOf("--");
  const head = sep === -1 ? argv : argv.slice(0, sep);
  // `--session` is aiand's own flag even on the open path, so it is stripped
  // from what the agent sees; a `--session` after `--` is the agent's.
  const tail = sep === -1 ? [] : argv.slice(sep + 1);
  const own = head.filter((token) => token !== "--session");
  const passthrough = first === "--" ? tail : [...own, ...tail];

  if (first !== "-h" && first !== "--help" && !VERBS.includes(first as Verb)) {
    return runOpen(adapter, passthrough, globalArgs, head.includes("--session"));
  }

  // Only agent-specific flags here; json/profile/base-url/help come from
  // GLOBAL_OPTIONS so `-h` keeps its short (see args.ts preserve-short).
  // The tail is the agent's own argv, so its flags never reach the parser:
  // `aiand <agent> on -- --session` is the agent's flag, not a wiring mode.
  const options = {
    model: { type: "string" },
    force: { type: "boolean", default: false },
    session: { type: "boolean", default: false },
  } as const;
  const parsed = parse([...head, ...globalArgs], options);

  if (bool(parsed, "help")) return out(agentHelp(adapter));

  if (parsed.positionals.length > 1) {
    throw new CliError("Agent command takes at most one verb.", {
      hint: `You passed: ${parsed.positionals.join(" ")}\nVerbs: on, off, status`,
    });
  }
  const jsonOut = bool(parsed, "json");

  switch (first as Verb) {
    case "on":
      return runOn(adapter, parsed, jsonOut);
    case "off":
      return runOff(adapter, parsed, jsonOut);
    case "status":
      return runStatus(adapter, jsonOut);
  }
}

/** The one line printed after a --session spawn, so it is never a surprise. */
const SESSION_NOTE = "This session ran on ai&; your config was not changed.";

async function runOpen(
  adapter: AgentAdapter,
  passthrough: string[],
  globalArgs: string[],
  session: boolean,
): Promise<void> {
  const target = parse(globalArgs);
  const profile = str(target, "profile");
  const retarget = profile !== undefined || str(target, "base-url") !== undefined;
  // --session lives after the agent name, so the agent's own args pass
  // through untouched; it is matched from aiand's side of `--` and consumed,
  // never forwarded to the agent.
  if (session) {
    const model = await agentSession(adapter, { profile, passthrough, install: true });
    // `--json` is a leading global (`aiand --json claude --session`); the
    // flagged form after the agent name arrives here inside `globalArgs`
    // too, so parse the batch rather than assuming one position.
    if (parse(globalArgs).values.json === true) {
      json({ agent: adapter.id, mode: "session", model, files: [] });
    }
    err(style.dim(SESSION_NOTE));
    return;
  }
  await installIfMissing(adapter);
  if (retarget || !(await adapter.probe()).active) {
    const result = await agentOn(adapter, { profile });
    err(style.green(`${adapter.label} is now using ai&.`));
    for (const warning of result.warnings) err(style.dim(warning));
  } else {
    await requireSessionKey();
  }
  if (adapter.configOnly) {
    if (passthrough.length > 0) {
      throw new CliError(
        `The ${adapter.label} is a desktop app; aiand wires it but cannot launch it.`,
        {
          hint: "aiand copilot runs the GitHub Copilot CLI.",
        },
      );
    }
    out("Open the GitHub Copilot app and pick the ai& model in its model menu.");
    return;
  }
  const extras =
    (await adapter.openExtras?.({
      args: passthrough,
      profileModel: resolveProfile(profile).model,
    })) ?? {};
  // Same precedent as run-agent.ts: the adapter injection carries the key, so the spawn env starts scrubbed.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.AIAND_API_KEY;
  // Same drop as run-agent: names the adapter lists would outrank the
  // config `on` just wrote (Hermes reads ANTHROPIC_* / OPENAI_* over its files).
  for (const key of adapter.shadowEnv ?? []) delete env[key];
  Object.assign(env, extras.env);
  await runAgentBinary(adapter, [...(extras.args ?? []), ...passthrough], env);
}

async function runOn(adapter: AgentAdapter, parsed: Parsed, jsonOut: boolean): Promise<void> {
  if (bool(parsed, "session")) {
    const result = await agentSession(adapter, {
      model: str(parsed, "model"),
      profile: str(parsed, "profile"),
    });
    if (jsonOut) json({ agent: adapter.id, mode: "session", model: result, files: [] });
    err(style.dim(SESSION_NOTE));
    return;
  }
  const result = await agentOn(adapter, {
    model: str(parsed, "model"),
    force: bool(parsed, "force"),
    profile: str(parsed, "profile"),
  });

  if (jsonOut) {
    return json(result);
  }
  out(style.green(`${adapter.label} is now using ai&.`));
  fields([
    ["agent", result.agent],
    ["model", result.model],
    ["files", result.files.join(", ")],
  ]);
  for (const warning of result.warnings ?? []) {
    err(style.dim(warning));
  }
}

async function runOff(adapter: AgentAdapter, parsed: Parsed, jsonOut: boolean): Promise<void> {
  const result = await agentOff(adapter, { force: bool(parsed, "force") });
  if (jsonOut) {
    return json(result);
  }
  if (result.note) {
    out(style.dim(result.note));
    return;
  }
  out(`${adapter.label} is off.`);
}

async function runStatus(adapter: AgentAdapter, jsonOut: boolean): Promise<void> {
  const result = await agentStatus(adapter);
  if (jsonOut) {
    return json(result);
  }

  const modelLabel: string = result.model ?? style.dim("—");
  fields([
    ["agent", result.agent],
    ["installed", result.installed ? (result.binary ?? style.dim("yes")) : style.dim("no")],
    ["state", stateLabel(result.state)],
    ["model", modelLabel],
  ]);
  if (!result.installed) {
    err(style.dim(`Install it with: ${adapter.install.command}  See: ${adapter.install.url}`));
  }
}

/**
 * Registered agents whose real config probes as aiand-routed. Launcher-only
 * adapters are never wired by `on`, so they are never routed. A probe that
 * throws is either counted (`"include"`: `init --off` then attempts `off` and
 * reports that agent's failure instead of aborting the batch) or ignored
 * (`"exclude"`: an unreadable config does not block a profile switch).
 */
export async function routedAgents(probeFailure: "include" | "exclude"): Promise<AgentAdapter[]> {
  const routed: AgentAdapter[] = [];
  for (const adapter of AGENTS) {
    if (adapter.launcherOnly) continue;
    try {
      if ((await adapter.probe()).active) routed.push(adapter);
    } catch {
      if (probeFailure === "include") routed.push(adapter);
    }
  }
  return routed;
}

/** Colored on/off for an agent's routing state (agent status and aiand status). */
export function stateLabel(state: "on" | "off"): string {
  switch (state) {
    case "on":
      return style.green("on");
    case "off":
      return style.dim("off");
  }
}
