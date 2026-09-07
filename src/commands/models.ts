import { parse, bool, str } from "../cli/args.js";
import { json, num, out, style, table } from "../cli/output.js";
import { loadCredential, resolveProfile } from "../config.js";
import { openSession } from "../api/client.js";
import { listModels, type Model } from "../api/models.js";
import { visionLabel } from "../agents/vision.js";

export const help = `${style.bold("aiand models")} -- list the model catalog

Usage
  aiand models [options]

Options
  --search <text>        match id, name, or provider
  --capability <name>    only models tagged with this capability (repeatable)
  --sort <field>         id (default), input, output, or context
  --long                 include the description column
  --json                 machine-readable output

Prices are per 1M tokens in your organization's billing currency. Signed out,
the catalog is still readable and priced in USD.`;

const CURRENCY_SYMBOL: Record<string, string> = { usd: "$", jpy: "¥" };

export async function run(argv: string[]): Promise<void> {
  const parsed = parse(argv, {
    search: { type: "string" },
    capability: { type: "string", multiple: true },
    sort: { type: "string" },
    long: { type: "boolean", default: false },
  });
  if (bool(parsed, "help")) return out(help);

  const profile = resolveProfile(str(parsed, "profile"));

  const hasKey = Boolean(process.env.AIAND_API_KEY ?? (await loadCredential(profile.name)));
  const session = hasKey ? await openSession(profile) : null;

  let models = await listModels(session, profile.apiUrl);

  const search = str(parsed, "search")?.toLowerCase();
  if (search) {
    models = models.filter((m) =>
      [m.id, m.name, m.provider].some((field) => field.toLowerCase().includes(search))
    );
  }

  const capabilities = (parsed.values.capability as string[] | undefined) ?? [];
  if (capabilities.length > 0) {
    models = models.filter((m) => capabilities.every((c) => m.capabilities.includes(c)));
  }

  models = sortModels(models, str(parsed, "sort") ?? "id");

  if (bool(parsed, "json")) return json(models);

  if (models.length === 0) {
    out(style.dim("No models matched."));
    return;
  }

  const price = (value: string, currency: string): string =>
    `${CURRENCY_SYMBOL[currency] ?? ""}${trimZeros(value)}`;

  table<Model>(models, [
    { header: "id", value: (m) => m.id },
    { header: "context", value: (m) => num(m.context_window), align: "right" },
    {
      header: "vision",
      // Text-only entries read dimmed so the vision-capable ones stand out.
      value: (m) =>
        visionLabel(m) === "vision"
          ? visionLabel(m)
          : style.dim(visionLabel(m)),
    },
    { header: "in/1m", value: (m) => price(m.input_per_1m, m.currency), align: "right" },
    { header: "out/1m", value: (m) => price(m.output_per_1m, m.currency), align: "right" },
    { header: "capabilities", value: (m) => style.dim(m.capabilities.join(",")) },
    ...(bool(parsed, "long")
      ? [{ header: "description", value: (m: Model) => style.dim(m.description ?? "") }]
      : []),
  ]);

  out();
  out(
    style.dim(
      `${models.length} model${models.length === 1 ? "" : "s"}. ` +
        (session ? "" : "Priced in USD -- sign in to see your billing currency. ") +
        `Pass model "auto" to let ai& pick per request.`
    )
  );
}

function trimZeros(value: string): string {
  if (!value.includes(".")) return value;
  const trimmed = value.replace(/0+$/, "");
  const [whole, fraction = ""] = trimmed.split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

function sortModels(models: Model[], field: string): Model[] {
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
