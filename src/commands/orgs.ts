import { type AccountOrg, listOrgs } from "../api/account.js";
import { openSession } from "../api/client.js";
import { bool, parse, str } from "../cli/args.js";
import { CliError } from "../cli/errors.js";
import { json, out, style, table } from "../cli/output.js";
import { resolveProfile } from "../config.js";

export const help = `${style.bold("aiand orgs")} -- list your organizations

Usage
  aiand orgs [options]

Options
  --json              machine-readable output

The CLI's key is scoped to one organization at login, so this list is read-only.
To work in a different org, change your default org in the console and run
\`aiand login --force\`.`;

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv);
  if (bool(parsed, "help")) return out(help);
  if (parsed.positionals.length > 0) {
    throw new CliError(`Unknown argument "${parsed.positionals[0]}".`, {
      hint: "Run `aiand orgs --help` to see the flags.",
    });
  }

  const profile = resolveProfile(str(parsed, "profile"));
  const session = await openSession(profile);
  const orgs = await listOrgs(session);
  const storedOrgId = session.credential?.org?.id;
  // Env-key Sessions (credential: null) carry no stored Org — mark nothing
  // active rather than guessing list order.
  const marked = orgs.map((org) => ({ ...org, active: org.id === storedOrgId }));

  if (bool(parsed, "json")) {
    return json(marked);
  }

  if (orgs.length === 0) {
    out(style.dim("You do not belong to any organizations."));
    return;
  }

  table<AccountOrg & { active: boolean }>(marked, [
    { header: "", value: (o) => (o.active ? style.green("*") : " ") },
    { header: "name", value: (o) => o.name },
    { header: "id", value: (o) => style.dim(o.id) },
  ]);

  if (orgs.length > 1) {
    out();
    if (marked.some((o) => o.active)) {
      out(style.dim("* the org this CLI session is scoped to"));
    } else if (!session.credential) {
      out(style.dim("no org is marked: the active scope is unknown under AIAND_API_KEY"));
    } else if (storedOrgId) {
      out(style.dim("stored org is not in this list — run `aiand login --force` to refresh"));
    }
  }
}
