import { bool, parse, str, type Parsed } from "../cli/args.js";
import { err, fields, json, out, style } from "../cli/output.js";
import { CliError } from "../cli/errors.js";
import { agentOn, agentOff, agentStatus } from "../agents/engine.js";
import { getCatalog } from "../agents/catalog.js";
import { visionLabel } from "../agents/vision.js";
import { resolveProfile } from "../config.js";
import { agentHome } from "../agents/paths.js";
import type { AgentAdapter, Verb } from "../agents/types.js";

const VERBS: Verb[] = ["on", "off", "status"];

function agentHelp(adapter: AgentAdapter): string {
  const flags = [
    "  --model <id>           model to route (default: auto)",
    "  --force                overwrite a config another tool manages",
    ...(adapter.id === "claude"
      ? [
          "  --opus <id>            model for opus requests",
          "  --sonnet <id>          model for sonnet requests",
          "  --haiku <id>           model for haiku requests",
        ]
      : []),
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
  off      restore your previous config byte-for-byte
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
 * engine, which resolves it before the adapter writes. Slot flags are parsed
 * only for Claude Code, whose adapter is the only one with model slots.
 */
export async function runAgentCommand(adapter: AgentAdapter, argv: string[]): Promise<void> {
  const options = {
    model: { type: "string" },
    force: { type: "boolean", default: false },
  } as const;
  const parsed = parse(argv, adapter.id === "claude" ? { ...options, ...CLAUDESLOTS } : options);

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

const CLAUDESLOTS = {
  opus: { type: "string" },
  sonnet: { type: "string" },
  haiku: { type: "string" },
} as const;

async function runOn(adapter: AgentAdapter, parsed: Parsed, jsonOut: boolean): Promise<void> {
  const slots: Record<string, string> = {};
  for (const slot of ["opus", "sonnet", "haiku"] as const) {
    const value = str(parsed, slot);
    if (value !== undefined) slots[slot] = value;
  }

  const result = await agentOn(adapter, {
    model: str(parsed, "model"),
    force: bool(parsed, "force"),
    slots,
    json: jsonOut,
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
  out(`${adapter.label} is off — your previous config was restored.`);
}

async function runStatus(adapter: AgentAdapter, jsonOut: boolean): Promise<void> {
  const result = await agentStatus(adapter);
  if (jsonOut) {
    return json(result);
  }

  // Append " (text-only)" to the model label when the probed (possibly [1m]-tagged)
  // model resolves text-only in a fetchable catalog. Strip the trailing [1m] tag
  // before the lookup — probe reads back tagged ids. Silent if the catalog is
  // unreachable or the id is unknown.
  let modelLabel: string = result.model ?? style.dim("—");
  if (result.model) {
    try {
      const profile = resolveProfile();
      const catalog = await getCatalog(profile.apiUrl, null);
      const bare = result.model.replace(/\[1m\]$/, "");
      const entry = catalog.find((model) => model.id === bare);
      if (entry && visionLabel(entry) === "text-only") {
        modelLabel = `${bare} (text-only)`;
      }
    } catch {
      // Catalog unreachable → degrade silently to the plain probed model.
    }
  }

  fields([
    ["agent", result.agent],
    ["installed", result.installed ? (result.binary ?? style.dim("yes")) : style.dim("no")],
    ["state", stateLabel(result.state)],
    ...(result.foreign ? [["foreign", result.foreign] as [string, string]] : []),
    ["model", modelLabel],
  ]);
  if (!result.installed) {
    err(style.dim(`Install it with: ${adapter.install.command}  See: ${adapter.install.url}`));
  }
}

function stateLabel(state: "on" | "off" | "foreign"): string {
  switch (state) {
    case "on":
      return style.green("on");
    case "foreign":
      return style.yellow("foreign");
    case "off":
      return style.dim("off");
  }
}