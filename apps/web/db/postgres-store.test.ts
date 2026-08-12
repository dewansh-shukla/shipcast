import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { IngestPayload } from "@ao-wrapped/shared";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as ingest } from "../app/api/ingest/route.ts";
import { getClaimStore, resetClaimStore } from "../app/api/claim/store.ts";
import { getWrappedCard } from "../app/w/[handle]/card-data.ts";
import { closeDatabase, redact } from "./client.ts";
import { PostgresIngestStore, type IngestDatabase } from "./postgres-store.ts";
import * as schema from "./schema.ts";
import {
  InMemoryIngestStore,
  UnknownBuilderError,
  getIngestStore,
  setIngestStore,
} from "./store.ts";

/**
 * TICKET 16 — the Postgres store, against Postgres.
 *
 * These run on PGlite: real Postgres compiled to WASM, in this process, with no
 * network and no server to provision. The alternative was mocking drizzle,
 * which would have proved only that the mock agrees with itself — and the one
 * property this ticket exists to guarantee, that a republish replaces instead
 * of accumulating, lives in `ON CONFLICT` and a unique constraint. Both are
 * database behaviour. A mock cannot test them.
 *
 * The schema is built by running `db/migrations/*.sql` exactly as committed, so
 * these also serve as the first execution of `0001_weekly_seasons.sql` — its
 * hand-written backfill had never been run against a real Postgres before.
 */

const MIGRATIONS = [
  "0000_init.sql",
  "0001_weekly_seasons.sql",
  "0002_device_tokens.sql",
  "0003_claim_codes.sql",
];

async function applyMigrations(pg: PGlite): Promise<void> {
  for (const file of MIGRATIONS) {
    const sql = await readFile(join(import.meta.dirname, "migrations", file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim() === "") continue;
      await pg.exec(statement);
    }
  }
}

function payload(overrides: Partial<IngestPayload> = {}): IngestPayload {
  return {
    schema: 1,
    handle: "octocat",
    aoVersion: "0.12.3",
    collectorVersion: "0.1.0",
    /** 2026-W33: Monday the 10th to Sunday the 16th. */
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
    outcomes: { clean: 5, ci_recovered: 3, died: 1 },
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
    ...overrides,
  };
}

let pg: PGlite;
let db: IngestDatabase;
let store: PostgresIngestStore;

beforeAll(async () => {
  pg = new PGlite();
  await applyMigrations(pg);
  db = drizzle(pg, { schema }) as unknown as IngestDatabase;
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  /** Cascades to snapshots and agent_stats, so each test starts empty. */
  await pg.exec(`truncate table "builders" cascade`);
  store = new PostgresIngestStore(db);
});

async function builderId(handle = "octocat"): Promise<string> {
  return (await store.upsertBuilder({ handle })).id;
}

