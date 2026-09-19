import { bool, parse } from "../cli/args.js";
import { json, out, style } from "../cli/output.js";
import { CliError } from "../cli/errors.js";
import { AGENTS, findAgent } from "../agents/registry.js";
import { restoreSnapshot } from "../agents/snapshot.js";

export const help = `${style.bold("aiand restore")} -- restore a pre-aiand config snapshot

Usage
  aiand restore <agent> --force

Restores the byte-for-byte snapshot taken before aiand first wired the agent.
This does not run during \`off\`; use \`aiand <agent> off\` to subtract aiand
routing while keeping your edits.

Options
  --force             confirm restore (required)
  --json              machine-readable output
  -h, --help          show this help`;

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    force: { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  const [name, ...extra] = parsed.positionals;
  if (!name) {
    throw new CliError("Missing agent name.", {
      hint: "Usage: aiand restore <agent> --force",
    });
  }
  if (extra.length > 0) {
    throw new CliError("Restore takes exactly one agent name.", {
      hint: `You passed: ${parsed.positionals.join(" ")}`,
    });
  }

  const adapter = findAgent(name);
  if (!adapter) {
    throw new CliError(`Unknown agent "${name}".`, {
      hint: `Valid agents: ${AGENTS.map((a) => a.id).join(", ")}`,
    });
  }

  if (!bool(parsed, "force")) {
    throw new CliError("Restore overwrites current config files.", {
      hint: "Pass --force to restore the pre-aiand snapshot.",
    });
  }

  const restored = await restoreSnapshot(adapter.id, adapter.managedFiles());
  if (!restored) {
    throw new CliError(`No snapshot found for ${adapter.label}.`, {
      hint: `Wire ${adapter.label} first with \`aiand init ${adapter.id}\` or \`aiand ${adapter.id} on\`.`,
    });
  }

  if (bool(parsed, "json")) {
    return json({ agent: adapter.id, state: "restored" });
  }
  out(`${adapter.label} config restored from snapshot.`);
}
