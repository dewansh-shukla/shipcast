import type { IngestPayload } from "@ao-wrapped/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryIngestStore, setIngestStore } from "../../../db/store.ts";
import { POST as ingest } from "../ingest/route.ts";
import { POST as approve } from "./approve/route.ts";
import { GET as githubCallback } from "./github/callback/route.ts";
import { GET as githubStart } from "./github/route.ts";
import { POST as claimRoute } from "./route.ts";
import { getClaimStore, resetClaimStore } from "./store.ts";

/**
 * TICKET 10 — the cold run, end to end.
 *
 * These tests are the acceptance criterion for the flow: a machine with no
 * stored credentials reaches a token, and that token is accepted by the ingest
 * route it was minted for. The mismatch case matters just as much — a token
 * that could report for someone else's handle would make every row on the board
 * unfalsifiable.
 */

const ORIGIN = "http://localhost:3000";

function payloadFor(handle: string): IngestPayload {
  return {
    schema: 1,
    handle,
    aoVersion: "0.12.3",
    collectorVersion: "0.1.0",
    // A single ISO week (2026-W33). Ingest rejects windows spanning more than
    // one week, because a season is the unit a snapshot is keyed by.
    window: { from: "2026-08-10", to: "2026-08-16" },
    totals: {
      tasks: 4,
      merges: 2,
      ciRecoveries: 0,
      interventions: 1,
      peakParallelism: 3,
      harnesses: 1,
      turns: 0,
      repos: 1,
    },
    /** Sums to totals.tasks: every session ends in exactly one outcome. */
    outcomes: { clean: 2, died: 1, opened_unmerged: 1 },
    sizeMix: { s: 1, m: 1 },
    topRepoShare: 1,
    agents: [
      {
        harness: "claude-code",
        tasks: 4,
        merges: 2,
        recoveries: 0,
        interventions: 1,
        died: 1,
        turns: 0,
        medianMinutes: 12,
      },
    ],
    graveyard: [{ harness: "claude-code", cause: "no_signal" }],
  };
}

function claim(body: unknown): Request {
  return new Request(`${ORIGIN}/api/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ingestRequest(payload: IngestPayload, token: string): Request {
  return new Request(`${ORIGIN}/api/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

function tick(ms = 5_000): void {
  vi.setSystemTime(new Date(Date.now() + ms));
}

/** Stands in for GitHub's token exchange and user endpoint. */
function stubGithub(user: { login: string; id: number }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("login/oauth/access_token")) {
        return Response.json({ access_token: "gho_test", token_type: "bearer" });
      }
      if (url.includes("api.github.com/user")) {
        return Response.json({ ...user, avatar_url: "https://avatars.example/u" });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }),
  );
}

let store: InMemoryIngestStore;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-13T09:00:00Z"));
  vi.stubEnv("GITHUB_CLIENT_ID", "");
  vi.stubEnv("GITHUB_CLIENT_SECRET", "");
  store = new InMemoryIngestStore();
  setIngestStore(store);
  resetClaimStore();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setIngestStore(null);
  resetClaimStore();
});

