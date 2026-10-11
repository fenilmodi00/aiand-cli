/**
 * First-run marker for the splash animation: one flag in the config dir, so
 * the animation plays once per fresh install and never on CI or pipes.
 * `aiand welcome` replays it explicitly.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, writeFileAtomic } from "../config.js";

type WelcomeState = { welcomed: boolean };

function welcomePath(): string {
  return join(configDir(), "welcome.json");
}

/** True when this install has already played the splash. */
export function hasPlayedWelcome(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(welcomePath(), "utf8")) as Partial<WelcomeState>;
    return parsed.welcomed === true;
  } catch {
    return false;
  }
}

/** Mark the splash as played. A write failure is not fatal: it replays once. */
export async function markWelcomePlayed(): Promise<void> {
  const state: WelcomeState = { welcomed: true };
  await writeFileAtomic(welcomePath(), `${JSON.stringify(state)}\n`);
}
