import { AGENTS, findAgent } from "../agents/registry.js";
import { hasSnapshot, restoreSnapshot } from "../agents/snapshot.js";
import type { AgentAdapter } from "../agents/types.js";
import { forgetWired } from "../agents/wired.js";
import { bool, parse } from "../cli/args.js";
import { CliError, cancelled } from "../cli/errors.js";
import { json, out, style } from "../cli/output.js";
import { confirm, isInteractive } from "../cli/prompt.js";
import { promptCheckbox } from "../cli/select.js";

export const help = `${style.bold("aiand restore")} -- restore a pre-aiand config snapshot

Usage
  aiand restore                pick agents interactively (a real terminal)
  aiand restore <agent> --force

Restores the byte-for-byte snapshot taken before aiand first wired the agent.
This does not run during \`off\`; use \`aiand <agent> off\` to subtract aiand
routing while keeping your edits.

Without an agent name in a real terminal, restore opens an interactive picker
of every agent that has a snapshot, pre-selects all of them, and asks one
yes/no confirm before overwriting anything.

Options
  --force             confirm restore (required)
  --json              machine-readable output
  -h, --help          show this help`;

/**
 * Restore one agent's snapshot with what restoreSnapshot needs to report the
 * files it leaves alone: `wired` paths held ai& wiring at capture time and
 * have no pre-aiand copy, `unmanaged` paths are no longer where the agent
 * reads its config.
 */
async function restoreAgent(
  adapter: AgentAdapter,
): Promise<{ restored: boolean; wired: string[]; unmanaged: string[] }> {
  const wired: string[] = [];
  const unmanaged: string[] = [];
  const restored = await restoreSnapshot(
    adapter.id,
    adapter.managedFiles(),
    (path, reason) => (reason === "wired" ? wired : unmanaged).push(path),
    adapter.carriesWiring?.bind(adapter),
  );
  return { restored, wired, unmanaged };
}

/** The dim lines for files restore deliberately left in place. */
function reportSkips(adapter: AgentAdapter, wired: string[], unmanaged: string[]): void {
  for (const path of wired) {
    out(
      style.dim(
        `${path} already held ai& wiring when it was captured, so it has no copy; run aiand ${adapter.id} off to strip it.`,
      ),
    );
  }
  for (const path of unmanaged) {
    out(
      style.dim(
        `${path} is not where ${adapter.label} reads its config now; its copy stays in the snapshot. Restore again from a shell that points ${adapter.label} there.`,
      ),
    );
  }
}

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    force: { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);
  const [name, ...extra] = parsed.positionals;
  if (!name) {
    if (!isInteractive() || bool(parsed, "json")) {
      throw new CliError("Missing agent name.", {
        hint: "Usage: aiand restore <agent> --force",
      });
    }

    const candidates: AgentAdapter[] = [];
    for (const adapter of AGENTS) {
      if (await hasSnapshot(adapter.id)) candidates.push(adapter);
    }
    if (candidates.length === 0) {
      out("No config snapshots found. Wire an agent first with `aiand init`.");
      return;
    }

    const picked = await promptCheckbox({
      message: "Which agents should be restored?",
      choices: candidates.map((a) => ({ value: a.id, label: a.label, hint: `${a.id} snapshot` })),
      initial: candidates.map((a) => a.id),
    });
    if (picked === null) throw cancelled();
    if (picked.length === 0) {
      throw new CliError("No agents selected.", {
        hint: "Use space to toggle agents, then Enter to confirm.",
      });
    }
    if (!(await confirm("Restore overwrites current config files. Continue?"))) {
      throw cancelled();
    }
    for (const id of picked) {
      const adapter = findAgent(id);
      if (!adapter) continue;
      const { restored, wired, unmanaged } = await restoreAgent(adapter);
      if (!restored) {
        out(`${adapter.label}: no snapshot found, skipped.`);
        continue;
      }
      await forgetWired(adapter.id);
      out(`${adapter.label} config restored from snapshot.`);
      reportSkips(adapter, wired, unmanaged);
    }
    return;
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

  const { restored, wired, unmanaged } = await restoreAgent(adapter);
  if (!restored) {
    throw new CliError(`No snapshot found for ${adapter.label}.`, {
      hint: `Wire ${adapter.label} first with \`aiand init ${adapter.id}\` or \`aiand ${adapter.id} on\`.`,
    });
  }

  await forgetWired(adapter.id);

  if (bool(parsed, "json")) {
    return json({
      agent: adapter.id,
      state: "restored",
      ...(wired.length > 0 ? { not_captured: wired } : {}),
      ...(unmanaged.length > 0 ? { kept: unmanaged } : {}),
    });
  }
  out(`${adapter.label} config restored from snapshot.`);
  reportSkips(adapter, wired, unmanaged);
}