describe("a cold run reaches the board", () => {
  it("claims a token and ingests a payload with it", async () => {
    const started = await (await claimRoute(claim({ action: "start", handle: "octocat" }))).json();

    await approve(
      new Request(`${ORIGIN}/api/claim/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: started.userCode, handle: "octocat", intent: "approve" }),
      }),
    );

    tick();
    const polled = await (
      await claimRoute(claim({ action: "poll", deviceCode: started.deviceCode }))
    ).json();
    expect(polled.status).toBe("approved");

    const response = await ingest(ingestRequest(payloadFor("octocat"), polled.token));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ ok: true, handle: "octocat" });
  });

  it("keeps one builder when the same person connects a second machine", async () => {
    const tokens: string[] = [];

    for (const _machine of [1, 2]) {
      const started = await (
        await claimRoute(claim({ action: "start", handle: "octocat" }))
      ).json();
      await getClaimStore().approve(started.userCode, {
        handle: "octocat",
        githubId: "583231",
        avatarUrl: null,
      });
      tick();
      const polled = await (
        await claimRoute(claim({ action: "poll", deviceCode: started.deviceCode }))
      ).json();
      tokens.push(polled.token);
    }

    expect(tokens[0]).not.toBe(tokens[1]);

    const first = await store.builderForToken(tokens[0]!);
    const second = await store.builderForToken(tokens[1]!);
    expect(first?.id).toBe(second?.id);
  });
});

describe("a token cannot report for another handle", () => {
  it("is refused with 403 and stores nothing", async () => {
    const started = await (await claimRoute(claim({ action: "start", handle: "octocat" }))).json();
    await getClaimStore().approve(started.userCode, {
      handle: "octocat",
      githubId: null,
      avatarUrl: null,
    });
    tick();
    const { token } = await (
      await claimRoute(claim({ action: "poll", deviceCode: started.deviceCode }))
    ).json();

    const response = await ingest(ingestRequest(payloadFor("someone-else"), token));

    expect(response.status).toBe(403);
    const builder = await store.builderForToken(token);
    expect(store.snapshotsFor(builder!.id)).toHaveLength(0);
  });
});

describe("GitHub sign-in", () => {
  beforeEach(() => {
    vi.stubEnv("GITHUB_CLIENT_ID", "Iv1.test");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "shhh");
  });

  async function startOauth(userCode: string): Promise<string> {
    const response = await githubStart(
      new Request(`${ORIGIN}/api/claim/github?code=${encodeURIComponent(userCode)}`),
    );
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe("https://github.com");
    expect(location.searchParams.get("scope")).toBe("read:user");
    expect(location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/claim/github/callback`);
    return location.searchParams.get("state")!;
  }

  it("binds the token to the handle GitHub reports, not the one the CLI sent", async () => {
    const started = await (
      await claimRoute(claim({ action: "start", handle: "anonymous" }))
    ).json();
    const state = await startOauth(started.userCode);
    stubGithub({ login: "octocat", id: 583231 });

    const callback = await githubCallback(
      new Request(`${ORIGIN}/api/claim/github/callback?code=abc&state=${state}`),
    );
    expect(callback.headers.get("location")).toBe(
      `${ORIGIN}/claim/${started.userCode}?status=approved`,
    );

    tick();
    const polled = await (
      await claimRoute(claim({ action: "poll", deviceCode: started.deviceCode }))
    ).json();

    expect(polled.handle).toBe("octocat");
    const builder = await store.builderForToken(polled.token);
    expect(builder).toMatchObject({ handle: "octocat", githubId: "583231" });
  });

  it("declines the code when the user cancels at GitHub", async () => {
    const started = await (await claimRoute(claim({ action: "start", handle: "octocat" }))).json();
    const state = await startOauth(started.userCode);

    const callback = await githubCallback(
      new Request(`${ORIGIN}/api/claim/github/callback?error=access_denied&state=${state}`),
    );

    expect(callback.headers.get("location")).toBe(
      `${ORIGIN}/claim/${started.userCode}?status=denied`,
    );
    expect((await getClaimStore().lookup(started.userCode))?.status).toBe("denied");
  });

  it("ignores a callback carrying a state it never issued", async () => {
    const started = await (await claimRoute(claim({ action: "start", handle: "octocat" }))).json();

    const callback = await githubCallback(
      new Request(`${ORIGIN}/api/claim/github/callback?code=abc&state=forged`),
    );

    expect(callback.headers.get("location")).toBe(`${ORIGIN}/claim?status=badstate`);
    expect((await getClaimStore().lookup(started.userCode))?.status).toBe("pending");
  });

  it("leaves the code pending when GitHub will not identify the user", async () => {
    const started = await (await claimRoute(claim({ action: "start", handle: "octocat" }))).json();
    const state = await startOauth(started.userCode);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    );

    const callback = await githubCallback(
      new Request(`${ORIGIN}/api/claim/github/callback?code=abc&state=${state}`),
    );

    expect(callback.headers.get("location")).toBe(
      `${ORIGIN}/claim/${started.userCode}?status=error`,
    );
    expect((await getClaimStore().lookup(started.userCode))?.status).toBe("pending");
  });

  it("sends an expired code back to its page rather than to GitHub", async () => {
    const started = await (await claimRoute(claim({ action: "start", handle: "octocat" }))).json();
    tick(11 * 60 * 1000);

    const response = await githubStart(
      new Request(`${ORIGIN}/api/claim/github?code=${started.userCode}`),
    );

    expect(response.headers.get("location")).toBe(
      `${ORIGIN}/claim/${started.userCode}?status=expired`,
    );
  });
});
