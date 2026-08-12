import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryIngestStore, setIngestStore } from "../../../db/store.ts";
import { POST as approve } from "./approve/route.ts";
import { POST } from "./route.ts";
import { CODE_TTL_MS, getClaimStore, normalizeUserCode, resetClaimStore } from "./store.ts";

const ORIGIN = "http://localhost:3000";

function claim(body: unknown): Request {
  return new Request(`${ORIGIN}/api/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function approval(fields: Record<string, string>): Request {
  return new Request(`${ORIGIN}/api/claim/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fields),
  });
}

async function start(handle = "octocat"): Promise<{ userCode: string; deviceCode: string }> {
  const response = await POST(claim({ action: "start", handle }));
  expect(response.status).toBe(201);
  return response.json();
}

/** Polls are rate limited, so tests that poll twice have to let the clock move. */
function tick(ms = 5_000): void {
  vi.setSystemTime(new Date(Date.now() + ms));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-13T09:00:00Z"));
  vi.stubEnv("GITHUB_CLIENT_ID", "");
  vi.stubEnv("GITHUB_CLIENT_SECRET", "");
  setIngestStore(new InMemoryIngestStore());
  resetClaimStore();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  setIngestStore(null);
  resetClaimStore();
});

describe("POST /api/claim — start", () => {
  it("returns a short code, a secret device code and a URL that carries the code", async () => {
    const body = await start();

    expect(body.userCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(body.deviceCode).toMatch(/^[0-9a-f]{64}$/);
    expect(body).toMatchObject({
      verificationUrl: `${ORIGIN}/claim/${body.userCode}`,
      expiresIn: 600,
      interval: 2,
    });
  });

  it("never reuses a code between two claims", async () => {
    const first = await start();
    const second = await start();

    expect(second.userCode).not.toBe(first.userCode);
    expect(second.deviceCode).not.toBe(first.deviceCode);
  });

  it("refuses to hand out a code no one could approve", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const response = await POST(claim({ action: "start" }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "claim unavailable" });
  });
});

describe("POST /api/claim — poll", () => {
  it("reports pending until the code is approved", async () => {
    const { deviceCode } = await start();

    const response = await POST(claim({ action: "poll", deviceCode }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "pending" });
  });

  it("returns a bearer token bound to the approved handle", async () => {
    const { userCode, deviceCode } = await start();
    await approve(approval({ code: userCode, handle: "octocat", intent: "approve" }));

    tick();
    const response = await POST(claim({ action: "poll", deviceCode }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ status: "approved", handle: "octocat", tokenType: "Bearer" });
    expect(body.token).toMatch(/^aow_/);
  });

  it("rejects an unknown device code with 404", async () => {
    const response = await POST(claim({ action: "poll", deviceCode: "0".repeat(64) }));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ status: "unknown" });
  });

  it("asks a CLI that polls too fast to slow down", async () => {
    const { deviceCode } = await start();

    await POST(claim({ action: "poll", deviceCode }));
    const second = await POST(claim({ action: "poll", deviceCode }));

    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("2");
  });

  it("reports a declined code as 403 and mints nothing", async () => {
    const { userCode, deviceCode } = await start();
    await approve(approval({ code: userCode, intent: "deny" }));

    tick();
    const response = await POST(claim({ action: "poll", deviceCode }));

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.status).toBe("denied");
    expect(body.token).toBeUndefined();
  });
});

describe("codes expire after ten minutes", () => {
  it("refuses to approve an expired code", async () => {
    const { userCode, deviceCode } = await start();

    vi.setSystemTime(new Date(Date.now() + CODE_TTL_MS + 1_000));
    const redirect = await approve(approval({ code: userCode, handle: "octocat" }));

    expect(redirect.headers.get("location")).toBe(`${ORIGIN}/claim/${userCode}?status=expired`);

    const response = await POST(claim({ action: "poll", deviceCode }));
    expect(response.status).toBe(410);
    const body = await response.json();
    expect(body.status).toBe("expired");
    expect(body.token).toBeUndefined();
  });

  it("still honours a code approved with one second to spare", async () => {
    const { userCode, deviceCode } = await start();

    vi.setSystemTime(new Date(Date.now() + CODE_TTL_MS - 1_000));
    await approve(approval({ code: userCode, handle: "octocat" }));

    tick(500);
    const response = await POST(claim({ action: "poll", deviceCode }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "approved" });
  });
});

