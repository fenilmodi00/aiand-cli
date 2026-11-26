import { basename, dirname, resolve } from "node:path";
import { CliError } from "./cli/errors.js";

// secrets.ts writes these two stores through the shared atomic writer. The
// encrypted file store and its key preflight both paths in secrets-file.ts.
const DIRECT_SECRET_STORE_FILES: Record<string, true> = {
  "secret-store.dpapi.json": true,
  "credentials-plaintext.json": true,
};

/** Refuse a direct secret-store write into a config dir inside a git work tree. */
export async function refuseDirectSecretStoreWrite(
  filePath: string,
  storeDir: string,
): Promise<void> {
  if (DIRECT_SECRET_STORE_FILES[basename(filePath)] !== true) return;
  if (resolve(dirname(filePath)) !== resolve(storeDir)) return;
  await refuseGitWorkTree(filePath);
}

/** Refuse a file-based key store in a git work tree unless explicitly allowed. */
export async function refuseGitWorkTree(path: string): Promise<void> {
  // managed-file.ts uses the atomic writer, which also needs this check.
  // Load it only for a store write so the two modules do not form a static cycle.
  const { ALLOW_GIT_TRACKED_ENV, gitWorkTreeFor } = await import("./agents/managed-file.js");
  const tracked = await gitWorkTreeFor(path);
  if (tracked !== null && process.env[ALLOW_GIT_TRACKED_ENV] !== "1") {
    throw new CliError(
      `Refusing to keep your ai& key in ${tracked.real}: it is inside the git repository at ${tracked.repo}.`,
      {
        hint: `Move the config directory out of the repository (set AIAND_CONFIG_DIR), or add it to the repository's .gitignore and re-run with ${ALLOW_GIT_TRACKED_ENV}=1.`,
      },
    );
  }
}
