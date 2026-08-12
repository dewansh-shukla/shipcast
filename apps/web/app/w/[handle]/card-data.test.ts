import { afterEach, describe, expect, it } from "vitest";
import type { AgentStats, IngestPayload } from "@ao-wrapped/shared";
import { InMemoryIngestStore, setIngestStore } from "../../../db/store.ts";
import {
  chaosScore,
  getWrappedCard,
  graveyardByCause,
  mostChaoticAgent,
  personalitiesFor,
  topAgentByMerges,
} from "./card-data.ts";

function agent(overrides: Partial<AgentStats> & Pick<AgentStats, "harness">): AgentStats {
  return {
    tasks: 0,
    merges: 0,
    recoveries: 0,
    interventions: 0,
    died: 0,
    turns: 0,
    medianMinutes: 0,
    ...overrides,
  };
}

describe("topAgentByMerges", () => {
  it("breaks ties on tasks, then harness name, so order in is irrelevant", () => {
    const rows = [
      agent({ harness: "codex", merges: 5, tasks: 10 }),
      agent({ harness: "aider", merges: 5, tasks: 10 }),
      agent({ harness: "cursor", merges: 5, tasks: 12 }),
    ];
    expect(topAgentByMerges(rows)?.harness).toBe("cursor");
    expect(topAgentByMerges([...rows].reverse())?.harness).toBe("cursor");
  });

  it("has no winner when nothing merged", () => {
    expect(topAgentByMerges([agent({ harness: "codex", tasks: 4 })])).toBeNull();
  });
});

describe("chaos", () => {
  it("measures hand-holding per task, not raw counts", () => {
    const busy = agent({ harness: "claude-code", tasks: 100, interventions: 10, died: 5 });
    const small = agent({ harness: "cursor", tasks: 6, interventions: 4, died: 1 });
    expect(chaosScore(small)).toBeGreaterThan(chaosScore(busy));
    expect(mostChaoticAgent([busy, small])?.harness).toBe("cursor");
  });

  it("ignores agents that never needed a hand", () => {
    expect(mostChaoticAgent([agent({ harness: "codex", tasks: 9, merges: 9 })])).toBeNull();
  });
});

describe("graveyardByCause", () => {
  it("counts causes and orders them biggest first", () => {
    expect(
      graveyardByCause([
        { harness: "codex", cause: "ci_failed" },
        { harness: "cursor", cause: "merge_conflict" },
        { harness: "cursor", cause: "ci_failed" },
      ]),
    ).toEqual([
      { cause: "ci_failed", count: 2 },
      { cause: "merge_conflict", count: 1 },
    ]);
  });
});

function payload(overrides: Partial<IngestPayload> = {}): IngestPayload {
  return {
    schema: 1,
    handle: "octocat",
    aoVersion: "0.12.3",
    collectorVersion: "0.1.0",
    window: { from: "2026-07-14", to: "2026-08-12" },
    totals: {
      tasks: 9,
      merges: 5,
      ciRecoveries: 2,
      interventions: 1,
      peakParallelism: 3,
      harnesses: 2,
      turns: 120,
      repos: 2,
    },
    outcomes: { clean: 3, ci_recovered: 2, opened_unmerged: 4 },
    sizeMix: { s: 4, m: 5 },
    topRepoShare: 0.6,
    agents: [
      agent({ harness: "codex", tasks: 3, merges: 1, died: 1, turns: 40, medianMinutes: 8 }),
      agent({
        harness: "claude-code",
        tasks: 6,
        merges: 4,
        recoveries: 2,
        interventions: 1,
        turns: 80,
        medianMinutes: 11,
        inputTokens: 900,
        outputTokens: 120,
        cacheReadTokens: 4_000,
      }),
    ],
    graveyard: [{ harness: "codex", cause: "ci_failed" }],
    ...overrides,
  };
}

/** Seed the store the way a real publish would: a builder, then a payload. */
async function publish(handle: string, overrides: Partial<IngestPayload> = {}) {
  const store = new InMemoryIngestStore();
  const builder = store.addBuilder({ handle });
  await store.saveSnapshot(builder.id, payload({ handle, ...overrides }));
  setIngestStore(store);
  return { store, builder };
}

afterEach(() => {
  setIngestStore(null);
});

describe("getWrappedCard", () => {
  it("renders a published payload, counters and all", async () => {
    await publish("octocat");

    const card = await getWrappedCard("octocat");
    expect(card.state).toBe("connected");
    if (card.state !== "connected") return;

    expect(card.totals.merges).toBe(5);
    expect(card.totals.ciRecoveries).toBe(2);
    expect(card.window).toEqual({ from: "2026-07-14", to: "2026-08-12" });
    expect(card.graveyard).toEqual([{ harness: "codex", cause: "ci_failed" }]);

    /** Busiest agent first, whatever order the rows came back in. */
    expect(card.agents.map((row) => row.harness)).toEqual(["claude-code", "codex"]);

    const awards = personalitiesFor(card);
    expect(awards.find((award) => award.award === "Closer")?.harness).toBe("claude-code");
  });

  it("keeps unmetered token counters absent rather than turning them into zero", async () => {
    await publish("octocat");

    const card = await getWrappedCard("octocat");
    if (card.state !== "connected") throw new Error("expected a connected card");

    const metered = card.agents.find((row) => row.harness === "claude-code");
    const unmetered = card.agents.find((row) => row.harness === "codex");
    expect(metered?.inputTokens).toBe(900);
    expect(unmetered?.inputTokens).toBeUndefined();
  });

  it("matches handles case-insensitively and answers in the builder's own casing", async () => {
    await publish("DewanshShukla");

    const card = await getWrappedCard("dewanshshukla");
    expect(card.state).toBe("connected");
    expect(card.handle).toBe("DewanshShukla");
  });

  it("shows the newest window when a builder has published more than one", async () => {
    const { store, builder } = await publish("octocat");

    await store.saveSnapshot(
      builder.id,
      payload({
        window: { from: "2026-06-01", to: "2026-06-30" },
        totals: { ...payload().totals, merges: 99 },
      }),
    );

    const card = await getWrappedCard("octocat");
    if (card.state !== "connected") throw new Error("expected a connected card");
    expect(card.window.to).toBe("2026-08-12");
    expect(card.totals.merges).toBe(5);
  });

  it("renders the not-yet state for an unknown handle instead of 404ing", async () => {
    await publish("octocat");

    const card = await getWrappedCard("some-builder");
    expect(card.state).toBe("not_connected");
    expect(card.handle).toBe("some-builder");
    /** No counters exist for an unpublished handle, so the card carries none. */
    expect(Object.keys(card)).toEqual(["state", "handle", "window"]);
  });

  it("is not connected when the store is empty", async () => {
    setIngestStore(new InMemoryIngestStore());
    expect((await getWrappedCard("octocat")).state).toBe("not_connected");
  });
});
