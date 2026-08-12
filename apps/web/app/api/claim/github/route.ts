import { getClaimStore, isGithubConfigured, normalizeUserCode, siteOrigin } from "../store.ts";

/**
 * TICKET 10 — start the GitHub round trip.
 *
 * The approval page links here rather than to GitHub directly, so the OAuth
 * `state` is minted server-side and bound to the code being approved. A
 * callback carrying a state we did not issue is refused.
 */

export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";

/** `read:user` is the narrowest scope that returns a login and a numeric id. */
const SCOPE = "read:user";

export function githubRedirectUri(origin: string): string {
  return `${origin}/api/claim/github/callback`;
}

export async function GET(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  const userCode = normalizeUserCode(requestUrl.searchParams.get("code") ?? "");
  const origin = siteOrigin(request);

  if (!userCode) return Response.redirect(`${origin}/claim`, 302);

  const back = (status: string) =>
    Response.redirect(`${origin}/claim/${encodeURIComponent(userCode)}?status=${status}`, 302);

  if (!isGithubConfigured()) return back("unconfigured");

  const begun = getClaimStore().beginOauth(userCode);
  if ("error" in begun) return back(begun.error);

  const authorize = new URL(GITHUB_AUTHORIZE_URL);
  authorize.searchParams.set("client_id", process.env.GITHUB_CLIENT_ID!.trim());
  authorize.searchParams.set("redirect_uri", githubRedirectUri(origin));
  authorize.searchParams.set("scope", SCOPE);
  authorize.searchParams.set("state", begun.state);
  authorize.searchParams.set("allow_signup", "false");

  return Response.redirect(authorize.toString(), 302);
}
