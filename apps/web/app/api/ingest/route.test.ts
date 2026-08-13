import type { IngestPayload } from "@ao-wrapped/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryIngestStore, setIngestStore } from "../../../db/store.ts";
import { POST } from "./route.ts";

const TOKEN = "aow_test_token";

function validPayload(): IngestPayload {
  return {
    schema: 1,
    handle: "octocat",
    aoVersion: "0.12.3",
    collectorVersion: "0.1.0",
    /** One ISO week — 2026-W33 — because ingest rejects anything wider. */
    window: { from: "2026-08-10", to: "2026-08-16" },
    totals: {
      tasks: 12,
      merges: 9,
      ciRecoveries: 3,
      interventions: 2,
      peakParallelism: 4,
      harnesses: 2,
      turns: 187,
      repos: 3,
    },
    /** Sums to totals.tasks: every session ends in exactly one outcome. */
    outcomes: { clean: 5, ci_recovered: 3, died: 1, conflict_resolved: 1, opened_unmerged: 2 },
    sizeMix: { xs: 1, s: 3, m: 6, l: 2 },
    topRepoShare: 0.35,
    agents: [
      {
        harness: "claude-code",
        tasks: 8,
        merges: 6,
        recoveries: 2,
        interventions: 1,
        died: 1,
        turns: 140,
        medianMinutes: 11.5,
        inputTokens: 90_000,
        outputTokens: 42_000,
        cacheReadTokens: 99_000,
      },
      {
        harness: "codex",
        tasks: 4,
        merges: 3,
        recoveries: 1,
        interventions: 1,
        died: 0,
        turns: 47,
        medianMinutes: 8,
      },
    ],
    graveyard: [{ harness: "claude-code", cause: "merge_conflict" }],
  };
}

