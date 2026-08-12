import { getClaimStore, isGithubConfigured, siteOrigin } from "../../store.ts";
import { githubRedirectUri } from "../route.ts";

/**
 * TICKET 10 — finish the GitHub round trip and approve the code.
 *
 * The handle the token is bound to comes from GitHub here and nowhere else.
 * The CLI's `--handle` is a hint shown on the approval page; it never decides
 * whose numbers these are, which is what makes `/api/ingest`'s handle check
 * meaningful rather than decorative.
 */

const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";

interface GithubUser {
  login: string;
  id: number;
  avatar_url: string | null;
}

async function exchangeCode(code: string, redirectUri: string): Promise<string | null> {
  const response = await fetch(ACCESS_TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID?.trim(),
      client_secret: process.env.GITHUB_CLIENT_SECRET?.trim(),
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) return null;
  const body = (await response.json()) as { access_token?: unknown };
  return typeof body.access_token === "string" && body.access_token ? body.access_token : null;
}

async function fetchUser(accessToken: string): Promise<GithubUser | null> {
  const response = await fetch(USER_URL, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/vnd.github+json",
      "user-agent": "ao-wrapped",
    },
  });

  if (!response.ok) return null;
  const body = (await response.json()) as Partial<GithubUser>;
  if (typeof body.login !== "string" || typeof body.id !== "number") return null;
  return { login: body.login, id: body.id, avatar_url: body.avatar_url ?? null };
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const origin = siteOrigin(request);
  const state = url.searchParams.get("state") ?? "";
  const store = getClaimStore();

  const userCode = state ? await store.userCodeForOauthState(state) : null;
  const back = (status: string) =>
    Response.redirect(
      userCode
        ? `${origin}/claim/${encodeURIComponent(userCode)}?status=${status}`
        : `${origin}/claim?status=${status}`,
      302,
    );

  /** An unrecognised state is a forged or replayed callback. Say nothing more. */
  if (!userCode) return back("badstate");
  if (!isGithubConfigured()) return back("unconfigured");

  /** GitHub sends `error=access_denied` when the user cancels the consent screen. */
  if (url.searchParams.get("error")) {
    await store.deny(userCode);
    return back("denied");
  }

  const code = url.searchParams.get("code");
  if (!code) return back("error");

  let user: GithubUser | null = null;
  try {
    const accessToken = await exchangeCode(code, githubRedirectUri(origin));
    if (accessToken) user = await fetchUser(accessToken);
  } catch {
    user = null;
  }

  if (!user) return back("error");

  const result = await store.approve(userCode, {
    handle: user.login,
    githubId: String(user.id),
    avatarUrl: user.avatar_url,
  });

  return back(result.ok ? "approved" : result.status);
}
