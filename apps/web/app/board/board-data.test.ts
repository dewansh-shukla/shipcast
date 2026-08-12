import { afterEach, describe, expect, it } from "vitest";
import {
  OUTCOMES,
  SIZE_BUCKETS,
  weekKeyFor,
  weekWindowFromKey,
  type IngestPayload,
} from "@ao-wrapped/shared";
import { InMemoryIngestStore, setIngestStore } from "../../db/store.ts";
import {
  formatFreshness,
  getBoard,
  previousSeasonKey,
  rankSnapshots,
  seasonLabel,
  type Board,
} from "./board-data.ts";

/**
 * Rows reach the board the only way they reach production: through
 * `saveSnapshot`, which derives the season from the window. Nothing here writes
 * a `weekKey` by hand, so a test cannot pass against a season the real ingest
 * path could never file.
 */

const NOW = new Date("2026-08-12T12:00:00.000Z"); // a Wednesday, ISO week 2026-W33
const THIS_WEEK = weekKeyFor(NOW);
const LAST_WEEK = previousSeasonKey(weekWindowFromKey(THIS_WEEK)!);

function zeroed<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

interface Counters {
  merges?: number;
  tasks?: number;
  ciRecoveries?: number;
  interventions?: number;
  peakParallelism?: number;
  harnesses?: number;
}

/** A payload whose window sits entirely inside `weekKey`, as ingest requires. */
function payload(handle: string, weekKey: string, counters: Counters = {}): IngestPayload {
  const week = weekWindowFromKey(weekKey);
  if (week === null) throw new Error(`test fixture used a key with no week: ${weekKey}`);

  return {
    schema: 1,
    handle,
    aoVersion: "0.12.3",
    collectorVersion: "0.1.0",
    window: { from: week.from, to: week.to },
    totals: {
      tasks: counters.tasks ?? 0,
      merges: counters.merges ?? 0,
      ciRecoveries: counters.ciRecoveries ?? 0,
      interventions: counters.interventions ?? 0,
      peakParallelism: counters.peakParallelism ?? 0,
      harnesses: counters.harnesses ?? 0,
      turns: 0,
      repos: 0,
    },
    outcomes: zeroed(OUTCOMES),
    sizeMix: zeroed(SIZE_BUCKETS),
    topRepoShare: 0,
    agents: [],
    graveyard: [],
  };
}

/** Publishes each builder into a season and installs the store the board reads. */
async function seed(
  entries: Array<{ handle: string; weekKey?: string; publishedAt?: Date } & Counters>,
): Promise<InMemoryIngestStore> {
  const store = new InMemoryIngestStore();
  for (const { handle, weekKey = THIS_WEEK, publishedAt, ...counters } of entries) {
    const builder = store.addBuilder({ handle });
    const stored = await store.saveSnapshot(builder.id, payload(handle, weekKey, counters));
    // `receivedAt` is the store's own clock. Freshness is a column on this
    // board, so the tests need to place a publish in time; the row is the same
    // object the store handed back.
    if (publishedAt) stored.snapshot.receivedAt = publishedAt;
  }
  setIngestStore(store);
  return store;
}

async function board(weekKey?: string): Promise<Board> {
  const result = await getBoard(weekKey, NOW);
  if (result === null) throw new Error("expected a board");
  return result;
}

afterEach(() => {
  setIngestStore(null);
});

