/**
 * The dsh session launcher: one throwaway `$DSH_HOME` holding the same rows
 * `on` writes plus the session key, so `run-agent` never writes under the
 * user's real home.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../../cli/errors.js";
import { agentHome, DEFAULT_BASE_URL, trimSlash } from "../../config.js";
import { PRIVATE_FILE_MODE } from "../../fsutil.js";
import { inCatalog } from "../catalog.js";
import type { SessionLaunchInput } from "../types.js";
import { renderScalar } from "./patch.js";
import {
  buildDshCredentials,
  buildDshDefaultRow,
  buildDshLlmRow,
  DSH_KEY_REF,
  DSH_ROUTE,
} from "./rows.js";

export function dshHome(): string {
  const fromEnv = process.env.DSH_HOME;
  const selected =
    fromEnv !== undefined && fromEnv.trim() !== "" ? fromEnv : join(agentHome(), ".dsh");
  if (selected === "~" || selected.startsWith("~/") || selected.startsWith("~\\")) {
    return join(agentHome(), selected.slice(1));
  }
  return selected;
}

const dshBaseUrl = (baseUrl?: string): string =>
  `${trimSlash(baseUrl ?? "") || DEFAULT_BASE_URL}/v1`;

/** A throwaway home holding the patch layer and the key at 0600. A failed
 * write removes it before rethrowing; cleanup removes it after the child. */
async function createDshOverlay(
  files: Record<string, string>,
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "aiand-dsh-"));
  try {
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(join(dir, name), contents, { mode: PRIVATE_FILE_MODE });
    }
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

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
  const overlay = await createDshOverlay({
    "cordis.patch.yml": `${rows.join("\n")}\n`,
    ".credentials.yaml": buildDshCredentials("", input.apiKey),
  });
  // `web` is dsh's interactive surface; `headless` answers one piped task
  // and exits, which is what a non-TTY session must do instead of sitting
  // on a server.
  const profile = process.stdin.isTTY ? "web" : "headless";
  return {
    env: { DSH_HOME: overlay.dir, [DSH_KEY_REF]: "" },
    args: ["--profile", profile],
    // A passthrough --patch overlay outranks the injected home layer in
    // dsh's composition, so the launcher owns the flag.
    stripPassthroughFlags: ["--patch"],
    cleanup: overlay.cleanup,
  };
}