function post(body: unknown, token: string | null = TOKEN): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return new Request("http://localhost/api/ingest", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

let store: InMemoryIngestStore;
let builderId: string;

beforeEach(() => {
  /**
   * These publish twice on purpose — replacing a snapshot, crossing a rollover.
   * Ingest rate-limits a handle to one publish every thirty seconds, and
   * waiting that out is the only thing the wait would measure.
   */
  vi.stubEnv("AO_WRAPPED_MIN_PUBLISH_INTERVAL_MS", "0");

  store = new InMemoryIngestStore();
  builderId = store.addBuilder({ handle: "octocat", githubId: "583231" }).id;
  store.issueToken(builderId, TOKEN);
  setIngestStore(store);
});

afterEach(() => {
  vi.unstubAllEnvs();
  setIngestStore(null);
});

describe("POST /api/ingest", () => {
  it("stores a valid payload through the store interface", async () => {
    const response = await POST(post(validPayload()));

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.agents).toBe(2);
    expect(body.window).toEqual({ from: "2026-08-10", to: "2026-08-16" });
    expect(body.weekKey).toBe("2026-W33");

    const [stored] = store.snapshotsFor(builderId);
    expect(stored).toBeDefined();
    expect(stored!.snapshot.merges).toBe(9);
    expect(stored!.snapshot.turns).toBe(187);
    expect(stored!.snapshot.topRepoShare).toBeCloseTo(0.35);
    expect(stored!.agents.map((agent) => agent.harness)).toEqual(["claude-code", "codex"]);
    expect(stored!.agents[1]!.inputTokens).toBeNull();
  });

  it("never returns or stores a score", async () => {
    const response = await POST(post(validPayload()));
    const body = await response.json();

    expect(Object.keys(body)).not.toContain("score");
    const [stored] = store.snapshotsFor(builderId);
    expect(Object.keys(stored!.snapshot)).not.toContain("score");
  });

  it("replaces the snapshot when the same season is published twice", async () => {
    await POST(post(validPayload()));

    const second = validPayload();
    second.totals.merges = 11;
    /** The parts have to add up to the total ingest now checks against. */
    second.agents = second.agents.map((agent, index) => ({
      ...agent,
      merges: index === 0 ? 8 : 3,
    }));
    const response = await POST(post(second));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ replaced: true, weekKey: "2026-W33" });
    expect(store.snapshotsFor(builderId)).toHaveLength(1);
    expect(store.snapshotsFor(builderId)[0]!.snapshot.merges).toBe(11);
  });

  it("derives the season from the window instead of trusting the body", async () => {
    /**
     * The schema has no week field, so a collector's attempt to name its own
     * season arrives as an unknown key — and the stored key comes from the
     * dates either way.
     */
    const response = await POST(post({ ...validPayload(), weekKey: "2026-W01" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ unknownFields: ["weekKey"] });

    await POST(post(validPayload()));
    expect(store.snapshotsFor(builderId)[0]!.snapshot.weekKey).toBe("2026-W33");
  });

  it("rejects a window that spans more than one week, naming the field", async () => {
    const payload = validPayload();
    /** Saturday to the Wednesday after next: 2026-W31 through 2026-W33. */
    payload.window = { from: "2026-08-01", to: "2026-08-12" };

    const response = await POST(post(payload));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid payload");
    expect(body.fields).toEqual(["window.from", "window.to"]);
    expect(body.reason).toContain("more than one week");
    expect(store.snapshotsFor(builderId)).toHaveLength(0);
  });

  it("accepts a window that ends on Sunday and rejects one that reaches Monday", async () => {
    const sunday = validPayload();
    sunday.window = { from: "2026-08-10", to: "2026-08-16" };
    expect((await POST(post(sunday))).status).toBe(201);

    const monday = validPayload();
    monday.window = { from: "2026-08-10", to: "2026-08-17" };
    expect((await POST(post(monday))).status).toBe(400);

    /** The rejected payload left the season it tried to extend untouched. */
    expect(store.snapshotsFor(builderId)).toHaveLength(1);
    expect(store.snapshotsFor(builderId)[0]!.snapshot.windowTo).toBe("2026-08-16");
  });

  it("opens a new season after the rollover instead of replacing the last one", async () => {
    await POST(post(validPayload()));

    const next = validPayload();
    next.window = { from: "2026-08-17", to: "2026-08-23" };
    next.totals.merges = 1;
    next.agents = next.agents.map((agent, index) => ({
      ...agent,
      merges: index === 0 ? 1 : 0,
    }));
    const response = await POST(post(next));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      replaced: false,
      weekKey: "2026-W34",
    });

    const seasons = store.snapshotsFor(builderId);
    expect(seasons.map((row) => row.snapshot.weekKey)).toEqual(["2026-W34", "2026-W33"]);
    /** The closed season still reports what it reported. */
    expect(seasons.find((row) => row.snapshot.weekKey === "2026-W33")!.snapshot.merges).toBe(9);
  });

  it("rejects an unknown key with a 400 that names the field", async () => {
    const payload = { ...validPayload(), repoName: "dewansh-shukla/secret" };

    const response = await POST(post(payload));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid payload");
    expect(body.unknownFields).toEqual(["repoName"]);
    expect(body.reason).toContain("repoName");
    expect(store.snapshotsFor(builderId)).toHaveLength(0);
  });

  it("names a nested unknown key with its full path", async () => {
    const payload = validPayload();
    const body = { ...payload, totals: { ...payload.totals, branch: "main" } };

    const response = await POST(post(body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ unknownFields: ["totals.branch"] });
  });

  it("names an invalid value's field too", async () => {
    const payload = { ...validPayload(), topRepoShare: 4 };

    const response = await POST(post(payload));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.fields).toContain("topRepoShare");
  });

  it("rejects a missing token with 401", async () => {
    const response = await POST(post(validPayload(), null));

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    await expect(response.json()).resolves.toMatchObject({ error: "unauthorized" });
    expect(store.snapshotsFor(builderId)).toHaveLength(0);
  });

  it("rejects a bad token with 401", async () => {
    const response = await POST(post(validPayload(), "aow_not_a_real_token"));

    expect(response.status).toBe(401);
    expect(store.snapshotsFor(builderId)).toHaveLength(0);
  });

  it("rejects a malformed Authorization header with 401", async () => {
    const request = new Request("http://localhost/api/ingest", {
      method: "POST",
      headers: { authorization: TOKEN },
      body: JSON.stringify(validPayload()),
    });

    expect((await POST(request)).status).toBe(401);
  });

  it("refuses to let a token report for a different handle", async () => {
    const payload = { ...validPayload(), handle: "someone-else" };

    const response = await POST(post(payload));

    expect(response.status).toBe(403);
    expect(store.snapshotsFor(builderId)).toHaveLength(0);
  });

  it("rejects a body that is not JSON with 400", async () => {
    const request = new Request("http://localhost/api/ingest", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "{not json",
    });

    expect((await POST(request)).status).toBe(400);
  });
});