describe("PostgresIngestStore", () => {
  it("stores every payload counter and adds none of its own", async () => {
    const id = await builderId();

    const { snapshot, agents } = await store.saveSnapshot(id, payload());

    expect(snapshot.weekKey).toBe("2026-W33");
    expect(snapshot.merges).toBe(9);
    expect(snapshot.turns).toBe(187);
    expect(snapshot.topRepoShare).toBeCloseTo(0.35);
    expect(snapshot.outcomes).toEqual({ clean: 5, ci_recovered: 3, died: 1 });
    expect(snapshot.graveyard).toEqual([{ harness: "claude-code", cause: "merge_conflict" }]);
    expect(Object.keys(snapshot)).not.toContain("score");

    expect(agents.map((row) => row.harness).sort()).toEqual(["claude-code", "codex"]);
    const unmetered = agents.find((row) => row.harness === "codex");
    /** Absent stays absent rather than becoming a zero, which reads as "spent nothing". */
    expect(unmetered?.inputTokens).toBeNull();
  });

  /**
   * The golden one. Continuous sync (ticket 14) republishes the same builder
   * and week on every tick, so a write that accumulated instead of replacing
   * would inflate a builder's counters all day and quietly wreck the board.
   */
  it("replaces rather than accumulates when the same week is republished", async () => {
    const id = await builderId();

    const first = await store.saveSnapshot(id, payload());
    expect(first.replaced).toBe(false);

    for (const merges of [10, 11, 12]) {
      const again = await store.saveSnapshot(
        id,
        payload({ totals: { ...payload().totals, merges } }),
      );
      expect(again.replaced).toBe(true);
      /** Same row throughout — an upsert, not an insert with a tidy-up after. */
      expect(again.snapshot.id).toBe(first.snapshot.id);
    }

    const stored = await store.snapshotsFor(id);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.snapshot.merges).toBe(12);
    /** Four publishes, two agents — not eight rows. */
    expect(stored[0]!.agents).toHaveLength(2);
  });

  it("replaces the agent roster wholesale so a harness can drop out of a week", async () => {
    const id = await builderId();
    await store.saveSnapshot(id, payload());

    const solo = payload();
    solo.agents = [solo.agents[0]!];
    await store.saveSnapshot(id, solo);

    const [stored] = await store.snapshotsFor(id);
    expect(stored!.agents.map((row) => row.harness)).toEqual(["claude-code"]);
  });

  it("opens a new season after the rollover and leaves the closed one intact", async () => {
    const id = await builderId();
    await store.saveSnapshot(id, payload());

    const next = await store.saveSnapshot(
      id,
      payload({
        window: { from: "2026-08-17", to: "2026-08-23" },
        totals: { ...payload().totals, merges: 1 },
      }),
    );
    expect(next.replaced).toBe(false);
    expect(next.snapshot.weekKey).toBe("2026-W34");

    const stored = await store.snapshotsFor(id);
    expect(stored.map((row) => row.snapshot.weekKey)).toEqual(["2026-W34", "2026-W33"]);
    expect(stored.find((row) => row.snapshot.weekKey === "2026-W33")!.snapshot.merges).toBe(9);
  });

  it("refuses to save against a builder that does not exist", async () => {
    await expect(
      store.saveSnapshot("00000000-0000-0000-0000-000000000000", payload()),
    ).rejects.toBeInstanceOf(UnknownBuilderError);
  });

  it("resolves a token to its builder and nothing to an unissued one", async () => {
    const id = await builderId();
    await store.issueToken(id, "token-a");

    await expect(store.builderForToken("token-a")).resolves.toMatchObject({ handle: "octocat" });
    await expect(store.builderForToken("token-b")).resolves.toBeNull();

    /** Re-issuing the same token is idempotent, not a constraint violation. */
    await expect(store.issueToken(id, "token-a")).resolves.toBeUndefined();
  });

  it("reuses the builder row when the same handle claims twice, whatever the casing", async () => {
    const first = await store.upsertBuilder({ handle: "OctoCat" });
    const second = await store.upsertBuilder({ handle: "octocat" });

    expect(second.id).toBe(first.id);
    /** The first casing wins; the card shows the builder's own. */
    expect(second.handle).toBe("OctoCat");
  });

  it("finds the latest snapshot by handle, case-insensitively", async () => {
    const id = await builderId("OctoCat");
    await store.saveSnapshot(id, payload());

    const found = await store.latestSnapshotForHandle("octocat");
    expect(found?.builder.id).toBe(id);
    expect(found?.snapshot.merges).toBe(9);
    expect(found?.agents).toHaveLength(2);
  });

  it("reads a past season back after the board has moved on", async () => {
    const id = await builderId();
    await store.saveSnapshot(id, payload({ totals: { ...payload().totals, merges: 2 } }));
    await store.saveSnapshot(
      id,
      payload({
        window: { from: "2026-08-17", to: "2026-08-23" },
        totals: { ...payload().totals, merges: 40 },
      }),
    );

    await expect(store.latestSnapshotForHandle("octocat")).resolves.toMatchObject({
      snapshot: { weekKey: "2026-W34", merges: 40 },
    });
    await expect(store.latestSnapshotForHandle("octocat", "2026-W33")).resolves.toMatchObject({
      snapshot: { weekKey: "2026-W33", merges: 2 },
    });
    /** A season the builder sat out is absent, not an error. */
    await expect(store.latestSnapshotForHandle("octocat", "2026-W32")).resolves.toBeNull();
  });

  it("has nothing for a handle nobody published under", async () => {
    await builderId();
    await expect(store.latestSnapshotForHandle("octocat")).resolves.toBeNull();
    await expect(store.latestSnapshotForHandle("nobody")).resolves.toBeNull();
  });

  it("returns one season's builders with their agents, and not another season's", async () => {
    const octocat = await builderId("octocat");
    const hubot = await builderId("hubot");

    await store.saveSnapshot(octocat, payload());
    await store.saveSnapshot(hubot, payload({ handle: "hubot" }));
    await store.saveSnapshot(
      hubot,
      payload({ handle: "hubot", window: { from: "2026-08-17", to: "2026-08-23" } }),
    );

    const past = await store.snapshotsForWeek("2026-W33");
    expect(past.map((row) => row.builder.handle)).toEqual(["hubot", "octocat"]);
    expect(past[0]!.agents).toHaveLength(2);

    const current = await store.snapshotsForWeek("2026-W34");
    expect(current.map((row) => row.builder.handle)).toEqual(["hubot"]);
  });

  it("is an empty season, not an error, when nobody published that week", async () => {
    await expect(store.snapshotsForWeek("2026-W01")).resolves.toEqual([]);
  });

  /**
   * The whole point of the ticket. A store built on a fresh connection over the
   * same database sees what the previous one wrote — which is what "survives a
   * restart" means once the process is gone.
   */
  it("hands a payload to a store that did not write it", async () => {
    const id = await builderId();
    await store.saveSnapshot(id, payload());

    const afterRestart = new PostgresIngestStore(db);
    const found = await afterRestart.latestSnapshotForHandle("octocat");

    expect(found?.snapshot.merges).toBe(9);
    expect(found?.agents).toHaveLength(2);
  });
});

