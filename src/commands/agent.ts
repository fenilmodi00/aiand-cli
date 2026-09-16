import { bool, parse, str, type Parsed } from "../cli/args.js";
import { err, fields, json, out, style } from "../cli/output.js";
import { CliError } from "../cli/errors.js";
import { agentOn, agentOff, agentStatus } from "../agents/setup.js";
import { agentHome } from "../config.js";
import type { AgentAdapter, Verb } from "../agents/types.js";

const VERBS: Verb[] = ["on", "off", "status"];

function agentHelp(adapter: AgentAdapter): string {
  const flags = [
    "  --model <id>           model to route (default: catalog preferred)",
    "  --force                overwrite a config another tool manages",
    "      --json              machine-readable output",
    "      --profile <name>    use a stored profile",
    "      --base-url <url>    point at a different API endpoint",
    "  -h, --help              show this help",
  ].join("\n");

  const files = adapter.managedFiles().map((file) => `  ${file.replace(agentHome(), "~")}`).join("\n");

  return `${style.bold(`aiand ${adapter.id}`)} -- ${adapter.label} on ai&

Usage
  aiand ${adapter.id} [on|off|status] [options]

Verbs
  on       wire ${adapter.label} to ai& (default)
  off      remove aiand routing (keeps your edits)
  status   show whether ${adapter.label} is wired to ai&

Options
${flags}

Config files
${files}

Install
  Install it with: ${adapter.install.command}
  See: ${adapter.install.url}`;
}

/**
 * The per-agent command surface, shared by every named agent noun. The verb
 * is the first positional (default `on`); the model catalog lives behind the
 * engine, which resolves it before the adapter writes.
 */
export async function runAgentCommand(adapter: AgentAdapter, argv: string[]): Promise<void> {
  const options = {
    model: { type: "string" },
    force: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    profile: { type: "string" },
    "base-url": { type: "string" },
    help: { type: "boolean", default: false },
  } as const;
  const parsed = parse(argv, options);

  if (bool(parsed, "help")) return out(agentHelp(adapter));

  const [verb = "on"] = parsed.positionals;
  if (!VERBS.includes(verb as Verb)) {
    throw new CliError(`Unknown verb "${verb}".`, { hint: `Verbs: on, off, status` });
  }

  const jsonOut = bool(parsed, "json");

  switch (verb as Verb) {
    case "on":
      return runOn(adapter, parsed, jsonOut);
    case "off":
      return runOff(adapter, parsed, jsonOut);
    case "status":
      return runStatus(adapter, jsonOut);
  }
}

async function runOn(adapter: AgentAdapter, parsed: Parsed, jsonOut: boolean): Promise<void> {
  const result = await agentOn(adapter, {
    model: str(parsed, "model"),
    force: bool(parsed, "force"),
    slots: {},
    profile: str(parsed, "profile"),
    baseUrl: str(parsed, "base-url"),
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

function stateLabel(state: "on" | "off"): string {
  switch (state) {
    case "on":
      return style.green("on");
    case "off":
      return style.dim("off");
  }
}