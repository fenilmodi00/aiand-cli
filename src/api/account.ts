import { ApiError } from "../cli/errors.js";
import { requestJson, publicRequest, type Session } from "./client.js";

export type AccountUser = { id: string; email: string };
export type AccountOrg = { id: string; name: string };

export function getUser(session: Session): Promise<AccountUser> {
  return requestJson<AccountUser>(session, {
    path: "/api/user",
    baseUrl: session.profile.authUrl,
  });
}

export function listOrgs(session: Session): Promise<AccountOrg[]> {
  return requestJson<AccountOrg[]>(session, {
    path: "/api/orgs",
    baseUrl: session.profile.authUrl,
  });
}

/**
 * Check a raw key against the auth endpoint without any session machinery —
 * used by paste-login, where there is no stored credential yet to build a
 * Session from. 401 means the key itself is wrong; anything else is a server
 * problem the caller should surface as-is.
 */
export async function validateKey(key: string, authUrl: string): Promise<AccountUser> {
  const response = await publicRequest(`${authUrl}/api/user`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (response.status === 401) {
    throw new ApiError(401, "That key was rejected.", { hint: "Check the key and try again." });
  }
  if (!response.ok) {
    throw new ApiError(response.status, `Key validation failed (HTTP ${response.status}).`);
  }
  return (await response.json()) as AccountUser;
}