/**
 * The ticket's done-when, end to end and against a real database: claim a
 * token, publish with it, lose the process, and still find the payload on the
 * card. Every step goes through the routes rather than the store directly,
 * because the thing that broke when `DATABASE_URL` was first set was the seam
 * between them, not either side.
 */
describe("claim, publish, restart", () => {
  beforeEach(async () => {
    await pg.exec(`truncate table "builders" cascade`);
    resetClaimStore();
    setIngestStore(new PostgresIngestStore(db));
  });

  afterEach(() => {
    resetClaimStore();
    setIngestStore(null);
  });

  /** Walk the device-claim flow and come back with a bearer token. */
  async function claimToken(handle: string): Promise<string> {
    const claims = getClaimStore();
    const started = await claims.start(handle);

    const approved = await claims.approve(started.userCode, {
      handle,
      githubId: "583231",
      avatarUrl: null,
    });
    expect(approved.ok).toBe(true);

    const polled = await claims.poll(started.deviceCode);
    expect(polled.status).toBe("approved");
    expect(polled.token).toBeTypeOf("string");
    return polled.token!;
  }

  function publish(token: string, body: IngestPayload): Request {
    return new Request("http://localhost/api/ingest", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("claims a token against Postgres, which the in-memory guard used to refuse", async () => {
    const token = await claimToken("octocat");

    /** The token resolves through the database, not through process memory. */
    const store = new PostgresIngestStore(db);
    await expect(store.builderForToken(token)).resolves.toMatchObject({ handle: "octocat" });
  });

  it("publishes, survives a restart, and shows up on the card", async () => {
    const token = await claimToken("octocat");

    const created = await ingest(publish(token, payload()));
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({ ok: true, weekKey: "2026-W33" });

    /**
     * Everything in memory is gone: a new store, a new claim store, no
     * carried-over token map. Only the database is left.
     */
    resetClaimStore();
    setIngestStore(new PostgresIngestStore(db));

    const card = await getWrappedCard("octocat");
    expect(card.state).toBe("connected");
    if (card.state !== "connected") return;
    expect(card.totals.merges).toBe(9);
    expect(card.agents).toHaveLength(2);

    /** And the token minted before the restart still authorises a publish. */
    const republished = await ingest(
      publish(token, payload({ totals: { ...payload().totals, merges: 21 } })),
    );
    expect(republished.status).toBe(200);
    await expect(republished.json()).resolves.toMatchObject({ replaced: true });

    const after = await new PostgresIngestStore(db).snapshotsFor(
      (await new PostgresIngestStore(db).latestSnapshotForHandle("octocat"))!.builder.id,
    );
    expect(after).toHaveLength(1);
    expect(after[0]!.snapshot.merges).toBe(21);
  });

  it("reuses one builder row when the same person claims twice", async () => {
    const first = await claimToken("octocat");
    const second = await claimToken("OctoCat");

    const store = new PostgresIngestStore(db);
    const a = await store.builderForToken(first);
    const b = await store.builderForToken(second);

    expect(a?.id).toBe(b?.id);
    /** Both tokens stay valid; a second claim does not revoke the first. */
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });
});

describe("redact", () => {
  it("strips the password from a connection string", () => {
    const leaked = `connect ECONNREFUSED postgres://neon:hunter2@ep-cool-1.aws.neon.tech/wrapped`;

    const safe = redact(leaked);

    expect(safe).not.toContain("hunter2");
    expect(safe).not.toContain("neon:");
    /** The host is kept: it is what makes the error diagnosable. */
    expect(safe).toContain("ep-cool-1.aws.neon.tech");
  });

  it("strips a password given as a keyword parameter", () => {
    expect(redact("password=hunter2 host=localhost")).toBe("password=<redacted> host=localhost");
  });

  it("leaves an error with no credentials in it alone", () => {
    expect(redact('relation "snapshots" does not exist')).toBe(
      'relation "snapshots" does not exist',
    );
  });
});

describe("getIngestStore", () => {
  const original = process.env.DATABASE_URL;

  beforeEach(() => {
    setIngestStore(null);
  });

  afterEach(async () => {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
    setIngestStore(null);
    await closeDatabase();
  });

  it("uses memory when DATABASE_URL is unset", () => {
    delete process.env.DATABASE_URL;
    expect(getIngestStore()).toBeInstanceOf(InMemoryIngestStore);
  });

  it("treats a blank DATABASE_URL as unset rather than as a database", () => {
    process.env.DATABASE_URL = "   ";
    expect(getIngestStore()).toBeInstanceOf(InMemoryIngestStore);
  });

  it("uses Postgres when DATABASE_URL is set, and never falls back to memory", () => {
    process.env.DATABASE_URL = "postgres://user:pw@localhost:5432/wrapped";

    const selected = getIngestStore();

    expect(selected).toBeInstanceOf(PostgresIngestStore);
    expect(selected).not.toBeInstanceOf(InMemoryIngestStore);
  });

  it("still lets a test inject its own store", () => {
    const injected = new InMemoryIngestStore();
    setIngestStore(injected);
    expect(getIngestStore()).toBe(injected);
  });
});
