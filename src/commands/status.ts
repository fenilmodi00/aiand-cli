import { AGENTS } from "../agents/registry.js";
import { type AgentStatusResult, agentStatus } from "../agents/setup.js";
import { authStatus } from "../auth/identity.js";
import { bool, parse, str } from "../cli/args.js";
import { EXIT } from "../cli/errors.js";
import { err, fields, json, out, style, table } from "../cli/output.js";
import { storePacingSummary } from "../obs/forecast.js";
import { stateLabel } from "./agent.js";

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
    Promise.all(AGENTS.map((adapter) => agentStatus(adapter))),
  ]);

  if (bool(parsed, "json")) {
    json({ auth, agents });
    // Set the exit code and return rather than throw, so stdout stays pure
    // JSON. Only a reachable signed-out profile exits 1.
    if (!auth.signed_in && auth.reachable) process.exitCode = EXIT.ERROR;
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
    process.exitCode = EXIT.ERROR;
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

  printBudgetPacing();
  printAgents(agents);
}

/**
 * The budget pacing verdict (ticket #74 req 3), from the local store against
 * `budget.monthly`, fail-open: no budget or no data prints nothing.
 */
function printBudgetPacing(): void {
  const pacing = storePacingSummary();
  if (!pacing?.pacing) return;
  out("");
  out(style.dim(pacing.pacing));
}

function printAgents(agents: AgentStatusResult[]): void {
  if (agents.length === 0) return;
  out("");
  table(agents, [
    { header: "agent", value: (a) => a.agent },
    { header: "state", value: (a) => stateLabel(a.state) },
    { header: "model", value: (a) => a.model ?? "—" },
    {
      header: "binary",
      value: (a) => (a.installed ? (a.binary ?? "yes") : style.dim(`install: ${installCmd(a)}`)),
    },
  ]);
}

function installCmd(a: AgentStatusResult): string {
  const adapter = AGENTS.find((entry) => entry.id === a.agent);
  return adapter?.install.command ?? "";
}
