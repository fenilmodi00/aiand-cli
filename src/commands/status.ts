import { parse, bool, str } from "../cli/args.js";
import { out, style, fields, json, table, err } from "../cli/output.js";
import { authStatus } from "../auth/flow.js";
import { AGENTS } from "../agents/registry.js";
import { agentStatus, type AgentStatusResult } from "../agents/setup.js";

export const help = `${style.bold("aiand status")} -- sign-in state at a glance

Usage
  aiand status [options]

Options
  --json              machine-readable output
  --local             read the cached identity without calling the API
  --profile <name>    inspect a specific profile

Shows who you are signed in as, where the active key comes from, which
storage tier holds it, and whether coding agents are wired to ai&.`;

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, { local: { type: "boolean", default: false } });
  if (bool(parsed, "help")) return out(help);

  const auth = await authStatus({
    profile: str(parsed, "profile"),
    local: bool(parsed, "local"),
  });
  const agents = await Promise.all(AGENTS.map(async (adapter) => agentStatus(adapter)));

  if (bool(parsed, "json")) {
    return json({ auth, agents });
  }

  if (!auth.signed_in) {
    if (process.env.AIAND_API_KEY) {
      fields([
        ["profile", auth.profile],
        ["source", style.dim("AIAND_API_KEY")],
      ]);
      printAgents(agents);
      return;
    }
    out(style.yellow("Not signed in."));
    err(style.dim("Run `aiand login` first."));
    printAgents(agents);
    return;
  }

  fields([
    ["email", auth.email ?? style.dim("unknown")],
    ["org", auth.org ?? style.dim("none")],
    ["profile", auth.profile],
    ["key", style.dim(auth.key ?? "unknown")],
    ["source", style.dim(auth.source ?? "unknown")],
    ["storage", style.dim(auth.storage ?? "unknown")],
  ]);

  printAgents(agents);
}

function printAgents(agents: AgentStatusResult[]): void {
  if (agents.length === 0) return;
  out("");
  table(agents, [
    { header: "agent", value: (a) => a.agent },
    { header: "state", value: (a) => stateLabel(a.state) },
    { header: "foreign", value: (a) => a.foreign ?? "—" },
    { header: "model", value: (a) => a.model ?? "—" },
    { header: "binary", value: (a) => a.installed ? (a.binary ?? "yes") : style.dim(`install: ${installCmd(a)}`) },
  ]);
}

function installCmd(a: AgentStatusResult): string {
  const adapter = AGENTS.find((entry) => entry.id === a.agent);
  return adapter?.install.command ?? "";
}

function stateLabel(state: AgentStatusResult["state"]): string {
  switch (state) {
    case "on":
      return style.green("on");
    case "foreign":
      return style.yellow("foreign");
    case "off":
      return style.dim("off");
  }
}