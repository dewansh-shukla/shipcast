import {
  getClaimStore,
  isLocalApprovalAllowed,
  isValidHandle,
  normalizeUserCode,
  siteOrigin,
} from "../store.ts";

/**
 * TICKET 10 — approving a code without GitHub.
 *
 * A local checkout has no OAuth app, and telling a first-time reader to go
 * register one before they can see the flow work is how a front door stops
 * being a front door. So when — and only when — no GitHub app is configured and
 * this is not production, the approval page can approve a code against a typed
 * handle.
 *
 * The guard is not a formality. Without it this endpoint would let anyone mint
 * a token for any handle on the board.
 */

async function readFields(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get("content-type") ?? "";

  if (type.includes("application/json")) {
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null) return {};
    return Object.fromEntries(
      Object.entries(body as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
    );
  }

  const form = await request.formData();
  return Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value)]));
}

export async function POST(request: Request): Promise<Response> {
  const origin = siteOrigin(request);

  if (!isLocalApprovalAllowed()) {
    return Response.json(
      {
        error: "forbidden",
        reason: "this board approves codes through GitHub sign-in only",
      },
      { status: 403 },
    );
  }

  let fields: Record<string, string>;
  try {
    fields = await readFields(request);
  } catch {
    return Response.json({ error: "invalid request", reason: "unreadable body" }, { status: 400 });
  }

  const userCode = normalizeUserCode(fields.code ?? "");
  if (!userCode) {
    return Response.json({ error: "invalid request", reason: "code is required" }, { status: 400 });
  }

  const back = (status: string) =>
    Response.redirect(`${origin}/claim/${encodeURIComponent(userCode)}?status=${status}`, 303);

  const store = getClaimStore();

  if (fields.intent === "deny") {
    const denied = await store.deny(userCode);
    return back(denied.ok ? "denied" : denied.status);
  }

  const handle = (fields.handle ?? "").trim();
  if (!isValidHandle(handle)) return back("badhandle");

  const result = await store.approve(userCode, { handle, githubId: null, avatarUrl: null });
  return back(result.ok ? "approved" : result.status);
}
