/**
 * The dsh session launcher: one throwaway `$DSH_HOME` holding the same rows
 * `on` writes plus the session key, so `run-agent` never writes under the
 * user's real home.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "../../cli/errors.js";
import { agentHome, DEFAULT_BASE_URL, trimSlash } from "../../config.js";
import { inCatalog } from "../catalog.js";
import { createSessionOverlay } from "../managed-file.js";
import type { SessionLaunchInput } from "../types.js";
import { renderScalar } from "./patch.js";
import {
  buildDshCredentials,
  buildDshDefaultRow,
  buildDshLlmRow,
  DSH_KEY_REF,
  DSH_ROUTE,
} from "./rows.js";

/** dsh refuses a profile selected twice ("select a profile only once"), so
 * the open path decides its own injection by reading what the user typed with
 * every `--patch` overlay already ignored: the launcher strips `--patch value`
 * and `--patch=value` from the passthrough, so a profile named after one
 * (`aiand dsh --patch x.yml web`) must not be read as the user's when the
 * value it displaced is gone. */
function pickedProfile(args: readonly string[]): boolean {
  // Our own flag: the launcher drops it from the passthrough so a caller
  // cannot override the injected routing, so we never see it land as ours.
  if (args.some((arg) => /^--profile(?:=|$)/.test(arg))) return true;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--patch") {
      // `--patch value`: the value is the next token, when present and not
      // itself a flag — the same read dropOwnedFlags makes, so what survives
      // into the child is what is judged here.
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) i += 1;
      continue;
    }
    if (arg.startsWith("--patch=")) continue;
    // dsh reads a leading bare positional as the profile to boot; a value
    // belonging to another flag is not one, so only the first token that is
    // not a flag and does not follow a flag decides it.
    return !arg.startsWith("-");
  }
  return false;
}

export function dshHome(): string {
  const fromEnv = process.env.DSH_HOME;
  const selected =
    fromEnv !== undefined && fromEnv.trim() !== "" ? fromEnv : join(agentHome(), ".dsh");
  if (selected === "~" || selected.startsWith("~/") || selected.startsWith("~\\")) {
    return join(agentHome(), selected.slice(1));
  }
  return selected;
}

export const dshBaseUrl = (baseUrl?: string): string =>
  `${trimSlash(baseUrl ?? "") || DEFAULT_BASE_URL}/v1`;

