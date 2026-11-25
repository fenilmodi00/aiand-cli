import { saveCatalogCache, visionLabel } from "../agents/catalog.js";
import { openSession, type Session } from "../api/client.js";
import { listModels, type Model, modelLabel } from "../api/models.js";
import { bool, oneOf, parse, str } from "../cli/args.js";
import { CliError, NotBoundError } from "../cli/errors.js";
import { currencySymbol, err, json, num, out, style, styled, table } from "../cli/output.js";
import { loadCredential, type ResolvedProfile, resolveProfile } from "../config.js";

export const help = `${style.bold("aiand models")} -- list the model catalog

Usage
  aiand models [options]

Options
  --search <text>        match id, name, or provider
  --capability <name>    only models tagged with this capability (repeatable)
  --sort <field>         id (default), input, output, or context
  --long                 include the description column
  --json                 machine-readable output (full <org>/<model> ids)

Prices are per 1M tokens in your organization's billing currency. Signed out,
the catalog is still readable and priced in USD, as it is for an endpoint your
sign-in was not issued for (--base-url).`;

const MODEL_SORTS = ["id", "input", "output", "context"] as const;
type ModelSort = (typeof MODEL_SORTS)[number];

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    search: { type: "string" },
    capability: { type: "string", multiple: true },
    sort: { type: "string" },
    long: { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);
  if (parsed.positionals.length > 0) {
    throw new CliError(`Unknown argument "${parsed.positionals[0]}".`, {
      hint: "Run `aiand models --help` to see the flags.",
    });
  }

  const profile = resolveProfile(str(parsed, "profile"));

  const session = await catalogSession(profile);

  let models = await listModels(session, profile.apiUrl);
  // The report/overview savings read this cache offline; `models` is the
  // catalog-reading command the "run once to cache it" note names.
  await saveCatalogCache(profile.apiUrl, models).catch(() => {});

  const search = str(parsed, "search")?.toLowerCase();
  if (search) {
    models = models.filter((m) =>
      [m.id, m.name, m.provider].some((field) => field.toLowerCase().includes(search)),
    );
  }

  const capabilities = (parsed.values.capability as string[] | undefined) ?? [];
  if (capabilities.length > 0) {
    models = models.filter((m) => capabilities.every((c) => m.capabilities.includes(c)));
  }

  models = sortModels(models, oneOf(parsed, "sort", MODEL_SORTS, "id"));

  if (bool(parsed, "json")) return json(models);

  if (models.length === 0) {
    out(style.dim("No models matched."));
    return;
  }

  const price = (value: string, currency: string): string =>
    `${currencySymbol(currency)}${trimZeros(value)}`;

  table<Model>(models, [
    { header: "id", value: (m) => modelLabel(m.id) },
    { header: "context", value: (m) => num(m.context_window), align: "right" },
    {
      header: "vision",
      // Text-only entries read dimmed so the vision-capable ones stand out.
      value: (m) =>
        visionLabel(m) === "vision" ? visionLabel(m) : styled(style.dim, visionLabel(m)),
    },
    { header: "in/1m", value: (m) => price(m.input_per_1m, m.currency), align: "right" },
    { header: "out/1m", value: (m) => price(m.output_per_1m, m.currency), align: "right" },
    { header: "capabilities", value: (m) => styled(style.dim, m.capabilities.join(",")) },
    ...(bool(parsed, "long")
      ? [{ header: "description", value: (m: Model) => styled(style.dim, m.description ?? "") }]
      : []),
  ]);

  out();
  out(
    style.dim(
      `${models.length} model${models.length === 1 ? "" : "s"}. ` +
        (session ? "" : "Priced in USD -- sign in to see your billing currency. ") +
        `Pass -m auto to let ai& pick per request when your account supports it (aiand run -m, aiand chat -m).`,
    ),
  );
}

/**
 * The catalog is public, so a sign-in for another endpoint is not an error
 * here: `--base-url X` while signed in elsewhere reads X's public catalog, and
 * the stored key stays home.
 */
async function catalogSession(profile: ResolvedProfile): Promise<Session | null> {
  const hasKey = Boolean(process.env.AIAND_API_KEY?.trim() || (await loadCredential(profile.name)));
  if (!hasKey) return null;
  try {
    return await openSession(profile);
  } catch (error) {
    if (!(error instanceof NotBoundError)) throw error;
    err(
      style.dim(
        `Your sign-in for profile "${profile.name}" is for another endpoint, so it was not sent to ${profile.apiUrl}; showing its public catalog.`,
      ),
    );
    return null;
  }
}

function trimZeros(value: string): string {
  if (!value.includes(".")) return value;
  const trimmed = value.replace(/0+$/, "");
  const [whole, fraction = ""] = trimmed.split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

function sortModels(models: Model[], field: ModelSort): Model[] {
  const byNumber = (get: (m: Model) => number) => (a: Model, b: Model) => get(a) - get(b);
  switch (field) {
    case "input":
      return [...models].sort(byNumber((m) => Number(m.input_per_1m)));
    case "output":
      return [...models].sort(byNumber((m) => Number(m.output_per_1m)));
    case "context":
      return [...models].sort(byNumber((m) => -m.context_window));
    default:
      return [...models].sort((a, b) => a.id.localeCompare(b.id));
  }
}
