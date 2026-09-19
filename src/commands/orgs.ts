import { parse, bool, str } from "../cli/args.js";
import { json, out, style, table } from "../cli/output.js";
import { openSession } from "../api/client.js";
import { listOrgs, type AccountOrg } from "../api/account.js";
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

  const profile = resolveProfile(str(parsed, "profile"));
  const session = await openSession(profile);
  const orgs = await listOrgs(session);
  const storedOrgId = session.credential?.org?.id;
  const activeId = storedOrgId ?? orgs[0]?.id;
  const marked = orgs.map((org) => ({ ...org, active: org.id === activeId }));

  if (bool(parsed, "json")) {
    return json(marked);
  }

  if (orgs.length === 0) {
    out(style.dim("You do not belong to any organizations."));
    return;
  }

  table<AccountOrg & { active: boolean }>(
    marked,
    [
      { header: "", value: (o) => (o.active ? style.green("*") : " ") },
      { header: "name", value: (o) => o.name },
      { header: "id", value: (o) => style.dim(o.id) },
    ]
  );

  if (orgs.length > 1) {
    out();
    out(style.dim("* the org this CLI session is scoped to"));
  }
}
