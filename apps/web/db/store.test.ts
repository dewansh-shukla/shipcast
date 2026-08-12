import type { IngestPayload } from "@ao-wrapped/shared";
import { describe, expect, it } from "vitest";
import { InMemoryIngestStore, UnknownBuilderError, weekKeyForWindow } from "./store.ts";

function payload(overrides: Partial<IngestPayload> = {}): IngestPayload {
  return {
    schema: 1,
    handle: "octocat",
    aoVersion: "0.12.3",
    collectorVersion: "0.1.0",
    /** 2026-W33: Monday the 10th to Sunday the 16th. */
    window: { from: "2026-08-10", to: "2026-08-16" },
    totals: {
      tasks: 3,
      merges: 2,
      ciRecoveries: 1,
      interventions: 0,
      peakParallelism: 2,
      harnesses: 1,
      turns: 40,
      repos: 1,
    },
    outcomes: { clean: 1, ci_recovered: 1, opened_unmerged: 1 },
    sizeMix: { m: 3 },
    topRepoShare: 1,
    agents: [
      {
        harness: "claude-code",
        tasks: 3,
        merges: 2,
        recoveries: 1,
        interventions: 0,
        died: 0,
        turns: 40,
        medianMinutes: 6.25,
      },
    ],
    graveyard: [],
    ...overrides,
  };
}

describe("InMemoryIngestStore", () => {
  it("resolves a token to the builder it was issued to", async () => {
    const store = new InMemoryIngestStore();
    const builder = store.addBuilder({ handle: "octocat" });
    store.issueToken(builder.id, "token-a");

    await expect(store.builderForToken("token-a")).resolves.toMatchObject({ handle: "octocat" });
    await expect(store.builderForToken("token-b")).resolves.toBeNull();
  });

  it("keeps every payload counter and adds none of its own", async () => {
    const store = new InMemoryIngestStore();
    const builder = store.addBuilder({ handle: "octocat" });

    const { snapshot, agents } = await store.saveSnapshot(builder.id, payload());

    expect(snapshot.payloadVersion).toBe(1);
    expect(snapshot.ciRecoveries).toBe(1);
    expect(snapshot.outcomes).toEqual({ clean: 1, ci_recovered: 1, opened_unmerged: 1 });
    expect(snapshot.sizeMix).toEqual({ m: 3 });
    expect(snapshot.graveyard).toEqual([]);
    expect(agents[0]!.medianMinutes).toBeCloseTo(6.25);
    expect(agents[0]!.cacheReadTokens).toBeNull();
  });

  it("keeps one snapshot per builder per season and replaces on re-send", async () => {
    const store = new InMemoryIngestStore();
    const builder = store.addBuilder({ handle: "octocat" });

    const first = await store.saveSnapshot(builder.id, payload());
    expect(first.replaced).toBe(false);

    const second = await store.saveSnapshot(
      builder.id,
      payload({ totals: { ...payload().totals, merges: 7 } }),
    );

    expect(second.replaced).toBe(true);
    expect(second.snapshot.id).toBe(first.snapshot.id);
    expect(store.snapshotsFor(builder.id)).toHaveLength(1);
    expect(store.snapshotsFor(builder.id)[0]!.snapshot.merges).toBe(7);
    expect(store.snapshotsFor(builder.id)[0]!.agents).toHaveLength(1);
  });

  it("replaces on a narrower window inside the same season", async () => {
    const store = new InMemoryIngestStore();
    const builder = store.addBuilder({ handle: "octocat" });

    await store.saveSnapshot(builder.id, payload());
    /**
     * A partial week is the same season, not a second one — otherwise a
     * collector run on Wednesday and again on Friday would rank twice.
     */
    const second = await store.saveSnapshot(
      builder.id,
      payload({ window: { from: "2026-08-10", to: "2026-08-13" } }),
    );

    expect(second.replaced).toBe(true);
    expect(store.snapshotsFor(builder.id)).toHaveLength(1);
    expect(store.snapshotsFor(builder.id)[0]!.snapshot.windowTo).toBe("2026-08-13");
  });

  it("keeps a different season as a separate snapshot", async () => {
    const store = new InMemoryIngestStore();
    const builder = store.addBuilder({ handle: "octocat" });

    await store.saveSnapshot(builder.id, payload());
    await store.saveSnapshot(
      builder.id,
      payload({ window: { from: "2026-08-17", to: "2026-08-23" } }),
    );

    expect(store.snapshotsFor(builder.id).map((row) => row.snapshot.weekKey)).toEqual([
      "2026-W34",
      "2026-W33",
    ]);
  });

  it("finds the latest snapshot by handle, case-insensitively", async () => {
    const store = new InMemoryIngestStore();
    const builder = store.addBuilder({ handle: "OctoCat" });
    await store.saveSnapshot(builder.id, payload());

    const found = await store.latestSnapshotForHandle("octocat");
    expect(found?.builder.id).toBe(builder.id);
    expect(found?.snapshot.merges).toBe(2);
    expect(found?.agents).toHaveLength(1);
  });

  it("returns the newest season, not whichever payload arrived last", async () => {
    const store = new InMemoryIngestStore();
    const builder = store.addBuilder({ handle: "octocat" });

    await store.saveSnapshot(builder.id, payload());
    await store.saveSnapshot(
      builder.id,
      payload({
        window: { from: "2026-07-27", to: "2026-08-02" },
        totals: { ...payload().totals, merges: 99 },
      }),
    );

    const found = await store.latestSnapshotForHandle("octocat");
    expect(found?.snapshot.weekKey).toBe("2026-W33");
    expect(found?.snapshot.merges).toBe(2);
  });

  it("has nothing for a handle nobody published under", async () => {
    const store = new InMemoryIngestStore();
    store.addBuilder({ handle: "octocat" });

    /** A claimed handle that never published is as absent as an unknown one. */
    await expect(store.latestSnapshotForHandle("octocat")).resolves.toBeNull();
    await expect(store.latestSnapshotForHandle("nobody")).resolves.toBeNull();
  });

  it("refuses to save against a builder that does not exist", async () => {
    const store = new InMemoryIngestStore();

    await expect(store.saveSnapshot("builder-9999", payload())).rejects.toBeInstanceOf(
      UnknownBuilderError,
    );
  });
});

