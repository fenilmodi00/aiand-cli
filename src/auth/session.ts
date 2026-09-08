import { openSession } from "../api/client.js";
import type { Session } from "../api/client.js";
import { NotLoggedInError } from "../cli/errors.js";
import { confirm, isInteractive } from "../cli/prompt.js";
import * as login from "../commands/login.js";
import { resolveProfile } from "../config.js";

export type ResolvedSession = {
  key: string;
  source: "env" | "device" | "paste";
  profile: string;
};

/**
 * A usable API key or a clean exit. `AIAND_API_KEY` wins outright (openSession
 * returns no credential); a stored session reports its origin; signed-out
 * interactive users are offered one device-login attempt before the
 * NotLoggedInError (exit 2) propagates.
 */
export async function requireSessionKey(profileOverride?: string): Promise<ResolvedSession> {
  const profile = resolveProfile(profileOverride);
  const toResolved = (session: Session): ResolvedSession => {
    const origin = (session.credential as { origin?: "device" | "paste" } | null)?.origin;
    return {
      key: session.token,
      source: session.credential ? (origin === "paste" ? "paste" : "device") : "env",
      profile: profile.name,
    };
  };

  try {
    return toResolved(await openSession(profile));
  } catch (error) {
    if (!(error instanceof NotLoggedInError) || !isInteractive()) throw error;

    const wantsLogin = await confirm("Not signed in. Run aiand login now?", { default: true });
    if (!wantsLogin) throw error;

    await login.run(profileOverride ? ["--profile", profileOverride] : []);
    return toResolved(await openSession(profile));
  }
}