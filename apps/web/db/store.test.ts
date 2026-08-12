import type { IngestPayload } from "@ao-wrapped/shared";
import { describe, expect, it } from "vitest";
import { InMemoryIngestStore, UnknownBuilderError } from "./store.ts";

function payload(overrides: Partial<IngestPayload> = {}): IngestPayload {
  return {
    schema: 1,
    handle: "octocat",
    aoVersion: "0.12.3",
    collectorVersion: "0.1.0",
    window: { from: "2026-08-01", to: "2026-08-12" },
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

  it("keeps one snapshot per builder per window and replaces on re-send", async () => {
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

  it("keeps a different window as a separate snapshot", async () => {
    const store = new InMemoryIngestStore();
    const builder = store.addBuilder({ handle: "octocat" });

    await store.saveSnapshot(builder.id, payload());
    await store.saveSnapshot(
      builder.id,
      payload({ window: { from: "2026-07-01", to: "2026-07-31" } }),
    );

    expect(store.snapshotsFor(builder.id)).toHaveLength(2);
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

  it("returns the newest window, not whichever payload arrived last", async () => {
    const store = new InMemoryIngestStore();
    const builder = store.addBuilder({ handle: "octocat" });

    await store.saveSnapshot(builder.id, payload());
    await store.saveSnapshot(
      builder.id,
      payload({
        window: { from: "2026-07-01", to: "2026-07-31" },
        totals: { ...payload().totals, merges: 99 },
      }),
    );

    const found = await store.latestSnapshotForHandle("octocat");
    expect(found?.snapshot.windowTo).toBe("2026-08-12");
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