export async function sessionLaunch(input: SessionLaunchInput) {
  // One session with nothing written under the user's real home: a throwaway
  // $DSH_HOME holding the same rows `on` writes, plus the session key at 0600.
  // The key never rides the child env. A blank override of the ref name is
  // deliberate: dsh resolves refs with the inherited environment first, so
  // an exported AIAND_DSH_API_KEY would outrank the overlay's credential
  // file — and dsh reads a blank value as absent, so the file wins (verified
  // against the real binary).
  //
  // No shadowEnv, and that is evidence-based, not a guess. The injected
  // `aiand` route is built from the patch row alone: provider id `aiand`,
  // api `openai-completions`, apiKeyEnv AIAND_DSH_API_KEY. pi-ai (the
  // wrapped @earendil-works/pi-ai the route rides) resolves an ambient key
  // by *provider id* — getApiKeyEnvVars maps anthropic->ANTHROPIC_API_KEY,
  // openai->OPENAI_API_KEY, deepseek->DEEPSEEK_API_KEY and so on, with no
  // `aiand` entry — and dsh-llm-pi-ai builds this route's provider with its
  // own harnessApiKeyAuth resolver, which returns only the key from the
  // credential the row's apiKeyEnv names. So pi-ai's ambient discovery is
  // never consulted for our route, and an exported ANTHROPIC_API_KEY or
  // OPENAI_API_KEY cannot steer it. Ambient discovery only reaches providers
  // that declare those ids (anthropic, openai, deepseek, ...), which our row
  // does not. The one name that could outrank the overlay is an inherited
  // AIAND_DSH_API_KEY (dsh's credentials layer ranks the inherited
  // environment above the file), and it is blanked below.
  // dsh's own native providers do read DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL,
  // but those route to DeepSeek, not to the `aiand` row.
  const model =
    input.model !== undefined && inCatalog(input.catalog, input.model)
      ? input.model
      : input.profileModel !== undefined && inCatalog(input.catalog, input.profileModel)
        ? input.profileModel
        : input.catalog[0]?.id;
  if (model === undefined) {
    throw new CliError("The ai& catalog served no models to route dsh with.", {
      hint: "Retry, or pass --model with an ai& model id.",
    });
  }
  const home = dshHome();
  const rows = [
    buildDshLlmRow(dshBaseUrl(input.baseUrl), input.catalog),
    buildDshDefaultRow(DSH_ROUTE, model, true),
  ];
  // Session history must survive the throwaway: restate the bundle's session
  // root at the real home, which is where the user's history already lives.
  const realSessions = join(home, "sessions");
  if (existsSync(realSessions)) {
    rows.push(
      [
        `- id: session-persistence-jsonl`,
        `  name: '@deepseek-ai/dsh-session-persistence-jsonl'`,
        `  config:`,
        `    root: ${renderScalar(realSessions)}`,
      ].join("\n"),
    );
  }
  const overlay = await createSessionOverlay("aiand-dsh-", {
    "cordis.patch.yml": `${rows.join("\n")}\n`,
    ".credentials.yaml": buildDshCredentials("", input.apiKey),
  });
  return {
    env: { DSH_HOME: overlay.dir, [DSH_KEY_REF]: "" },
    args: dshProfileArgs(),
    // A passthrough --patch overlay outranks the injected home layer in
    // dsh's composition, so the launcher owns the flag.
    stripPassthroughFlags: ["--patch"],
    cleanup: overlay.cleanup,
  };
}

/** The profile argv every dsh spawn needs, on either launch path: dsh boots
 * a profile under $DSH_HOME/profiles and errors `--profile <name> is
 * required` without it (measured against 0.2.0-rc.2). */
const dshProfileArgs = (): string[] => [
  // `web` is dsh's interactive surface; `headless` answers one piped task and
  // exits, which is what a non-TTY session must do instead of serving a
  // browser.
  "--profile",
  process.stdin.isTTY ? "web" : "headless",
];

/**
 * `aiand dsh` (no verb) writes the routing into the user's real home, so the
 * open path needs the same profile argv and the same throwaway-key handling
 * `run-agent` gets from sessionLaunch. Without it the boot fails: dsh reads a
 * leading bare positional as the profile to boot (`dsh web`), and with no
 * profile name at all it errors `--profile <name> is required` (both measured
 * against 0.2.0-rc.2).
 *
 * A user who already picks a profile — `aiand dsh web`, or `--profile web` —
 * gets no second one from us: dsh refuses a profile selected twice ("select a
 * profile only once"), so theirs stands alone.
 *
 * The key never rides the child env: dsh resolves refs with the inherited
 * environment first, so an exported AIAND_DSH_API_KEY would outrank the
 * credential file `on` wrote — and dsh reads a blank value as absent, so that
 * file wins (same blank override sessionLaunch returns).
 *
 * `--patch` is claimed on every invocation, not only when we inject a profile:
 * a passthrough overlay outranks the home layer `on` just wrote whichever
 * profile the user picked, so the flag never reaches dsh from here.
 *
 * No overlay: the home `on` just wrote IS the routing, and a throwaway would
 * only lose the profile the user picked inside it. `cleanup` is not ours
 * either: nothing throwaway exists to remove.
 */
export async function openExtras({ args }: { args: string[] }) {
  return {
    // The key never rides the child env (see sessionLaunch).
    env: { [DSH_KEY_REF]: "" },
    // dsh boots no profile at all unless one is named, and refuses a
    // duplicate, so only an unpicked spawn takes ours.
    ...(pickedProfile(args) ? {} : { args: dshProfileArgs() }),
    // A passthrough --patch overlay outranks the routing `on` just wrote.
    stripPassthroughFlags: ["--patch"],
  };
}
