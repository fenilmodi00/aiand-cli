import { bool, parse, str } from "../cli/args.js";
import { out, style } from "../cli/output.js";
import { CliError } from "../cli/errors.js";
import { requireSessionKey } from "../agents/session.js";

export const help = `${style.bold("aiand key export")} -- print the active session key

Prints the resolved API key to stdout with no decoration, so it can be piped
straight into another tool: \`aiand key export | pbcopy\`.

Usage
  aiand key export [options]

Options
  --profile <name>    export a specific profile's key
  --base-url <url>    point at a different API endpoint
  -h, --help          show this help`;

/**
 * The only verb is `export`: resolve the active session key (env var wins,
 * then the stored credential for the profile) and write the raw key to stdout.
 */
export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv);
  if (bool(parsed, "help")) return out(help);

  const [verb] = parsed.positionals;
  if (verb !== "export") {
    throw new CliError(verb ? `Unknown verb "${verb}".` : "No verb given.", {
      hint: "Verbs: export",
    });
  }

  const session = await requireSessionKey(str(parsed, "profile"));
  process.stdout.write(session.key + "\n");
}