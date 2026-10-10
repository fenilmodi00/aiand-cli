import { AGENTS } from "../../agents/registry.js";
import type { AgentAdapter } from "../../agents/types.js";
import { out, style } from "../output.js";
import type { Choice, PromptInput, PromptOutput } from "../select.js";
import { promptSelect } from "../select.js";
/** One menu row per launchable agent, then wire, then quit. */
export function launcherMenuChoices(opts: { includeMissing: boolean }): Choice[] {
  const launchable: AgentAdapter[] = [];
  const missing: AgentAdapter[] = [];
  for (const adapter of AGENTS) {
    if (adapter.detect().installed && adapter.sessionLaunch) launchable.push(adapter);
    else missing.push(adapter);
  }
  const choices: Choice[] = launchable.map((adapter) => ({
    value: adapter.id,
    label: adapter.label,
    hint: `aiand run-agent ${adapter.id}`,
  }));
  if (opts.includeMissing) {
    for (const adapter of missing) {
      choices.push({ value: adapter.id, label: adapter.label, hint: adapter.install.command });
    }
  }
  choices.push({ value: "wire", label: "Wire agents to ai& permanently", hint: "aiand init" });
  if (missing.length > 0 && !opts.includeMissing) {
    choices.push({ value: "show-more", label: "Show more agents", hint: "install commands" });
  }
  choices.push({ value: "quit", label: "Quit" });
  return choices;
}

/** Bare-`aiand` launcher: pick a session agent, wire, or quit. Returns the exit code. */
export async function runLauncherMenu(opts: {
  argv: string[];
  input?: PromptInput;
  output?: PromptOutput;
}): Promise<number> {
  let expanded = false;
  for (let i = 0; i < 2; i++) {
    const picked = await promptSelect({
      message: "What do you want to run?",
      choices: launcherMenuChoices({ includeMissing: expanded }),
      input: opts.input,
      output: opts.output,
    });
    if (picked === null) {
      out(style.dim("Cancelled."));
      return 130;
    }
    if (picked === "quit") return 0;
    if (picked === "show-more") {
      expanded = true;
      continue;
    }
    if (picked === "wire") {
      // Lazy: bare `aiand` must not pay for command modules it never runs.
      const init = await import("../../commands/init.js");
      await init.run(opts.argv);
      return 0;
    }
    // Lazy: run-agent loads only when an agent is picked.
    const runAgent = await import("../../commands/run-agent.js");
    await runAgent.run([picked, ...opts.argv]);
    return 0;
  }
  return 0;
}
