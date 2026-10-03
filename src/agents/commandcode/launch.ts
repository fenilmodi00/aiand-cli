import { resolveDefault } from "../catalog.js";
import { createSessionOverlay } from "../managed-file.js";
import type { SessionLaunchInput } from "../types.js";
import {
  buildCommandCodeProvider,
  COMMANDCODE_PROVIDER_ID,
  COMMANDCODE_SELECTION_PREFIX,
  commandCodeBaseUrl,
} from "./shared.js";

/**
 * One Command Code session with nothing written under the real
 * ~/.commandcode: a throwaway overlay becomes HOME holding only the
 * three files `on` writes — providers.json with our row, auth.json
 * with the session key at 0600, and config.json pinning the model.
 * Command Code resolves its config root from HOME (live-proven: no
 * dedicated env var exists), so the overlay relocates everything,
 * and cleanup removes it after the child exits.
 */
export async function commandcodeSessionLaunch(input: SessionLaunchInput) {
  const model = input.model ?? resolveDefault(input.catalog, input.profileModel);
  const overlay = await createSessionOverlay("aiand-commandcode-", {
    // Nested under .commandcode/: the overlay dir becomes HOME,
    // and Command Code resolves its config root from HOME.
    ".commandcode/providers.json": `${JSON.stringify(
      {
        provider: {
          [COMMANDCODE_PROVIDER_ID]: buildCommandCodeProvider({
            baseUrl: commandCodeBaseUrl(input.baseUrl),
            catalog: input.catalog,
          }),
        },
      },
      null,
      2,
    )}\n`,
    ".commandcode/auth.json": `${JSON.stringify({
      [COMMANDCODE_PROVIDER_ID]: { type: "api", key: input.apiKey },
    })}\n`,
    ".commandcode/config.json": `${JSON.stringify({
      model: `${COMMANDCODE_SELECTION_PREFIX}${model}`,
    })}\n`,
  });
  const args: string[] = [];
  // Non-TTY stdin: ask for an explicit one-shot mode, so a
  // piped prompt processes and exits instead of sitting on an
  // interactive session.
  if (!process.stdin.isTTY) args.push("-p");
  return {
    env: {
      HOME: overlay.dir,
      // The documented Codex-style exception to "the key never
      // rides the child env": Command Code's `-p` gate checks
      // COMMAND_CODE_API_KEY (else the user's own auth.json
      // login, which the overlay does not carry) before any
      // provider request, and no file holds a key it accepts —
      // so the session key must ride the env by necessity.
      // run-agent strips AIAND_API_KEY from the child env; this
      // variable is our own addition. The gate also feeds the
      // built-in gateway's whoami/fingerprint telemetry, so
      // DO_NOT_TRACK keeps the key from being fingerprinted to
      // Command Code's gateway (live-proven: it makes
      // isTelemetryEnabled return false).
      COMMAND_CODE_API_KEY: input.apiKey,
      DO_NOT_TRACK: "1",
    },
    // --model outranks the overlay's model pin at runtime and
    // --config persists over our config.json, so a user-supplied
    // `--flag value` or `--flag=value` of these is dropped: the
    // launcher's routing cannot be overridden.
    args,
    stripPassthroughFlags: ["--model", "-m", "--config"],
    cleanup: overlay.cleanup,
  };
}
