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

Exit codes
  0  signed in, or the gateway could not be reached (sign-in unknown,
     so scripts must not treat it as signed out)
  1  not signed in

Shows who you are signed in as, where the active key comes from, which
storage tier holds it, and whether coding agents are wired to ai&.`;

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, { local: { type: "boolean", default: false } });
  if (bool(parsed, "help")) return out(help);

  const [auth, agents] = await Promise.all([
    authStatus({
      profile: str(parsed, "profile"),
      local: bool(parsed, "local"),
    }),
    Promise.all(AGENTS.map(async (adapter) => agentStatus(adapter))),
  ]);

  if (bool(parsed, "json")) {
    json({ auth, agents });
    // The JSON body already carries reachable/signed_in; the exit code is
    // the script gate. Set it and return so stdout stays pure JSON — a
    // CliError throw would add a redundant stderr line after the body.
    // Unreachable keeps exit 0 (unverified, not absent); only a reachable
    // signed-out profile exits 1.
    if (!auth.signed_in && auth.reachable) process.exitCode = 1;
    return;
  }

  if (!auth.reachable) {
    // Present-but-unreachable: exit 0 so scripts gating on this command do
    // not false-fail during an outage. The key is unverified, not absent.
    out(style.yellow("Gateway unreachable."));
    err(style.dim("Check your network and retry."));
    printAgents(agents);
    return;
  }

  if (!auth.signed_in) {
    out(style.yellow("Not signed in."));
    err(style.dim("Run `aiand login` first."));
    printAgents(agents);
    process.exitCode = 1;
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
    case "off":
      return style.dim("off");
  }
}