/**
 * The Monday rollover, specifically. Everything about a weekly season turns on
 * where the boundary falls, and an off-by-one day here is a silently merged
 * season — two builders' weeks collapsing into one row, with no error anywhere.
 *
 * 2026-08-10 is a Monday, so 2026-W33 runs to Sunday 2026-08-16 and 2026-W34
 * opens on 2026-08-17.
 */
describe("weekKeyForWindow", () => {
  it("keys a full Monday-to-Sunday week", () => {
    expect(weekKeyForWindow({ from: "2026-08-10", to: "2026-08-16" })).toBe("2026-W33");
  });

  it("keys the Monday itself and the Sunday itself into the same week", () => {
    expect(weekKeyForWindow({ from: "2026-08-10", to: "2026-08-10" })).toBe("2026-W33");
    expect(weekKeyForWindow({ from: "2026-08-16", to: "2026-08-16" })).toBe("2026-W33");
  });

  it("puts the day after Sunday in the next season, not the current one", () => {
    expect(weekKeyForWindow({ from: "2026-08-17", to: "2026-08-17" })).toBe("2026-W34");
  });

  it("puts the day before Monday in the previous season", () => {
    expect(weekKeyForWindow({ from: "2026-08-09", to: "2026-08-09" })).toBe("2026-W32");
  });

  it("refuses a window that crosses the Monday by a single day", () => {
    expect(weekKeyForWindow({ from: "2026-08-10", to: "2026-08-17" })).toBeNull();
    expect(weekKeyForWindow({ from: "2026-08-09", to: "2026-08-10" })).toBeNull();
  });

  it("refuses a window spanning several weeks", () => {
    expect(weekKeyForWindow({ from: "2026-08-01", to: "2026-08-12" })).toBeNull();
  });

  it("carries a new-year week into the year its Thursday belongs to", () => {
    /** 2027-01-01 is a Friday, so its week opened on 2026-12-28. */
    expect(weekKeyForWindow({ from: "2026-12-28", to: "2027-01-03" })).toBe("2026-W53");
    expect(weekKeyForWindow({ from: "2027-01-04", to: "2027-01-10" })).toBe("2027-W01");
  });

  it("has no season for a window that is not dates", () => {
    expect(weekKeyForWindow({ from: "not-a-date", to: "2026-08-16" })).toBeNull();
  });
});

