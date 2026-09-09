import { openSession } from "../api/client.js";
import type { Session } from "../api/client.js";
import { NotLoggedInError } from "../cli/errors.js";
import { confirm, isInteractive } from "../cli/prompt.js";
import * as login from "../commands/login.js";
import { resolveProfile } from "../config.js";

export type ResolvedSession = {
  key: string;
};

/**
 * A usable API key or a clean exit. Signed-out interactive users are offered
 * one login attempt before the NotLoggedInError (exit 2) propagates.
 */
export async function requireSessionKey(profileOverride?: string): Promise<ResolvedSession> {
  const profile = resolveProfile(profileOverride);
  const toKey = (session: Session): ResolvedSession => ({ key: session.token });

  try {
    return toKey(await openSession(profile));
  } catch (error) {
    if (!(error instanceof NotLoggedInError) || !isInteractive()) throw error;

    const wantsLogin = await confirm("Not signed in. Run aiand login now?", { default: true });
    if (!wantsLogin) throw error;

    await login.run(profileOverride ? ["--profile", profileOverride] : []);
    return toKey(await openSession(profile));
  }
}