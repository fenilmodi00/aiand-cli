/**
 * The `--model` value Claude Code starts on, taken from the args a launch
 * passes through. Stops at `--`, and the last flag wins.
 */
export function startupModel(args: readonly string[]): string | undefined {
  let startup: string | undefined;
  for (let i = 0; i < args.length && args[i] !== "--"; i++) {
    const arg = args[i]!;
    if (arg === "--model") startup = args[++i];
    else if (arg.startsWith("--model=")) startup = arg.slice("--model=".length);
  }
  return startup;
}