describe("seasons in the store", () => {
  /** Publish `handle` into the week `from` opens, with `merges` merges. */
  async function publish(store: InMemoryIngestStore, builderId: string, from: string, to: string) {
    return store.saveSnapshot(builderId, payload({ window: { from, to } }));
  }

  it("replaces inside a week and opens a new row across the rollover", async () => {
    const store = new InMemoryIngestStore();
    const builder = store.addBuilder({ handle: "octocat" });

    /** Wednesday, then Friday of the same week: one season, replaced. */
    const wednesday = await publish(store, builder.id, "2026-08-10", "2026-08-12");
    const friday = await publish(store, builder.id, "2026-08-10", "2026-08-14");
    expect(friday.replaced).toBe(true);
    expect(friday.snapshot.id).toBe(wednesday.snapshot.id);

    /** The Monday after: a new season, and the old row is still there. */
    const monday = await publish(store, builder.id, "2026-08-17", "2026-08-17");
    expect(monday.replaced).toBe(false);
    expect(monday.snapshot.id).not.toBe(wednesday.snapshot.id);
    expect(monday.snapshot.weekKey).toBe("2026-W34");

    expect(store.snapshotsFor(builder.id).map((row) => row.snapshot.weekKey)).toEqual([
      "2026-W34",
      "2026-W33",
    ]);
  });

  it("reads a past season back after the board has moved on", async () => {
    const store = new InMemoryIngestStore();
    const builder = store.addBuilder({ handle: "octocat" });

    await store.saveSnapshot(
      builder.id,
      payload({
        window: { from: "2026-08-10", to: "2026-08-16" },
        totals: { ...payload().totals, merges: 2 },
      }),
    );
    await store.saveSnapshot(
      builder.id,
      payload({
        window: { from: "2026-08-17", to: "2026-08-23" },
        totals: { ...payload().totals, merges: 40 },
      }),
    );

    /** No key: the newest season, which is what `/board` and the card show. */
    await expect(store.latestSnapshotForHandle("octocat")).resolves.toMatchObject({
      snapshot: { weekKey: "2026-W34", merges: 40 },
    });

    /** A past key: the closed season, unchanged by everything published since. */
    await expect(store.latestSnapshotForHandle("octocat", "2026-W33")).resolves.toMatchObject({
      snapshot: { weekKey: "2026-W33", merges: 2 },
    });
  });

  it("has nothing for a season a builder sat out", async () => {
    const store = new InMemoryIngestStore();
    const builder = store.addBuilder({ handle: "octocat" });
    await store.saveSnapshot(builder.id, payload());

    /** Absent from one week is not absent from the board. */
    await expect(store.latestSnapshotForHandle("octocat", "2026-W32")).resolves.toBeNull();
    await expect(store.latestSnapshotForHandle("octocat", "2026-W33")).resolves.not.toBeNull();
  });

  it("returns one season's builders and leaves the other season's out", async () => {
    const store = new InMemoryIngestStore();
    const octocat = store.addBuilder({ handle: "octocat" });
    const hubot = store.addBuilder({ handle: "hubot" });

    await publish(store, octocat.id, "2026-08-10", "2026-08-16");
    await publish(store, hubot.id, "2026-08-10", "2026-08-16");
    await publish(store, hubot.id, "2026-08-17", "2026-08-23");

    const current = await store.snapshotsForWeek("2026-W34");
    expect(current.map((row) => row.builder.handle)).toEqual(["hubot"]);

    const past = await store.snapshotsForWeek("2026-W33");
    expect(past.map((row) => row.builder.handle)).toEqual(["hubot", "octocat"]);
    expect(past[0]!.agents).toHaveLength(1);
  });

  it("is an empty season, not an error, when nobody published that week", async () => {
    const store = new InMemoryIngestStore();
    const builder = store.addBuilder({ handle: "octocat" });
    await store.saveSnapshot(builder.id, payload());

    await expect(store.snapshotsForWeek("2026-W01")).resolves.toEqual([]);
  });
});
