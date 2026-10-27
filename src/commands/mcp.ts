import { VERSION } from "../api/client.js";
import { bool, parse, str } from "../cli/args.js";
import { out, style } from "../cli/output.js";
import { runMcpServer } from "../mcp/server.js";
import { noSyncRequested } from "../store/index.js";

export const help = `${style.bold("aiand mcp")} -- serve local usage data to coding agents (MCP over stdio)

Usage
  aiand mcp
  aiand mcp --no-sync

Runs a Model Context Protocol server on stdin/stdout (newline-delimited
JSON-RPC; no HTTP, no daemon). Point your agent's MCP client at it, e.g.

  claude mcp add aiand -- aiand mcp
  # or in .mcp.json: { "mcpServers": { "aiand": { "command": "aiand", "args": ["mcp"] } } }

Tools
  usage_stats      spend by day/week/month/session, by model and by harness
                   (same JSON as \`aiand usage --json\`)
  session_stats    one session by id, or the session list (\`aiand sessions --json\`)
  harness_compare  per-harness stats over your real workload (\`aiand harness compare --json\`)
  spend_check      budget burn + pacing verdict so an agent can pace itself
                   (\`aiand forecast --json\`)

Every tool reads the local request store (metadata only — never prompt or
completion content) after the same fail-open incremental sync the other
commands do; --no-sync (or AIAND_NO_SYNC=1) reads the store as-is and never
touches the network. Costs are gateway-billed sums per currency; tokens follow
the gateway convention (input includes cached).

Privacy: harness/project names are pseudonymized in tool output
(project-a1b2) unless you opt in: aiand config set mcp.realProjectNames true.`;

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    "no-sync": { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  await runMcpServer({
    input: process.stdin,
    output: process.stdout,
    version: VERSION,
    noSync: bool(parsed, "no-sync") || noSyncRequested(),
    profile: str(parsed, "profile") || process.env.AIAND_PROFILE,
  });
}