describe("codes are single-use", () => {
  it("hands the token over exactly once", async () => {
    const { userCode, deviceCode } = await start();
    await approve(approval({ code: userCode, handle: "octocat" }));

    tick();
    const first = await POST(claim({ action: "poll", deviceCode }));
    expect(first.status).toBe(200);

    tick();
    const second = await POST(claim({ action: "poll", deviceCode }));

    expect(second.status).toBe(410);
    const body = await second.json();
    expect(body.status).toBe("used");
    expect(body.token).toBeUndefined();
  });

  it("refuses to approve the same code twice", async () => {
    const { userCode } = await start();
    const store = getClaimStore();

    expect(
      await store.approve(userCode, { handle: "octocat", githubId: null, avatarUrl: null }),
    ).toEqual({
      ok: true,
      status: "approved",
      handle: "octocat",
    });

    /** A second approval must not mint a second token for the same code. */
    expect(
      await store.approve(userCode, { handle: "someone-else", githubId: null, avatarUrl: null }),
    ).toEqual({ ok: false, status: "approved" });
  });

  it("refuses to approve a code that was already spent", async () => {
    const { userCode, deviceCode } = await start();
    const store = getClaimStore();
    await store.approve(userCode, { handle: "octocat", githubId: null, avatarUrl: null });

    tick();
    store.poll(deviceCode);

    expect(
      await store.approve(userCode, { handle: "octocat", githubId: null, avatarUrl: null }),
    ).toEqual({
      ok: false,
      status: "used",
    });
  });
});

describe("local approval", () => {
  it("is refused once a GitHub app is configured", async () => {
    const { userCode } = await start();
    vi.stubEnv("GITHUB_CLIENT_ID", "client");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "secret");

    const response = await approve(approval({ code: userCode, handle: "octocat" }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "forbidden" });
  });

  it("rejects anything that is not a GitHub handle", async () => {
    const { userCode } = await start();

    const response = await approve(approval({ code: userCode, handle: "not a handle" }));

    expect(response.headers.get("location")).toBe(`${ORIGIN}/claim/${userCode}?status=badhandle`);
    expect(getClaimStore().lookup(userCode)?.status).toBe("pending");
  });
});

describe("code normalization", () => {
  it("accepts a code typed back without its dash or in lower case", () => {
    expect(normalizeUserCode("abcd-efgh")).toBe("ABCD-EFGH");
    expect(normalizeUserCode("abcdefgh")).toBe("ABCD-EFGH");
    expect(normalizeUserCode(" ABCD EFGH ")).toBe("ABCD-EFGH");
  });

  it("approves a code that was retyped without its dash", async () => {
    const { userCode, deviceCode } = await start();

    await approve(approval({ code: userCode.replace("-", "").toLowerCase(), handle: "octocat" }));

    tick();
    await expect((await POST(claim({ action: "poll", deviceCode }))).json()).resolves.toMatchObject(
      {
        status: "approved",
      },
    );
  });
});

describe("bad requests", () => {
  it("rejects a body that is not JSON", async () => {
    const request = new Request(`${ORIGIN}/api/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });

    expect((await POST(request)).status).toBe(400);
  });

  it("rejects an unknown action", async () => {
    expect((await POST(claim({ action: "approve" }))).status).toBe(400);
  });

  it("rejects a poll with no device code", async () => {
    expect((await POST(claim({ action: "poll" }))).status).toBe(400);
  });
});
