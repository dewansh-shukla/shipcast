import {
  POLL_INTERVAL_SECONDS,
  ClaimUnavailableError,
  getClaimStore,
  isGithubConfigured,
  isLocalApprovalAllowed,
  siteOrigin,
  type ClaimStatus,
} from "./store.ts";

/**
 * TICKET 10 — device claim.
 *
 * Two actions on one endpoint, because the collector only ever needs two:
 *
 *   POST {"action":"start"}                   → a short code and a URL to open
 *   POST {"action":"poll","deviceCode":"…"}   → the bearer token, once approved
 *
 * The CLI never sees a password, a GitHub token or an OAuth secret. It prints
 * the URL and waits. Everything that requires an identity happens in a browser
 * the user already trusts.
 */

/** Where the CLI sends the user. Carries the code so nothing is retyped. */
function verificationUrl(origin: string, userCode: string): string {
  return `${origin}/claim/${encodeURIComponent(userCode)}`;
}

function badRequest(reason: string): Response {
  return Response.json({ error: "invalid request", reason }, { status: 400 });
}

/** One status → one HTTP code, so a CLI can branch on either. */
const POLL_STATUS_CODES: Record<ClaimStatus, number> = {
  pending: 200,
  approved: 200,
  denied: 403,
  expired: 410,
  used: 410,
  unknown: 404,
};

const POLL_REASONS: Record<ClaimStatus, string> = {
  pending: "not approved yet",
  approved: "approved",
  denied: "the code was declined in the browser",
  expired: "the code expired — codes are valid for ten minutes",
  used: "this code was already exchanged for a token",
  unknown: "no such device code",
};

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("body is not JSON");
  }

  if (typeof body !== "object" || body === null) return badRequest("body must be an object");
  const input = body as Record<string, unknown>;
  const action = input.action ?? "start";

  if (action === "start") return start(request, input);
  if (action === "poll") return poll(input);
  return badRequest(`unknown action: ${String(action)}`);
}

function start(request: Request, input: Record<string, unknown>): Response {
  /**
   * With no GitHub app configured and no local fallback there is no way to
   * approve a code, so handing one out would send the user to a dead page.
   */
  if (!isGithubConfigured() && !isLocalApprovalAllowed()) {
    return Response.json(
      {
        error: "claim unavailable",
        reason: "this board has no GitHub app configured, so codes cannot be approved",
      },
      { status: 503 },
    );
  }

  const hint = typeof input.handle === "string" ? input.handle : null;
  const started = getClaimStore().start(hint);
  const origin = siteOrigin(request);

  return Response.json(
    {
      userCode: started.userCode,
      deviceCode: started.deviceCode,
      verificationUrl: verificationUrl(origin, started.userCode),
      expiresIn: started.expiresInSeconds,
      interval: started.intervalSeconds,
    },
    { status: 201 },
  );
}

function poll(input: Record<string, unknown>): Response {
  const deviceCode = typeof input.deviceCode === "string" ? input.deviceCode.trim() : "";
  if (!deviceCode) return badRequest("deviceCode is required to poll");

  let result;
  try {
    result = getClaimStore().poll(deviceCode);
  } catch (error) {
    if (error instanceof ClaimUnavailableError) {
      return Response.json({ error: "claim unavailable", reason: error.message }, { status: 503 });
    }
    throw error;
  }

  if (result.retryAfterSeconds !== undefined) {
    return Response.json(
      { status: "pending", reason: "polling too fast", interval: result.retryAfterSeconds },
      { status: 429, headers: { "retry-after": String(result.retryAfterSeconds) } },
    );
  }

  if (result.status === "approved") {
    return Response.json({
      status: "approved",
      token: result.token,
      handle: result.handle,
      tokenType: "Bearer",
    });
  }

  return Response.json(
    {
      status: result.status,
      reason: POLL_REASONS[result.status],
      interval: POLL_INTERVAL_SECONDS,
    },
    { status: POLL_STATUS_CODES[result.status] },
  );
}