describe("ranking", () => {
  it("ranks on merges, descending", async () => {
    await seed([
      { handle: "ada", merges: 3, tasks: 9 },
      { handle: "grace", merges: 11, tasks: 20 },
      { handle: "linus", merges: 7, tasks: 12 },
    ]);
    const { rows } = await board();
    expect(rows.map((row) => row.handle)).toEqual(["grace", "linus", "ada"]);
    expect(rows.map((row) => row.rank)).toEqual([1, 2, 3]);
  });

  it("breaks a merge tie toward fewer interventions", async () => {
    await seed([
      { handle: "ada", merges: 6, interventions: 14 },
      { handle: "grace", merges: 6, interventions: 2 },
    ]);
    const { rows } = await board();
    expect(rows.map((row) => row.handle)).toEqual(["grace", "ada"]);
  });

  it("breaks a full tie on handle, so a season reads the same twice", async () => {
    await seed([
      { handle: "zoe", merges: 4, interventions: 1 },
      { handle: "ada", merges: 4, interventions: 1 },
    ]);
    const { rows } = await board();
    expect(rows.map((row) => row.handle)).toEqual(["ada", "zoe"]);
  });

  it("does not depend on the order the store returns rows in", () => {
    const rows = [
      { handle: "ada", merges: 5, interventions: 3 },
      { handle: "grace", merges: 9, interventions: 8 },
      { handle: "linus", merges: 5, interventions: 1 },
    ].map((row, index) => ({
      builder: {
        id: `builder-${index}`,
        handle: row.handle,
        githubId: null,
        avatarUrl: null,
        connectedAt: NOW,
        verified: false,
      },
      snapshot: {
        merges: row.merges,
        interventions: row.interventions,
        receivedAt: NOW,
      },
      agents: [],
    })) as unknown as Parameters<typeof rankSnapshots>[0];

    const forwards = rankSnapshots(rows).map((row) => row.handle);
    const backwards = rankSnapshots([...rows].reverse()).map((row) => row.handle);
    expect(forwards).toEqual(["grace", "linus", "ada"]);
    expect(backwards).toEqual(forwards);
  });

  it("carries every column the row is ranked and read by", async () => {
    await seed([
      {
        handle: "ada",
        merges: 6,
        tasks: 10,
        ciRecoveries: 2,
        interventions: 12,
        peakParallelism: 5,
        harnesses: 1,
        publishedAt: new Date(NOW.getTime() - 3 * 60_000),
      },
    ]);
    const [row] = (await board()).rows;
    expect(row).toMatchObject({
      rank: 1,
      handle: "ada",
      merges: 6,
      tasks: 10,
      ciRecoveries: 2,
      interventions: 12,
      peakParallelism: 5,
      harnesses: 1,
    });
    expect(formatFreshness(row!.publishedAt, NOW)).toBe("3m ago");
  });
});

describe("seasons", () => {
  it("defaults to the week `now` falls in", async () => {
    await seed([
      { handle: "ada", weekKey: THIS_WEEK, merges: 2 },
      { handle: "grace", weekKey: LAST_WEEK, merges: 40 },
    ]);
    const current = await board();
    expect(current.week.key).toBe(THIS_WEEK);
    expect(current.live).toBe(true);
    expect(current.rows.map((row) => row.handle)).toEqual(["ada"]);
  });

  it("renders a past season from its key, untouched by later weeks", async () => {
    await seed([
      { handle: "ada", weekKey: THIS_WEEK, merges: 2 },
      { handle: "grace", weekKey: LAST_WEEK, merges: 40 },
    ]);
    const past = await board(LAST_WEEK);
    expect(past.week.key).toBe(LAST_WEEK);
    expect(past.live).toBe(false);
    expect(past.rows.map((row) => row.handle)).toEqual(["grace"]);
    expect(past.rows[0]?.merges).toBe(40);
  });

  it("names the live season and when it resets", async () => {
    await seed([{ handle: "ada", merges: 1 }]);
    expect(seasonLabel(await board())).toBe(`${THIS_WEEK} · resets Monday`);
    expect(seasonLabel(await board(LAST_WEEK))).toBe(`${LAST_WEEK} · closed`);
  });

  it("is null for a key that names no week, so the route can 404", async () => {
    await seed([{ handle: "ada", merges: 1 }]);
    expect(await getBoard("2026-W99", NOW)).toBeNull();
    expect(await getBoard("last-tuesday", NOW)).toBeNull();
    expect(await getBoard("", NOW)).toBeNull();
  });
});

describe("the empty board", () => {
  it("is an empty season rather than an error when nobody has published", async () => {
    await seed([]);
    const empty = await board();
    expect(empty.rows).toEqual([]);
    expect(empty.week.key).toBe(THIS_WEEK);
    expect(empty.live).toBe(true);
  });

  it("is empty for a real week nobody published in, not a 404", async () => {
    await seed([{ handle: "ada", weekKey: THIS_WEEK, merges: 5 }]);
    const past = await board(LAST_WEEK);
    expect(past.rows).toEqual([]);
    expect(past.live).toBe(false);
  });
});

describe("freshness", () => {
  const ago = (ms: number) => formatFreshness(new Date(NOW.getTime() - ms), NOW);

  it("reads in the coarsest unit that is still true", () => {
    expect(ago(20_000)).toBe("just now");
    expect(ago(3 * 60_000)).toBe("3m ago");
    expect(ago(5 * 3_600_000)).toBe("5h ago");
    expect(ago(30 * 3_600_000)).toBe("yesterday");
    expect(ago(3 * 86_400_000)).toBe("3d ago");
  });

  it("falls back to a date once 'ago' stops meaning anything", () => {
    expect(ago(30 * 86_400_000)).toBe("Jul 13");
  });

  it("does not print negative time when a publisher's clock runs fast", () => {
    expect(formatFreshness(new Date(NOW.getTime() + 90_000), NOW)).toBe("just now");
  });

  it("says so rather than printing NaN for an unparseable stamp", () => {
    expect(formatFreshness(new Date("nonsense"), NOW)).toBe("unknown");
  });
});
